// @ts-nocheck
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createJsonRpcClient } from './jsonrpc.js';
import {
  LanguageMappingError,
  mapCodeAction,
  mapColorPresentation,
  mapColorInformation,
  mapCompletionItem,
  mapDiagnostic,
  mapDocumentLink,
  mapDocumentHighlight,
  mapFoldingRange,
  mapHover,
  mapInlayHint,
  mapLocation,
  mapLocationLink,
  mapSelectionRange,
  mapSignatureHelp,
  mapSymbols,
  mapTextEdits,
  mapWorkspaceEdit,
  resourceFromUri,
} from './mapping.js';

const sessionKey = (workspaceId, languageId) => `${workspaceId}\0${languageId}`;

const SEMANTIC_TOKEN_TYPES = [
  'namespace', 'type', 'class', 'enum', 'interface', 'struct', 'typeParameter', 'parameter',
  'variable', 'property', 'enumMember', 'event', 'function', 'method', 'macro', 'label',
  'comment', 'string', 'keyword', 'number', 'regexp', 'operator', 'decorator',
];
const SEMANTIC_TOKEN_MODIFIERS = [
  'declaration', 'definition', 'readonly', 'static', 'deprecated', 'abstract', 'async',
  'modification', 'documentation', 'defaultLibrary',
];
const CODE_ACTION_KINDS = [
  '', 'quickfix', 'refactor', 'refactor.extract', 'refactor.inline', 'refactor.move',
  'refactor.rewrite', 'source', 'source.organizeImports', 'source.fixAll',
];

const capabilityValue = (record, key) => record.serverCapabilities?.[key];

const supportsMethod = (record, method, request) => {
  const capability = record.serverCapabilities ?? {};
  if (method === 'workspace/executeCommand') {
    const commands = capability.executeCommandProvider?.commands;
    return typeof request?.command === 'string' && Array.isArray(commands) && commands.includes(request.command);
  }
  if (method === 'completionItem/resolve') {
    return capability.completionProvider?.resolveProvider === true;
  }
  if (method === 'codeAction/resolve') {
    return capability.codeActionProvider?.resolveProvider === true;
  }
  if (method === 'inlayHint/resolve') {
    return capability.inlayHintProvider?.resolveProvider === true;
  }
  if (method === 'documentLink/resolve') {
    return capability.documentLinkProvider?.resolveProvider === true;
  }
  if (method === 'textDocument/semanticTokens/full') {
    const provider = capability.semanticTokensProvider;
    return provider === true || provider?.full === true || typeof provider?.full === 'object';
  }
  if (method === 'textDocument/semanticTokens/range') {
    const provider = capability.semanticTokensProvider;
    return provider === true || provider?.range === true || typeof provider?.range === 'object';
  }
  const key = ({
    'textDocument/completion': 'completionProvider',
    'textDocument/hover': 'hoverProvider',
    'textDocument/signatureHelp': 'signatureHelpProvider',
    'textDocument/definition': 'definitionProvider',
    'textDocument/references': 'referencesProvider',
    'textDocument/documentSymbol': 'documentSymbolProvider',
    'workspace/symbol': 'workspaceSymbolProvider',
    'textDocument/rename': 'renameProvider',
    'textDocument/codeAction': 'codeActionProvider',
    'textDocument/formatting': 'documentFormattingProvider',
    'textDocument/rangeFormatting': 'documentRangeFormattingProvider',
    'textDocument/onTypeFormatting': 'documentOnTypeFormattingProvider',
    'textDocument/inlayHint': 'inlayHintProvider',
    'textDocument/documentHighlight': 'documentHighlightProvider',
    'textDocument/foldingRange': 'foldingRangeProvider',
    'textDocument/selectionRange': 'selectionRangeProvider',
    'textDocument/documentLink': 'documentLinkProvider',
    'textDocument/documentColor': 'colorProvider',
    'textDocument/colorPresentation': 'colorProvider',
  })[method];
  if (!key) return true;
  const value = capabilityValue(record, key);
  return value === true || typeof value === 'object';
};

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

export const createLanguageSupervisor = ({
  activateProviders = async () => {},
  documents,
  spawn,
  pathModule = path,
  env = process.env,
  isTrusted = async () => false,
}) => {
  const providers = [];
  const sessions = new Map();
  const desiredDocuments = new Map();
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
    if (record.status === 'ready' || record.status === 'degraded') {
      const completion = record.serverCapabilities?.completionProvider;
      const signature = record.serverCapabilities?.signatureHelpProvider;
      const onType = record.serverCapabilities?.documentOnTypeFormattingProvider;
      const features = {};
      if (Array.isArray(completion?.triggerCharacters)) {
        features.completionTriggerCharacters = completion.triggerCharacters.filter((value) => typeof value === 'string');
      }
      if (Array.isArray(signature?.triggerCharacters)) {
        features.signatureHelpTriggerCharacters = signature.triggerCharacters.filter((value) => typeof value === 'string');
      }
      if (Array.isArray(signature?.retriggerCharacters)) {
        features.signatureHelpRetriggerCharacters = signature.retriggerCharacters.filter((value) => typeof value === 'string');
      }
      const onTypeCharacters = [onType?.firstTriggerCharacter, ...(Array.isArray(onType?.moreTriggerCharacter) ? onType.moreTriggerCharacter : [])]
        .filter((value) => typeof value === 'string');
      if (onTypeCharacters.length > 0) features.onTypeFormattingTriggerCharacters = onTypeCharacters;
      if (Object.keys(features).length > 0) snapshot.features = features;
    }
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

  const clearRecordDiagnostics = (record) => {
    for (const [resourceId] of record.documents) {
      emit(record.workspaceId, {
        kind: 'diagnostics',
        workspaceId: record.workspaceId,
        languageId: record.languageId,
        resourceId,
        providerId: record.providerId,
        generation: record.generation,
        items: [],
      });
    }
  };

  const disposeRecord = (record, reason = 'Language server stopped') => {
    if (!record) return;
    clearRecordDiagnostics(record);
    emit(record.workspaceId, {
      kind: 'status',
      snapshot: {
        status: 'absent',
        workspaceId: record.workspaceId,
        languageId: record.languageId,
        providerId: record.providerId,
        generation: record.generation,
      },
    });
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
    record.completionResolveItems?.clear();
    record.codeActionResolveItems?.clear();
    record.inlayHintResolveItems?.clear();
    record.documentLinkResolveItems?.clear();
  };

  const setFailed = (record, message) => {
    record.status = 'failed';
    record.message = message;
    record.failureReason = record.failureReason ?? 'provider-failed';
    clearRecordDiagnostics(record);
    emit(record.workspaceId, { kind: 'status', snapshot: snapshotFor(record) });
  };

  const ensureSession = async (workspaceId, languageId) => {
    const key = sessionKey(workspaceId, languageId);
    if (inflight.has(key)) return inflight.get(key);
    const existing = sessions.get(key);
    if (existing && (existing.status === 'ready' || existing.status === 'degraded')) {
      return existing;
    }
    let provider = findProvider(workspaceId, languageId);
    if (!provider) {
      try {
        await activateProviders({ workspaceId, languageId });
      } catch (error) {
        const failed = {
          workspaceId,
          languageId,
          providerId: 'piarium.workspace-match',
          providerOwnerKey: 'piarium.host\0activation',
          generation: nextGeneration(key, existing),
          status: 'failed',
          message: error instanceof Error ? error.message : 'Language extension activation failed',
          failureReason: 'provider-failed',
          documents: new Map(),
          child: null,
          rpc: null,
          root: '',
          serverCapabilities: {},
          completionResolveItems: new Map(),
          codeActionResolveItems: new Map(),
          inlayHintResolveItems: new Map(),
          documentLinkResolveItems: new Map(),
          resolveCounter: 0,
        };
        sessions.set(key, failed);
        emit(workspaceId, { kind: 'status', snapshot: snapshotFor(failed) });
        return failed;
      }
      provider = findProvider(workspaceId, languageId);
    }
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
        failureReason: 'provider-failed',
        documents: new Map(),
        child: null,
        rpc: null,
        root: '',
        serverCapabilities: {},
        completionResolveItems: new Map(),
        codeActionResolveItems: new Map(),
        inlayHintResolveItems: new Map(),
        documentLinkResolveItems: new Map(),
        resolveCounter: 0,
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
        failureReason: 'untrusted',
        documents: new Map(),
        child: null,
        rpc: null,
        root: workspace.root,
        serverCapabilities: {},
        completionResolveItems: new Map(),
        codeActionResolveItems: new Map(),
        inlayHintResolveItems: new Map(),
        documentLinkResolveItems: new Map(),
        resolveCounter: 0,
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
      failureReason: null,
      documents: new Map(),
      child: null,
      rpc: null,
      root: workspace.root,
      serverCapabilities: {},
      completionResolveItems: new Map(),
      codeActionResolveItems: new Map(),
      inlayHintResolveItems: new Map(),
      documentLinkResolveItems: new Map(),
      resolveCounter: 0,
    };
    sessions.set(key, record);
    emit(workspaceId, { kind: 'status', snapshot: snapshotFor(record) });

    let child;
    try {
      child = spawn(provider.command, provider.args ?? [], {
        cwd: workspace.root,
        env: {
          ...env,
          ...provider.env,
          // Electron and VS Code expose their executable as process.execPath.
          // Language providers are always headless CLI processes; without Node
          // mode a provider using process.execPath launches another GUI shell.
          ELECTRON_RUN_AS_NODE: '1',
        },
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
      const resource = resourceFromUri(uri, workspaceId, record.root, pathModule);
      if (!resource) return;
      const resourceId = resource.resourceId;
      const open = record.documents.get(resourceId);
      const documentVersion = Number.isFinite(params?.version) ? params.version : open?.documentVersion;
      if (open && Number.isFinite(documentVersion) && documentVersion !== open.documentVersion) return;
      const items = Array.isArray(params?.diagnostics) ? params.diagnostics.map((diagnostic) => mapDiagnostic(diagnostic, {
        workspaceId,
        root: record.root,
        pathModule,
        resource,
        documentVersion: Number.isFinite(documentVersion) ? documentVersion : (open?.documentVersion ?? 0),
        severity: lspSeverity,
        providerId: record.providerId,
        generation: record.generation,
      })) : [];
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
      const initialized = await rpc.request('initialize', {
        processId: null,
        rootUri: toFileUri(workspace.root),
        capabilities: {
          textDocument: {
            synchronization: { dynamicRegistration: false },
            completion: {
              completionItem: {
                snippetSupport: true,
                commitCharactersSupport: true,
                deprecatedSupport: true,
                preselectSupport: true,
                documentationFormat: ['markdown', 'plaintext'],
                insertReplaceSupport: true,
                resolveSupport: {
                  properties: ['documentation', 'detail', 'additionalTextEdits', 'command'],
                },
                tagSupport: { valueSet: [1] },
              },
              contextSupport: true,
            },
            hover: { contentFormat: ['markdown', 'plaintext'] },
            signatureHelp: {
              signatureInformation: {
                documentationFormat: ['markdown', 'plaintext'],
                parameterInformation: { labelOffsetSupport: true },
                activeParameterSupport: true,
              },
              contextSupport: true,
            },
            definition: {},
            references: {},
            rename: {},
            codeAction: {
              codeActionLiteralSupport: {
                codeActionKind: { valueSet: CODE_ACTION_KINDS },
              },
              dataSupport: true,
              disabledSupport: true,
              isPreferredSupport: true,
              resolveSupport: { properties: ['edit', 'command'] },
            },
            documentSymbol: { hierarchicalDocumentSymbolSupport: true, tagSupport: { valueSet: [1] } },
            formatting: {},
            rangeFormatting: {},
            onTypeFormatting: {},
            semanticTokens: {
              requests: { range: true, full: true },
              tokenTypes: SEMANTIC_TOKEN_TYPES,
              tokenModifiers: SEMANTIC_TOKEN_MODIFIERS,
              formats: ['relative'],
              overlappingTokenSupport: false,
              multilineTokenSupport: true,
            },
            inlayHint: { dynamicRegistration: false, resolveSupport: { properties: ['tooltip', 'textEdits', 'label.tooltip', 'label.location', 'label.command'] } },
            documentHighlight: {},
            foldingRange: { lineFoldingOnly: false },
            selectionRange: {},
            documentLink: { tooltipSupport: true },
            colorProvider: {},
            publishDiagnostics: { relatedInformation: true, tagSupport: { valueSet: [1, 2] } },
          },
          workspace: {
            symbol: { resolveSupport: { properties: ['location.range'] }, tagSupport: { valueSet: [1] } },
            workspaceEdit: { documentChanges: true, changeAnnotationSupport: { groupsOnLabel: true } },
            executeCommand: { dynamicRegistration: false },
          },
        },
        workspaceFolders: [{ uri: toFileUri(workspace.root), name: pathModule.basename(workspace.root) }],
        ...(provider.initializationOptions ? { initializationOptions: provider.initializationOptions } : {}),
      });
      record.serverCapabilities = initialized?.capabilities && typeof initialized.capabilities === 'object'
        ? initialized.capabilities
        : {};
      rpc.notify('initialized', {});
      if (sessions.get(key) !== record || !providers.includes(provider)) {
        disposeRecord(record, 'Language provider changed during startup');
        if (sessions.get(key) === record) sessions.delete(key);
        return record;
      }
      const desired = desiredDocuments.get(key);
      if (desired) {
        for (const [resourceId, document] of desired) {
          const uri = toFileUri(pathModule.resolve(record.root, resourceId));
          record.documents.set(resourceId, { ...document });
          rpc.notify('textDocument/didOpen', {
            textDocument: {
              uri,
              languageId,
              version: document.documentVersion,
              text: document.content,
            },
          });
        }
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

    const key = sessionKey(workspaceId, languageId);
    const desired = desiredDocuments.get(key) ?? new Map();
    desiredDocuments.set(key, desired);
    const previousDesired = desired.get(resourceId);
    if (request.reason === 'close') {
      desired.delete(resourceId);
      if (desired.size === 0) desiredDocuments.delete(key);
      const record = sessions.get(key);
      const open = record?.documents.get(resourceId);
      if (!record || !record.rpc || !open) {
        if (record && desired.size === 0) {
          disposeRecord(record, 'Last language document closed');
          sessions.delete(key);
          inflight.delete(key);
        }
        return { status: 'absent' };
      }
      record.documents.delete(resourceId);
      record.rpc.notify('textDocument/didClose', { textDocument: { uri: toFileUri(absolutePath) } });
      const result = {
        status: 'synced',
        documentVersion: request.documentVersion,
        providerId: record.providerId,
        generation: record.generation,
      };
      if (desired.size === 0) {
        disposeRecord(record, 'Last language document closed');
        sessions.delete(key);
        inflight.delete(key);
      }
      return result;
    }
    if (previousDesired && request.documentVersion < previousDesired.documentVersion) {
      return { status: 'stale', documentVersion: previousDesired.documentVersion };
    }
    const incrementalChanges = Array.isArray(request.changes)
      ? [...request.changes].sort((left, right) => right.from - left.from || right.to - left.to)
      : [];
    const nextContent = request.content
      ?? (incrementalChanges.length > 0 && previousDesired?.content !== undefined
        ? incrementalChanges.reduce(
            (text, change) => `${text.slice(0, change.from)}${change.insert}${text.slice(change.to)}`,
            previousDesired.content,
          )
        : previousDesired?.content ?? '');
    const nextDesired = { documentVersion: request.documentVersion, content: nextContent };
    desired.set(resourceId, nextDesired);

    const record = await ensureSession(workspaceId, languageId);
    if (!record) return { status: 'absent' };
    if (record.status === 'failed' || !record.rpc) {
      return { status: 'failed', message: record.message || 'Language server is unavailable' };
    }
    if (record.status === 'starting') {
      return { status: 'failed', message: 'Language server is still starting' };
    }
    const uri = toFileUri(absolutePath);
    const open = record.documents.get(resourceId);
    if (open && request.documentVersion < open.documentVersion) {
      return { status: 'stale', documentVersion: open.documentVersion };
    }
    if (!open) {
      record.documents.set(resourceId, nextDesired);
      record.rpc.notify('textDocument/didOpen', {
        textDocument: { uri, languageId, version: request.documentVersion, text: nextContent },
      });
    } else if (open.documentVersion !== request.documentVersion || open.content !== nextContent) {
      const canUseIncremental = request.reason === 'change'
        && incrementalChanges.length > 0
        && previousDesired?.content === open.content;
      const contentChanges = canUseIncremental
        ? incrementalChanges.map((change) => ({
            range: rangeFromOffsets(open.content, change.from, change.to),
            text: change.insert,
          }))
        : [{ text: nextContent }];
      record.documents.set(resourceId, nextDesired);
      record.rpc.notify('textDocument/didChange', {
        textDocument: { uri, version: request.documentVersion },
        contentChanges,
      });
    }
    if (request.reason === 'save') {
      record.rpc.notify('textDocument/didSave', { textDocument: { uri } });
    }
    return {
      status: 'synced',
      documentVersion: request.documentVersion,
      providerId: record.providerId,
      generation: record.generation,
    };
  };

  const completionTriggerKind = (value) => {
    if (value === 'triggerCharacter') return 2;
    if (value === 'incomplete') return 3;
    return 1;
  };

  const featureParams = (method, request, uri) => {
    if (method === 'workspace/symbol') return { query: request.query ?? '' };
    if (method === 'textDocument/completion') {
      return {
        textDocument: { uri },
        position: request.position,
        context: {
          triggerKind: completionTriggerKind(request.triggerKind),
          ...(typeof request.triggerCharacter === 'string' ? { triggerCharacter: request.triggerCharacter } : {}),
        },
      };
    }
    if (method === 'textDocument/signatureHelp') {
      return {
        textDocument: { uri },
        position: request.position,
        context: {
          triggerKind: completionTriggerKind(request.triggerKind),
          isRetrigger: request.triggerKind === 'incomplete',
          ...(typeof request.triggerCharacter === 'string' ? { triggerCharacter: request.triggerCharacter } : {}),
        },
      };
    }
    if (method === 'textDocument/references') {
      return { textDocument: { uri }, position: request.position, context: { includeDeclaration: true } };
    }
    if (method === 'textDocument/codeAction') {
      return {
        textDocument: { uri },
        range: request.range,
        context: {
          diagnostics: Array.isArray(request.diagnostics) ? request.diagnostics.map((diagnostic) => ({
            range: diagnostic.range,
            message: diagnostic.message,
            ...(diagnostic.code !== undefined ? { code: diagnostic.code } : {}),
            ...(diagnostic.source ? { source: diagnostic.source } : {}),
          })) : [],
        },
      };
    }
    if (method === 'textDocument/formatting') {
      return { textDocument: { uri }, options: request.formatting ?? { tabSize: 2, insertSpaces: true } };
    }
    if (method === 'textDocument/rangeFormatting') {
      return { textDocument: { uri }, range: request.range, options: request.formatting ?? { tabSize: 2, insertSpaces: true } };
    }
    if (method === 'textDocument/onTypeFormatting') {
      return {
        textDocument: { uri },
        position: request.position,
        ch: request.triggerCharacter ?? '',
        options: request.formatting ?? { tabSize: 2, insertSpaces: true },
      };
    }
    if (method === 'textDocument/semanticTokens/full') return { textDocument: { uri } };
    if (method === 'textDocument/semanticTokens/range') return { textDocument: { uri }, range: request.range };
    if (method === 'textDocument/inlayHint') return { textDocument: { uri }, range: request.range };
    if (method === 'textDocument/selectionRange') return { textDocument: { uri }, positions: request.positions ?? [] };
    if (method === 'textDocument/colorPresentation') {
      return { textDocument: { uri }, color: request.color, range: request.range };
    }
    if (method === 'workspace/executeCommand') {
      return {
        command: request.command,
        ...(Array.isArray(request.arguments) ? { arguments: request.arguments } : {}),
      };
    }
    return {
      ...(uri ? { textDocument: { uri } } : {}),
      ...(request.position ? { position: request.position } : {}),
      ...(request.range ? { range: request.range } : {}),
      ...(request.newName ? { newName: request.newName } : {}),
    };
  };

  const featureFailure = (record, message, reason = 'request-failed') => ({
    status: 'failed',
    message,
    reason,
    ...(record?.providerId ? { providerId: record.providerId } : {}),
    ...(Number.isFinite(record?.generation) ? { generation: record.generation } : {}),
  });

  const requestFeature = async (method, request, mapResult, options = {}) => {
    const languageId = request.languageId;
    const workspaceId = request.resource?.workspaceId;
    const resourceId = request.resource?.resourceId;
    if (!workspaceId || !languageId) return { status: 'absent', ...(workspaceId ? { workspaceId } : {}), ...(languageId ? { languageId } : {}) };
    const record = await ensureSession(workspaceId, languageId);
    if (!record) return { status: 'absent', workspaceId, languageId };
    if (!findProvider(workspaceId, languageId) && record.status !== 'failed') {
      return { status: 'absent', workspaceId, languageId };
    }
    if (!record || record.status === 'failed' || !record.rpc) {
      return featureFailure(record, record?.message || 'Language server is unavailable', record?.failureReason ?? 'provider-failed');
    }
    const open = resourceId ? record.documents.get(resourceId) : null;
    if (
      (typeof request.providerId === 'string' && request.providerId !== record.providerId)
      || (Number.isFinite(request.generation) && request.generation !== record.generation)
    ) {
      return {
        status: 'stale',
        documentVersion: open?.documentVersion ?? request.documentVersion ?? 0,
        providerId: record.providerId,
        generation: record.generation,
      };
    }
    if (!supportsMethod(record, method, request)) {
      return featureFailure(record, `Language provider does not support ${method}`, 'unsupported');
    }
    if (open && Number.isFinite(request.documentVersion) && request.documentVersion !== open.documentVersion) {
      return { status: 'stale', documentVersion: open.documentVersion, providerId: record.providerId, generation: record.generation };
    }
    let uri;
    if (resourceId) {
      const inspected = await documents.inspectWorkspace(workspaceId);
      const resolved = pathModule.resolve(inspected.root, resourceId);
      const relative = pathModule.relative(inspected.root, resolved);
      if (!relative || relative.startsWith('..') || pathModule.isAbsolute(relative)) {
        return featureFailure(record, 'Path is outside workspace', 'unsupported');
      }
      uri = toFileUri(resolved);
    }
    const params = options.params ?? featureParams(method, request, uri);
    try {
      const raw = await record.rpc.request(method, params);
      if (sessions.get(sessionKey(workspaceId, languageId)) !== record) {
        return { status: 'stale', documentVersion: open?.documentVersion ?? request.documentVersion ?? 0, providerId: record.providerId, generation: record.generation };
      }
      if (open && request.documentVersion !== open.documentVersion) {
        return { status: 'stale', documentVersion: open.documentVersion, providerId: record.providerId, generation: record.generation };
      }
      return {
        status: 'ready',
        documentVersion: request.documentVersion ?? open?.documentVersion ?? 0,
        providerId: record.providerId,
        generation: record.generation,
        value: mapResult(raw, record),
      };
    } catch (error) {
      if (error instanceof LanguageMappingError) {
        return featureFailure(record, error.message, error.reason);
      }
      if (record.rpc && (record.status === 'ready' || record.status === 'degraded')) {
        record.status = 'degraded';
        record.message = error instanceof Error ? error.message : 'Language request failed';
        emit(record.workspaceId, { kind: 'status', snapshot: snapshotFor(record) });
      }
      return featureFailure(record, error instanceof Error ? error.message : 'Language request failed');
    }
  };

  const storeResolveItem = (record, collection, raw) => {
    record.resolveCounter += 1;
    const token = `${record.generation}:${record.resolveCounter}`;
    collection.set(token, raw);
    return token;
  };

  const resolveFeature = async (method, request, collectionName, mapResult) => {
    const languageId = request.languageId;
    const workspaceId = request.resource?.workspaceId;
    const record = workspaceId && languageId ? sessions.get(sessionKey(workspaceId, languageId)) : null;
    const raw = record?.[collectionName]?.get(request.resolveToken);
    if (!record || !record.rpc || !raw) {
      return record
        ? featureFailure(record, 'Language resolve item is stale', 'unsupported')
        : { status: 'absent', ...(workspaceId ? { workspaceId } : {}), ...(languageId ? { languageId } : {}) };
    }
    return requestFeature(method, request, mapResult, { params: raw });
  };

  const mappingContext = (record) => ({
    workspaceId: record.workspaceId,
    root: record.root,
    pathModule,
  });

  const codeActionMappingContext = (record, request) => ({
    ...mappingContext(record),
    diagnosticContext: {
      ...mappingContext(record),
      resource: request.resource,
      documentVersion: request.documentVersion ?? 0,
      severity: lspSeverity,
      providerId: record.providerId,
      generation: record.generation,
    },
  });

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
      if (descriptor.initializationOptions && typeof descriptor.initializationOptions === 'object' && !Array.isArray(descriptor.initializationOptions)) {
        next.initializationOptions = structuredClone(descriptor.initializationOptions);
      }
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
    completion: (request) => requestFeature('textDocument/completion', request, (raw, record) => {
      const items = Array.isArray(raw) ? raw : Array.isArray(raw?.items) ? raw.items : [];
      record.completionResolveItems.clear();
      const canResolve = record.serverCapabilities?.completionProvider?.resolveProvider === true;
      return items.map((item) => mapCompletionItem(
        item,
        canResolve ? storeResolveItem(record, record.completionResolveItems, item) : undefined,
      )).filter(Boolean);
    }),
    completionResolve: (request) => resolveFeature(
      'completionItem/resolve',
      request,
      'completionResolveItems',
      (raw) => mapCompletionItem(raw, request.resolveToken),
    ),
    hover: (request) => requestFeature('textDocument/hover', request, mapHover),
    signatureHelp: (request) => requestFeature('textDocument/signatureHelp', request, mapSignatureHelp),
    definition: (request) => requestFeature('textDocument/definition', request, (raw, record) => {
      const values = Array.isArray(raw) ? raw : raw ? [raw] : [];
      return values.map((value) => mapLocationLink(value, record.workspaceId, record.root, pathModule)).filter(Boolean);
    }),
    references: (request) => requestFeature('textDocument/references', request, (raw, record) => {
      const values = Array.isArray(raw) ? raw : [];
      return values.map((value) => mapLocation(value, record.workspaceId, record.root, pathModule)).filter(Boolean);
    }),
    documentSymbols: (request) => requestFeature('textDocument/documentSymbol', request, (raw, record) => (
      mapSymbols(raw, mappingContext(record))
    )),
    workspaceSymbols: (request) => requestFeature('workspace/symbol', request, (raw, record) => (
      mapSymbols(raw, mappingContext(record))
    )),
    rename: (request) => requestFeature('textDocument/rename', request, (raw, record) => (
      mapWorkspaceEdit(raw, mappingContext(record))
    )),
    codeActions: (request) => requestFeature('textDocument/codeAction', request, (raw, record) => {
      const values = Array.isArray(raw) ? raw : [];
      record.codeActionResolveItems.clear();
      const canResolve = record.serverCapabilities?.codeActionProvider?.resolveProvider === true;
      return values.map((value) => mapCodeAction(
        value,
        codeActionMappingContext(record, request),
        canResolve ? storeResolveItem(record, record.codeActionResolveItems, value) : undefined,
      )).filter(Boolean);
    }),
    codeActionResolve: (request) => resolveFeature(
      'codeAction/resolve',
      request,
      'codeActionResolveItems',
      (raw, record) => mapCodeAction(raw, codeActionMappingContext(record, request), request.resolveToken),
    ),
    executeCommand: (request) => requestFeature(
      'workspace/executeCommand',
      request,
      (raw) => raw ?? null,
    ),
    documentFormatting: (request) => requestFeature('textDocument/formatting', request, mapTextEdits),
    documentRangeFormatting: (request) => requestFeature('textDocument/rangeFormatting', request, mapTextEdits),
    onTypeFormatting: (request) => requestFeature('textDocument/onTypeFormatting', request, mapTextEdits),
    semanticTokens: (request) => requestFeature(
      request.range ? 'textDocument/semanticTokens/range' : 'textDocument/semanticTokens/full',
      request,
      (raw, record) => {
        if (!raw || !Array.isArray(raw.data)) return null;
        const provider = record.serverCapabilities?.semanticTokensProvider;
        const legend = provider?.legend;
        return {
          data: raw.data.filter((value) => Number.isInteger(value) && value >= 0),
          ...(typeof raw.resultId === 'string' ? { resultId: raw.resultId } : {}),
          legend: {
            tokenTypes: Array.isArray(legend?.tokenTypes) ? legend.tokenTypes.filter((value) => typeof value === 'string') : [],
            tokenModifiers: Array.isArray(legend?.tokenModifiers) ? legend.tokenModifiers.filter((value) => typeof value === 'string') : [],
          },
        };
      },
    ),
    inlayHints: (request) => requestFeature('textDocument/inlayHint', request, (raw, record) => {
      const values = Array.isArray(raw) ? raw : [];
      record.inlayHintResolveItems.clear();
      const canResolve = record.serverCapabilities?.inlayHintProvider?.resolveProvider === true;
      return values.map((value) => mapInlayHint(
        value,
        mappingContext(record),
        canResolve ? storeResolveItem(record, record.inlayHintResolveItems, value) : undefined,
      )).filter(Boolean);
    }),
    inlayHintResolve: (request) => resolveFeature(
      'inlayHint/resolve',
      request,
      'inlayHintResolveItems',
      (raw, record) => mapInlayHint(raw, mappingContext(record), request.resolveToken),
    ),
    documentHighlights: (request) => requestFeature('textDocument/documentHighlight', request, (raw) => (
      (Array.isArray(raw) ? raw : []).map(mapDocumentHighlight).filter(Boolean)
    )),
    foldingRanges: (request) => requestFeature('textDocument/foldingRange', request, (raw) => (
      (Array.isArray(raw) ? raw : []).map(mapFoldingRange).filter(Boolean)
    )),
    selectionRanges: (request) => requestFeature('textDocument/selectionRange', request, (raw) => (
      (Array.isArray(raw) ? raw : []).map(mapSelectionRange).filter(Boolean)
    )),
    documentLinks: (request) => requestFeature('textDocument/documentLink', request, (raw, record) => {
      const values = Array.isArray(raw) ? raw : [];
      record.documentLinkResolveItems.clear();
      const canResolve = record.serverCapabilities?.documentLinkProvider?.resolveProvider === true;
      return values.map((value) => mapDocumentLink(
        value,
        mappingContext(record),
        canResolve ? storeResolveItem(record, record.documentLinkResolveItems, value) : undefined,
      )).filter(Boolean);
    }),
    documentLinkResolve: (request) => resolveFeature(
      'documentLink/resolve',
      request,
      'documentLinkResolveItems',
      (raw, record) => mapDocumentLink(raw, mappingContext(record), request.resolveToken),
    ),
    documentColors: (request) => requestFeature('textDocument/documentColor', request, (raw) => (
      (Array.isArray(raw) ? raw : []).map(mapColorInformation).filter(Boolean)
    )),
    colorPresentations: (request) => requestFeature('textDocument/colorPresentation', request, (raw) => (
      (Array.isArray(raw) ? raw : []).map(mapColorPresentation).filter(Boolean)
    )),
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
      if (!ownerKey) {
        workspaceListeners.delete(workspaceId);
        for (const key of desiredDocuments.keys()) {
          if (key.startsWith(`${workspaceId}\0`)) desiredDocuments.delete(key);
        }
      }
      await Promise.all([...pendingExits]);
    },
    async dispose() {
      for (const record of sessions.values()) disposeRecord(record, 'Language supervisor disposed');
      sessions.clear();
      desiredDocuments.clear();
      inflight.clear();
      workspaceListeners.clear();
      providers.length = 0;
      await Promise.all([...pendingExits]);
    },
  };
};
