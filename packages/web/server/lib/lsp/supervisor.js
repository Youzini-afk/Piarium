import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createJsonRpcClient } from './jsonrpc.js';

const sessionKey = (workspaceId, languageId) => `${workspaceId}\0${languageId}`;

const ownerScopeKey = (owner) => owner
  ? `${owner.extensionId}\0${owner.entrypointId}`
  : 'piarium.host';
const exactOwnerKey = (owner) => owner
  ? `${ownerScopeKey(owner)}\0${owner.generation}`
  : 'piarium.host\0host';

const toFileUri = (absolutePath) => pathToFileURL(absolutePath).href;

const offsetToPosition = (text, offset) => {
  const clamped = Math.max(0, Math.min(offset, text.length));
  const prefix = text.slice(0, clamped);
  const lines = prefix.split('\n');
  return { line: Math.max(0, lines.length - 1), character: lines[lines.length - 1]?.length ?? 0 };
};

const rangeFromOffsets = (text, from, to) => ({
  start: offsetToPosition(text, from),
  end: offsetToPosition(text, to),
});

const lspSeverity = (value) => {
  if (value === 1) return 'error';
  if (value === 2) return 'warning';
  if (value === 4) return 'hint';
  return 'info';
};

const locationFromLsp = (value, workspaceId, root, pathModule) => {
  const uri = typeof value?.uri === 'string' ? value.uri : typeof value?.targetUri === 'string' ? value.targetUri : '';
  const range = value?.range ?? value?.targetRange ?? value?.targetSelectionRange;
  if (!uri || !range) return null;
  let absolutePath;
  try {
    absolutePath = fileURLToPath(uri);
  } catch {
    return null;
  }
  const relative = pathModule.relative(root, absolutePath);
  if (!relative || relative.startsWith('..') || pathModule.isAbsolute(relative)) return null;
  return {
    resource: { workspaceId, resourceId: relative.split(pathModule.sep).join('/') },
    range,
  };
};

const symbolKindName = (kind) => {
  switch (kind) {
    case 5: return 'class';
    case 6: return 'method';
    case 12: return 'function';
    case 13: return 'variable';
    case 14: return 'constant';
    default: return 'symbol';
  }
};

export const createLanguageSupervisor = ({
  documents,
  spawn,
  pathModule = path,
  env = process.env,
  isTrusted = async () => false,
}) => {
  const providers = [];
  const sessions = new Map();
  const generations = new Map();
  const workspaceListeners = new Map();
  const nextGeneration = (key, existing) => {
    const next = (existing?.generation ?? generations.get(key) ?? 0) + 1;
    generations.set(key, next);
    return next;
  };

  const emit = (workspaceId, event) => {
    const listeners = workspaceListeners.get(workspaceId);
    if (!listeners) return;
    for (const listener of listeners) listener(event);
  };

  const findProvider = (workspaceId, languageId) => (
    providers.find((provider) => (
      provider.languageIds.includes(languageId)
      && (!provider.workspaceId || provider.workspaceId === workspaceId)
    )) ?? null
  );

  const inflight = new Map();

  const snapshotFor = (record) => {
    if (!record) return null;
    const snapshot = {
      status: record.status,
      workspaceId: record.workspaceId,
      languageId: record.languageId,
    };
    if (record.providerId) snapshot.providerId = record.providerId;
    if (typeof record.generation === 'number') snapshot.generation = record.generation;
    if (record.message) snapshot.message = record.message;
    return snapshot;
  };

  const getStatus = (workspaceId, languageId) => {
    const existing = sessions.get(sessionKey(workspaceId, languageId));
    if (existing) return snapshotFor(existing);
    return { status: 'absent', workspaceId, languageId };
  };

  const waitForChildExit = (child) => new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode) {
      resolve();
      return;
    }
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, 3000);
    child.once('exit', finish);
    child.once('close', finish);
  });

  const pendingExits = new Set();

  const disposeRecord = (record, reason = 'Language server stopped') => {
    if (!record) return;
    record.rpc?.rejectAll(new Error(reason));
    record.rpc?.dispose();
    record.rpc = null;
    const child = record.child;
    try {
      child?.kill();
    } catch {
      // Process may already have exited.
    }
    if (child) {
      const exited = waitForChildExit(child).finally(() => pendingExits.delete(exited));
      pendingExits.add(exited);
    }
    record.child = null;
    record.documents.clear();
  };

  const setFailed = (record, message) => {
    record.status = 'failed';
    record.message = message;
    emit(record.workspaceId, { kind: 'status', snapshot: snapshotFor(record) });
  };

  const ensureSession = async (workspaceId, languageId) => {
    const key = sessionKey(workspaceId, languageId);
    if (inflight.has(key)) return inflight.get(key);
    const existing = sessions.get(key);
    if (existing && (existing.status === 'ready' || existing.status === 'degraded')) {
      return existing;
    }
    const provider = findProvider(workspaceId, languageId);
    if (!provider) return null;
    if (existing) disposeRecord(existing);
    const run = startSession(workspaceId, languageId, provider, existing);
    inflight.set(key, run);
    try {
      return await run;
    } finally {
      inflight.delete(key);
    }
  };

  const startSession = async (workspaceId, languageId, provider, existing) => {
    const key = sessionKey(workspaceId, languageId);

    let workspace;
    try {
      workspace = await documents.inspectWorkspace(workspaceId);
    } catch (error) {
      const failed = {
        workspaceId,
        languageId,
        providerId: provider.providerId,
        providerOwnerKey: provider.ownerKey,
        generation: nextGeneration(key, existing),
        status: 'failed',
        message: error instanceof Error ? error.message : 'Workspace is unavailable',
        documents: new Map(),
        child: null,
        rpc: null,
        root: '',
      };
      sessions.set(key, failed);
      emit(workspaceId, { kind: 'status', snapshot: snapshotFor(failed) });
      return failed;
    }

    if (provider.source === 'workspace' && !await isTrusted(workspace.root)) {
      const failed = {
        workspaceId,
        languageId,
        providerId: provider.providerId,
        providerOwnerKey: provider.ownerKey,
        generation: nextGeneration(key, existing),
        status: 'failed',
        message: 'Untrusted workspace cannot execute project-provided language server commands',
        documents: new Map(),
        child: null,
        rpc: null,
        root: workspace.root,
      };
      sessions.set(key, failed);
      emit(workspaceId, { kind: 'status', snapshot: snapshotFor(failed) });
      return failed;
    }

    const record = {
      workspaceId,
      languageId,
      providerId: provider.providerId,
      providerOwnerKey: provider.ownerKey,
      generation: nextGeneration(key, existing),
      status: 'starting',
      message: '',
      documents: new Map(),
      child: null,
      rpc: null,
      root: workspace.root,
    };
    sessions.set(key, record);
    emit(workspaceId, { kind: 'status', snapshot: snapshotFor(record) });

    let child;
    try {
      child = spawn(provider.command, provider.args ?? [], {
        cwd: workspace.root,
        env: { ...env, ...provider.env },
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      setFailed(record, error instanceof Error ? error.message : 'Failed to start language server');
      return record;
    }
    record.child = child;
    const rpc = createJsonRpcClient({ input: child.stdout, output: child.stdin });
    record.rpc = rpc;
    rpc.onNotification((method, params) => {
      if (sessions.get(key) !== record || record.rpc !== rpc) return;
      if (method !== 'textDocument/publishDiagnostics') return;
      const uri = typeof params?.uri === 'string' ? params.uri : '';
      let absolutePath;
      try {
        absolutePath = fileURLToPath(uri);
      } catch {
        return;
      }
      const relative = pathModule.relative(record.root, absolutePath);
      if (!relative || relative.startsWith('..') || pathModule.isAbsolute(relative)) return;
      const resourceId = relative.split(pathModule.sep).join('/');
      const open = record.documents.get(resourceId);
      const documentVersion = Number.isFinite(params?.version) ? params.version : open?.documentVersion;
      if (open && Number.isFinite(documentVersion) && documentVersion !== open.documentVersion) return;
      const items = Array.isArray(params?.diagnostics) ? params.diagnostics.map((diagnostic) => {
        const item = {
          resource: { workspaceId, resourceId },
          documentVersion: Number.isFinite(documentVersion) ? documentVersion : (open?.documentVersion ?? 0),
          severity: lspSeverity(diagnostic.severity),
          message: typeof diagnostic.message === 'string' ? diagnostic.message : 'Diagnostic',
          range: diagnostic.range ?? { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
        };
        return item;
      }) : [];
      emit(workspaceId, {
        kind: 'diagnostics',
        workspaceId,
        languageId,
        resourceId,
        providerId: record.providerId,
        generation: record.generation,
        items,
      });
    });
    child.stderr.on('data', () => {
      // stderr may contain paths; never log language-server payloads.
    });
    child.on('exit', (code) => {
      if (record.child !== child) return;
      rpc.rejectAll(new Error('Language server exited'));
      if (record.status === 'starting' || record.status === 'ready' || record.status === 'degraded') {
        setFailed(record, `Language server exited${code === null ? '' : ` with code ${code}`}`);
      }
      record.child = null;
      record.rpc = null;
    });

    try {
      await rpc.request('initialize', {
        processId: null,
        rootUri: toFileUri(workspace.root),
        capabilities: {
          textDocument: {
            synchronization: { dynamicRegistration: false },
            completion: { completionItem: { snippetSupport: false } },
            hover: {},
            definition: {},
            references: {},
            rename: {},
            codeAction: {},
            documentSymbol: {},
            publishDiagnostics: { relatedInformation: false },
          },
          workspace: { symbol: {} },
        },
        workspaceFolders: [{ uri: toFileUri(workspace.root), name: pathModule.basename(workspace.root) }],
      });
      rpc.notify('initialized', {});
      if (sessions.get(key) !== record || !providers.includes(provider)) {
        disposeRecord(record, 'Language provider changed during startup');
        if (sessions.get(key) === record) sessions.delete(key);
        return record;
      }
      record.status = 'ready';
      record.message = '';
      emit(workspaceId, { kind: 'status', snapshot: snapshotFor(record) });
    } catch (error) {
      setFailed(record, error instanceof Error ? error.message : 'Language server initialize failed');
    }
    return record;
  };

  const syncDocument = async (request) => {
    const languageId = request.languageId;
    const workspaceId = request.resource?.workspaceId;
    const resourceId = request.resource?.resourceId;
    if (!workspaceId || !resourceId || !languageId) {
      return { status: 'failed', message: 'Document identity is required' };
    }
    const record = await ensureSession(workspaceId, languageId);
    if (!record || record.status === 'absent') return { status: 'absent' };
    if (record.status === 'failed' || !record.rpc) {
      return { status: 'failed', message: record.message || 'Language server is unavailable' };
    }
    if (record.status === 'starting') {
      return { status: 'failed', message: 'Language server is still starting' };
    }
    let absolutePath;
    try {
      const inspected = await documents.inspectWorkspace(workspaceId);
      const resolved = pathModule.resolve(inspected.root, resourceId);
      const relative = pathModule.relative(inspected.root, resolved);
      if (!relative || relative.startsWith('..') || pathModule.isAbsolute(relative)) {
        return { status: 'failed', message: 'Path is outside workspace' };
      }
      absolutePath = resolved;
    } catch (error) {
      return { status: 'failed', message: error instanceof Error ? error.message : 'Workspace is unavailable' };
    }
    const uri = toFileUri(absolutePath);
    const open = record.documents.get(resourceId);
    if (request.reason === 'close') {
      record.documents.delete(resourceId);
      record.rpc.notify('textDocument/didClose', { textDocument: { uri } });
      return { status: 'synced', documentVersion: request.documentVersion };
    }
    if (open && request.documentVersion < open.documentVersion) {
      return { status: 'stale', documentVersion: open.documentVersion };
    }
    if (!open || request.reason === 'open') {
      record.documents.set(resourceId, {
        documentVersion: request.documentVersion,
        content: request.content ?? open?.content ?? '',
      });
      record.rpc.notify('textDocument/didOpen', {
        textDocument: {
          uri,
          languageId,
          version: request.documentVersion,
          text: request.content ?? '',
        },
      });
      return { status: 'synced', documentVersion: request.documentVersion };
    }
    const nextContent = request.content
      ?? (Array.isArray(request.changes) && open.content !== undefined
        ? request.changes.reduce((text, change) => `${text.slice(0, change.from)}${change.insert}${text.slice(change.to)}`, open.content)
        : open.content);
    record.documents.set(resourceId, { documentVersion: request.documentVersion, content: nextContent ?? '' });
    if (request.reason === 'save') {
      record.rpc.notify('textDocument/didSave', { textDocument: { uri } });
      return { status: 'synced', documentVersion: request.documentVersion };
    }
    const contentChanges = Array.isArray(request.changes) && request.changes.length > 0 && open.content
      ? request.changes.map((change) => ({
          range: rangeFromOffsets(open.content, change.from, change.to),
          text: change.insert,
        }))
      : [{ text: nextContent ?? '' }];
    record.rpc.notify('textDocument/didChange', {
      textDocument: { uri, version: request.documentVersion },
      contentChanges,
    });
    return { status: 'synced', documentVersion: request.documentVersion };
  };

  const requestFeature = async (method, request, mapResult) => {
    const languageId = request.languageId;
    const workspaceId = request.resource?.workspaceId;
    const resourceId = request.resource?.resourceId;
    if (!workspaceId || !languageId) return { status: 'absent' };
    const record = await ensureSession(workspaceId, languageId);
    if (!record || !findProvider(workspaceId, languageId)) {
      if (!findProvider(workspaceId, languageId)) return { status: 'absent' };
    }
    if (!record || record.status === 'failed' || !record.rpc) {
      return { status: 'failed', message: record?.message || 'Language server is unavailable' };
    }
    const open = resourceId ? record.documents.get(resourceId) : null;
    if (open && Number.isFinite(request.documentVersion) && request.documentVersion !== open.documentVersion) {
      return { status: 'stale', documentVersion: open.documentVersion };
    }
    let uri;
    if (resourceId) {
      const inspected = await documents.inspectWorkspace(workspaceId);
      uri = toFileUri(pathModule.resolve(inspected.root, resourceId));
    }
    const params = method === 'workspace/symbol'
      ? { query: request.query ?? '' }
      : {
          ...(uri ? { textDocument: { uri } } : {}),
          ...(request.position ? { position: request.position } : {}),
          ...(request.range ? { range: request.range } : {}),
          ...(method === 'textDocument/references' ? { context: { includeDeclaration: true } } : {}),
          ...(request.newName ? { newName: request.newName } : {}),
        };
    try {
      const raw = await record.rpc.request(method, params);
      if (sessions.get(sessionKey(workspaceId, languageId)) !== record) {
        return { status: 'stale', documentVersion: open?.documentVersion ?? request.documentVersion ?? 0 };
      }
      if (open && request.documentVersion !== open.documentVersion) {
        return { status: 'stale', documentVersion: open.documentVersion };
      }
      return { status: 'ready', documentVersion: request.documentVersion ?? open?.documentVersion ?? 0, value: mapResult(raw, record) };
    } catch (error) {
      if (record.rpc && (record.status === 'ready' || record.status === 'degraded')) {
        record.status = 'degraded';
        record.message = error instanceof Error ? error.message : 'Language request failed';
        emit(record.workspaceId, { kind: 'status', snapshot: snapshotFor(record) });
      }
      return { status: 'failed', message: error instanceof Error ? error.message : 'Language request failed' };
    }
  };

  return {
    registerProvider(descriptor, owner) {
      const languageIds = Array.isArray(descriptor?.languageIds)
        ? descriptor.languageIds.filter((id) => typeof id === 'string' && id)
        : [];
      if (!descriptor?.providerId || !descriptor.command || languageIds.length === 0) {
        throw new Error('Language provider requires providerId, command, and languageIds');
      }
      const next = {
        providerId: descriptor.providerId,
        command: descriptor.command,
        args: Array.isArray(descriptor.args) ? descriptor.args : [],
        languageIds,
        source: owner
          ? 'extension'
          : (descriptor.source === 'workspace' || descriptor.source === 'extension' || descriptor.source === 'builtin'
            ? descriptor.source
            : 'host'),
        ownerScopeKey: ownerScopeKey(owner),
        ownerKey: exactOwnerKey(owner),
      };
      if (typeof descriptor.workspaceId === 'string' && descriptor.workspaceId) {
        next.workspaceId = descriptor.workspaceId;
      }
      if (descriptor.env && typeof descriptor.env === 'object') next.env = descriptor.env;
      const existingIndex = providers.findIndex((provider) => provider.providerId === next.providerId);
      const existing = existingIndex >= 0 ? providers[existingIndex] : null;
      if (existing && existing.ownerScopeKey !== next.ownerScopeKey) {
        throw new Error(`Language provider ID is already owned: ${next.providerId}`);
      }
      if (existingIndex >= 0) providers.splice(existingIndex, 1, next);
      else providers.push(next);
      if (existing) {
        for (const [key, record] of sessions) {
          if (record.providerId !== existing.providerId) continue;
          disposeRecord(record, 'Language provider updated');
          sessions.delete(key);
          inflight.delete(key);
        }
      }
      return next;
    },
    async unregisterProvider(providerId, owner) {
      const index = providers.findIndex((provider) => (
        provider.providerId === providerId
        && provider.ownerKey === exactOwnerKey(owner)
      ));
      if (index < 0) return { status: 'not-owned', providerId };
      const [removed] = providers.splice(index, 1);
      for (const [key, record] of sessions) {
        if (record.providerId !== removed.providerId) continue;
        disposeRecord(record, 'Language provider disabled');
        sessions.delete(key);
        inflight.delete(key);
      }
      await Promise.all([...pendingExits]);
      return { status: 'unregistered', providerId };
    },
    getStatus,
    subscribe(workspaceId, listener) {
      const listeners = workspaceListeners.get(workspaceId) ?? new Set();
      listeners.add(listener);
      workspaceListeners.set(workspaceId, listeners);
      return {
        close() {
          listeners.delete(listener);
          if (listeners.size === 0) workspaceListeners.delete(workspaceId);
        },
      };
    },
    syncDocument,
    completion: (request) => requestFeature('textDocument/completion', request, (raw) => {
      const items = Array.isArray(raw) ? raw : Array.isArray(raw?.items) ? raw.items : [];
      return items.map((item) => {
        const mapped = { label: typeof item.label === 'string' ? item.label : '' };
        if (typeof item.detail === 'string') mapped.detail = item.detail;
        if (typeof item.insertText === 'string') mapped.insertText = item.insertText;
        return mapped;
      }).filter((item) => item.label);
    }),
    hover: (request) => requestFeature('textDocument/hover', request, (raw) => {
      if (typeof raw?.contents === 'string') return raw.contents;
      if (typeof raw?.contents?.value === 'string') return raw.contents.value;
      if (Array.isArray(raw?.contents)) {
        return raw.contents.map((part) => (typeof part === 'string' ? part : part?.value)).filter(Boolean).join('\n');
      }
      return '';
    }),
    definition: (request) => requestFeature('textDocument/definition', request, (raw, record) => {
      const values = Array.isArray(raw) ? raw : raw ? [raw] : [];
      return values.map((value) => locationFromLsp(value, record.workspaceId, record.root, pathModule)).filter(Boolean);
    }),
    references: (request) => requestFeature('textDocument/references', request, (raw, record) => {
      const values = Array.isArray(raw) ? raw : [];
      return values.map((value) => locationFromLsp(value, record.workspaceId, record.root, pathModule)).filter(Boolean);
    }),
    documentSymbols: (request) => requestFeature('textDocument/documentSymbol', request, (raw) => {
      const values = Array.isArray(raw) ? raw : [];
      return values.map((value) => {
        const mapped = {
          name: typeof value.name === 'string' ? value.name : '',
          kind: symbolKindName(value.kind),
          range: value.range ?? value.location?.range ?? { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
        };
        if (value.selectionRange) mapped.selectionRange = value.selectionRange;
        return mapped;
      }).filter((item) => item.name);
    }),
    workspaceSymbols: (request) => requestFeature('workspace/symbol', request, (raw, record) => {
      const values = Array.isArray(raw) ? raw : [];
      return values.map((value) => {
        const location = locationFromLsp(value.location, record.workspaceId, record.root, pathModule);
        if (!location) return null;
        return {
          name: typeof value.name === 'string' ? value.name : '',
          kind: symbolKindName(value.kind),
          range: location.range,
        };
      }).filter((item) => item?.name);
    }),
    rename: (request) => requestFeature('textDocument/rename', request, (raw, record) => {
      const changes = raw?.changes && typeof raw.changes === 'object' ? raw.changes : {};
      const locations = [];
      for (const [uri, edits] of Object.entries(changes)) {
        for (const edit of Array.isArray(edits) ? edits : []) {
          const location = locationFromLsp({ uri, range: edit.range }, record.workspaceId, record.root, pathModule);
          if (location) locations.push(location);
        }
      }
      return locations;
    }),
    codeActions: (request) => requestFeature('textDocument/codeAction', request, (raw) => {
      const values = Array.isArray(raw) ? raw : [];
      return values.map((value) => {
        const mapped = { title: typeof value.title === 'string' ? value.title : '' };
        if (typeof value.kind === 'string') mapped.kind = value.kind;
        if (value.isPreferred === true) mapped.isPreferred = true;
        return mapped;
      }).filter((item) => item.title);
    }),
    async restart(workspaceId, languageId) {
      const key = sessionKey(workspaceId, languageId);
      const existing = sessions.get(key);
      disposeRecord(existing, 'Language server restart');
      if (existing) sessions.delete(key);
      inflight.delete(key);
      const record = await ensureSession(workspaceId, languageId);
      return snapshotFor(record) ?? { status: 'absent', workspaceId, languageId };
    },
    async disposeWorkspace(workspaceId, owner) {
      const ownerKey = owner ? exactOwnerKey(owner) : null;
      for (const [key, record] of sessions) {
        if (record.workspaceId !== workspaceId) continue;
        if (ownerKey && record.providerOwnerKey !== ownerKey) continue;
        disposeRecord(record, 'Workspace language services disposed');
        sessions.delete(key);
        inflight.delete(key);
      }
      if (!ownerKey) workspaceListeners.delete(workspaceId);
      await Promise.all([...pendingExits]);
    },
    async dispose() {
      for (const record of sessions.values()) disposeRecord(record, 'Language supervisor disposed');
      sessions.clear();
      inflight.clear();
      workspaceListeners.clear();
      providers.length = 0;
      await Promise.all([...pendingExits]);
    },
  };
};
