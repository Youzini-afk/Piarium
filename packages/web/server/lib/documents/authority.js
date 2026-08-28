import fs from 'node:fs';
import path from 'node:path';
import { resolveWorkspacePath, WorkspacePathError } from '../workspace/path-safety.js';
import { DocumentAuthorityError, DocumentPathError, DocumentUntrustedError, isDocumentAuthorityError } from './errors.js';
import { encodeDocumentText, inspectDocumentBytes, revisionFromBytes } from './inspect.js';
import { createWorkspaceMutationAuthority } from './mutation-authority.js';
import { createRecoveryJournalStore } from './recovery-journal.js';
import { createSerialQueues } from './serialize.js';
import { createWorkspaceWatcher } from './watch.js';
import {
  createWorkspaceRegistry,
  looksLikeCanonicalWorkspaceId,
  looksLikeFilesystemWorkspaceScopeId,
} from './workspace-registry.js';

const resourceKey = (resource) => `${resource.workspaceId}\0${resource.resourceId}`;

const toIso = (mtimeMs) => new Date(mtimeMs).toISOString();

const withoutContent = (result) => {
  if (result.status === 'ready') {
    const next = {
      status: 'ready',
      epoch: result.epoch,
      resource: result.resource,
      revision: result.revision,
      encoding: result.encoding,
      bom: result.bom,
      byteLength: result.byteLength,
    };
    if (result.modifiedAt) next.modifiedAt = result.modifiedAt;
    return next;
  }
  return result;
};

export const createDocumentAuthority = (options) => {
  const {
    hostId,
    dataDir,
    fsPromises = fs.promises,
    fsModule = fs,
    pathModule = path,
    isTrusted = async () => true,
    isAllowedRoot = async () => true,
    maxReadBytes = Number.POSITIVE_INFINITY,
    overflowLimit,
  } = options;

  const registry = createWorkspaceRegistry({
    hostId,
    filePath: pathModule.join(dataDir, 'documents', 'workspaces.json'),
    fsPromises,
    pathModule,
  });
  const journals = createRecoveryJournalStore({
    rootDir: pathModule.join(dataDir, 'document-recovery'),
    hostId,
    fsPromises,
    pathModule,
  });
  const queues = createSerialQueues();
  const watchers = new Map();
  const captureWatches = new Map();
  const dirtyBuffersByOwner = new Map();
  let disposed = false;
  let disposePromise = null;
  const mutations = createWorkspaceMutationAuthority({
    dataDir,
    hostId,
    fsModule,
    fsPromises,
    pathModule,
  });

  const realpath = async (target, allowMissing = false) => {
    try {
      return await fsPromises.realpath(target);
    } catch (error) {
      if (allowMissing && error?.code === 'ENOENT') return pathModule.resolve(target);
      throw error;
    }
  };

  const loadWorkspace = async (workspaceId) => {
    const mapping = await registry.get(workspaceId);
    if (!mapping) {
      throw new DocumentAuthorityError('Workspace is not registered on this application host', {
        code: 'failed',
        statusCode: 404,
      });
    }
    let root;
    try {
      root = await realpath(mapping.canonicalPath);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        throw new DocumentAuthorityError('Workspace root is unavailable', { code: 'failed', statusCode: 500 });
      }
      throw error;
    }
    if (!await isAllowedRoot(root)) {
      throw new DocumentPathError('Workspace root is not allowed');
    }
    if (!await isTrusted(root)) {
      throw new DocumentUntrustedError();
    }
    return { ...mapping, root };
  };

  const fail = (error) => {
    if (isDocumentAuthorityError(error)) throw error;
    if (error instanceof WorkspacePathError) {
      throw new DocumentPathError(
        error.message,
        error.statusCode && error.statusCode >= 500 ? error.statusCode : 403,
      );
    }
    throw new DocumentAuthorityError(error instanceof Error ? error.message : 'Document request failed', {
      code: 'failed',
      statusCode: 500,
    });
  };

  const resolveResourcePath = async (resource, allowMissing = false) => {
    const workspace = await loadWorkspace(resource.workspaceId);
    try {
      const resolved = await resolveWorkspacePath(resource.resourceId, {
        root: workspace.root,
        fsPromises,
        pathModule,
        allowMissing,
      });
      return { workspace, resolved };
    } catch (error) {
      fail(error);
    }
    throw new DocumentPathError('Path is outside workspace');
  };

  const assertTokenWorkspace = (token, workspaceId) => {
    if (!token || token.workspaceId !== workspaceId) {
      throw new DocumentAuthorityError('Workspace mutation token does not match the target workspace', {
        code: 'failed',
        statusCode: 400,
      });
    }
  };

  const snapshotFile = async (resource, absolutePath) => {
    let stat;
    try {
      stat = await fsPromises.lstat(absolutePath);
    } catch (error) {
      if (error?.code === 'ENOENT') return { status: 'missing', resource };
      throw error;
    }
    if (stat.isSymbolicLink()) {
      let real;
      try {
        real = await fsPromises.realpath(absolutePath);
      } catch (error) {
        if (error?.code === 'ENOENT') return { status: 'missing', resource };
        throw error;
      }
      const workspace = await loadWorkspace(resource.workspaceId);
      const relative = pathModule.relative(workspace.root, real);
      if (!relative || relative.startsWith('..') || pathModule.isAbsolute(relative)) {
        throw new DocumentPathError('Path is outside workspace');
      }
      stat = await fsPromises.stat(real);
      absolutePath = real;
    }
    if (stat.isDirectory()) {
      throw new DocumentPathError('Path is not a file', 400);
    }
    if (stat.size > maxReadBytes) {
      throw new DocumentAuthorityError('Document is too large to read', { code: 'failed', statusCode: 413 });
    }
    const bytes = await fsPromises.readFile(absolutePath);
    const revision = revisionFromBytes(bytes);
    const inspected = inspectDocumentBytes(bytes);
    const modifiedAt = toIso(stat.mtimeMs);
    if (inspected.kind === 'binary') {
      return {
        status: 'binary',
        resource,
        revision,
        byteLength: inspected.byteLength,
        modifiedAt,
      };
    }
    if (inspected.kind === 'unsupported-encoding') {
      const result = {
        status: 'unsupported-encoding',
        resource,
        revision,
        byteLength: inspected.byteLength,
        modifiedAt,
      };
      if (inspected.candidates) result.candidates = inspected.candidates;
      return result;
    }
    return {
      status: 'ready',
      resource,
      revision,
      content: inspected.content,
      encoding: inspected.encoding,
      bom: inspected.bom,
      byteLength: inspected.byteLength,
      modifiedAt,
    };
  };

  const atomicReplace = async (absolutePath, bytes) => {
    await fsPromises.mkdir(pathModule.dirname(absolutePath), { recursive: true });
    const tmp = `${absolutePath}.piarium-tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      await fsPromises.writeFile(tmp, bytes);
      await fsPromises.rename(tmp, absolutePath);
    } catch (error) {
      await fsPromises.unlink(tmp).catch(() => undefined);
      throw error;
    }
  };

  const resolveWorkspace = async (input = {}) => {
    try {
      if (input.workspaceId) {
        const mapping = await registry.get(input.workspaceId);
        if (!mapping) {
          throw new DocumentAuthorityError('Workspace is not registered on this application host', {
            code: 'failed',
            statusCode: 404,
          });
        }
        const mutation = await mutations.inspect(mapping.workspaceId);
        return { workspaceId: mapping.workspaceId, hostId, epoch: mutation.epoch };
      }
      const rawPath = typeof input.path === 'string' ? input.path.trim() : '';
      if (!rawPath) {
        throw new DocumentAuthorityError('Workspace path is required', { code: 'failed', statusCode: 400 });
      }
      let canonicalPath;
      try {
        canonicalPath = await realpath(rawPath);
      } catch (error) {
        if (error?.code === 'ENOENT') {
          throw new DocumentAuthorityError('Workspace path does not exist', { code: 'failed', statusCode: 404 });
        }
        throw error;
      }
      const stat = await fsPromises.stat(canonicalPath);
      if (!stat.isDirectory()) {
        throw new DocumentPathError('Workspace path is not a directory', 400);
      }
      if (!await isAllowedRoot(canonicalPath)) {
        throw new DocumentPathError('Workspace root is not allowed');
      }
      const mapping = await registry.resolve({ canonicalPath, create: true });
      const mutation = await mutations.inspect(mapping.workspaceId);
      return { workspaceId: mapping.workspaceId, hostId, epoch: mutation.epoch };
    } catch (error) {
      fail(error);
    }
  };

  const resolveScopeId = async (scopeId) => {
    if (looksLikeCanonicalWorkspaceId(scopeId)) {
      const mapping = await registry.get(scopeId);
      return mapping ? mapping.workspaceId : null;
    }
    if (!looksLikeFilesystemWorkspaceScopeId(scopeId)) return null;
    try {
      // A mutation may target a directory that does not exist yet (clone,
      // mkdir, rename destination). A registered containing workspace is
      // already sufficient for mutation accounting; this does not grant file
      // access, which remains with the calling route's existing checks.
      const containing = await registry.findContaining(scopeId);
      if (containing) return containing.workspaceId;
      const canonicalPath = await realpath(scopeId);
      if (!await isAllowedRoot(canonicalPath)) return null;
      const mapping = await registry.resolve({ canonicalPath, create: true });
      return mapping?.workspaceId ?? null;
    } catch {
      return null;
    }
  };

  const registerWriterForScope = async (scopeId, owner, options = {}) => {
    const workspaceId = await resolveScopeId(scopeId);
    if (!workspaceId) return null;
    const state = await mutations.inspect(workspaceId);
    return mutations.registerWriter({ workspaceId, epoch: state.epoch, owner }, options);
  };

  const runMutationForScope = async (scopeId, owner, operation, options = {}) => {
    const writer = await registerWriterForScope(scopeId, owner, options);
    try {
      return await operation();
    } finally {
      if (writer) {
        try {
          await writer.markMutated();
        } finally {
          await writer.close();
        }
      }
    }
  };

  const read = (resource) => queues.run(resourceKey(resource), async () => {
    try {
      const mutation = await mutations.inspect(resource.workspaceId);
      const { resolved } = await resolveResourcePath(resource, true);
      return { ...(await snapshotFile(resource, resolved.absolutePath)), epoch: mutation.epoch };
    } catch (error) {
      fail(error);
    }
  });

  const write = (request) => queues.run(resourceKey(request.resource), async () => {
    let writer;
    try {
      assertTokenWorkspace(request.token, request.resource.workspaceId);
      writer = await mutations.registerWriter(request.token, { purpose: 'document-write' });
      const { resolved } = await resolveResourcePath(request.resource, true);
      const current = {
        ...(await snapshotFile(request.resource, resolved.absolutePath)),
        epoch: request.token.epoch,
      };
      if (request.expectedRevision === null) {
        if (current.status !== 'missing') {
          return { status: 'conflict', current: withoutContent(current) };
        }
      } else if (current.status === 'missing' || current.revision !== request.expectedRevision) {
        return { status: 'conflict', current: withoutContent(current) };
      }
      let bytes;
      try {
        bytes = encodeDocumentText({
          content: request.content,
          encoding: request.encoding,
          bom: request.bom,
        });
      } catch {
        throw new DocumentAuthorityError('Unsupported document encoding', { code: 'failed', statusCode: 400 });
      }
      await atomicReplace(resolved.absolutePath, bytes);
      await writer.markMutated();
      const next = await snapshotFile(request.resource, resolved.absolutePath);
      if (next.status !== 'ready') {
        throw new DocumentAuthorityError('Failed to read document after write', { code: 'failed', statusCode: 500 });
      }
      const result = {
        status: 'written',
        revision: next.revision,
        byteLength: next.byteLength,
      };
      if (next.modifiedAt) result.modifiedAt = next.modifiedAt;
      return result;
    } catch (error) {
      if (error?.code === 'stale-epoch') {
        return { status: 'stale-epoch', currentEpoch: error.currentEpoch };
      }
      fail(error);
    } finally {
      await writer?.close();
    }
  });

  const move = (request) => queues.runMany([resourceKey(request.from), resourceKey(request.to)], async () => {
    let writer;
    try {
      if (request.from.workspaceId !== request.to.workspaceId) {
        throw new DocumentAuthorityError('Document moves must stay within one workspace', {
          code: 'failed',
          statusCode: 400,
        });
      }
      assertTokenWorkspace(request.token, request.from.workspaceId);
      writer = await mutations.registerWriter(request.token, { purpose: 'document-move' });
      const source = await resolveResourcePath(request.from, true);
      const target = await resolveResourcePath(request.to, true);
      const current = {
        ...(await snapshotFile(request.from, source.resolved.absolutePath)),
        epoch: request.token.epoch,
      };
      if (current.status === 'missing') return { status: 'missing', resource: request.from };
      if (current.status !== 'ready' && current.status !== 'binary' && current.status !== 'unsupported-encoding') {
        return { status: 'conflict', current: withoutContent(current) };
      }
      if (current.revision !== request.expectedRevision) {
        return { status: 'conflict', current: withoutContent(current) };
      }
      const targetCurrent = await snapshotFile(request.to, target.resolved.absolutePath);
      if (targetCurrent.status !== 'missing') return { status: 'target-exists', resource: request.to };
      await fsPromises.mkdir(pathModule.dirname(target.resolved.absolutePath), { recursive: true });
      await fsPromises.rename(source.resolved.absolutePath, target.resolved.absolutePath);
      await writer.markMutated();
      const next = await snapshotFile(request.to, target.resolved.absolutePath);
      const result = {
        status: 'moved',
        resource: request.to,
        revision: next.revision,
        byteLength: next.byteLength ?? 0,
      };
      if (next.modifiedAt) result.modifiedAt = next.modifiedAt;
      return result;
    } catch (error) {
      if (error?.code === 'stale-epoch') {
        return { status: 'stale-epoch', currentEpoch: error.currentEpoch };
      }
      fail(error);
    } finally {
      await writer?.close();
    }
  });

  const remove = (request) => queues.run(resourceKey(request.resource), async () => {
    let writer;
    try {
      assertTokenWorkspace(request.token, request.resource.workspaceId);
      writer = await mutations.registerWriter(request.token, { purpose: 'document-delete' });
      const { resolved } = await resolveResourcePath(request.resource, true);
      const current = {
        ...(await snapshotFile(request.resource, resolved.absolutePath)),
        epoch: request.token.epoch,
      };
      if (current.status === 'missing') return { status: 'missing', resource: request.resource };
      if (!current.revision || current.revision !== request.expectedRevision) {
        return { status: 'conflict', current: withoutContent(current) };
      }
      await fsPromises.unlink(resolved.absolutePath);
      await writer.markMutated();
      return { status: 'deleted', resource: request.resource };
    } catch (error) {
      if (error?.code === 'stale-epoch') {
        return { status: 'stale-epoch', currentEpoch: error.currentEpoch };
      }
      fail(error);
    } finally {
      await writer?.close();
    }
  });

  const watch = (workspaceId, listener) => {
    if (disposed) {
      throw new DocumentAuthorityError('Document authority is disposed', {
        code: 'failed',
        statusCode: 500,
      });
    }
    let record = watchers.get(workspaceId);
    if (!record) {
      record = { listeners: new Set(), controller: null, ready: null };
      watchers.set(workspaceId, record);
      record.ready = Promise.all([loadWorkspace(workspaceId), mutations.inspect(workspaceId)]).then(([workspace]) => {
        const controller = createWorkspaceWatcher({
          workspaceId,
          rootPath: workspace.root,
          fsModule,
          fsPromises,
          pathModule,
          overflowLimit,
          onEvent: (event) => {
            void mutations.observeWatchEvent(workspaceId, event).catch(() => undefined);
            for (const current of record.listeners) current(event);
          },
        });
        if (watchers.get(workspaceId) !== record) {
          controller.close();
          return null;
        }
        record.controller = controller;
        return controller;
      }).catch(() => {
        if (watchers.get(workspaceId) === record) watchers.delete(workspaceId);
        return null;
      });
    }
    record.listeners.add(listener);
    return {
      close() {
        record.listeners.delete(listener);
        if (record.listeners.size === 0) {
          record.controller?.close();
          if (watchers.get(workspaceId) === record) watchers.delete(workspaceId);
        }
      },
    };
  };

  const watcherController = (workspaceId) => watchers.get(workspaceId)?.controller ?? null;

  const beginCapture = async (workspaceId, options = {}) => {
    const subscription = watch(workspaceId, () => undefined);
    const record = watchers.get(workspaceId);
    const controller = await record?.ready;
    if (!controller || watchers.get(workspaceId) !== record) {
      subscription.close();
      throw new DocumentAuthorityError('Workspace watcher is unavailable for capture', {
        code: 'failed',
        statusCode: 500,
      });
    }
    await new Promise((resolve) => setImmediate(resolve));
    await controller.settle();
    await mutations.setWatchBaseline(workspaceId, controller.position);
    const capture = await mutations.beginCapture(workspaceId, options);
    captureWatches.set(capture.captureId, { subscription, controller });
    return capture;
  };

  const completeCapture = async (capture) => {
    const tracked = captureWatches.get(capture?.captureId);
    try {
      await tracked?.controller.settle();
      return await mutations.completeCapture(capture);
    } finally {
      captureWatches.delete(capture?.captureId);
      tracked?.subscription.close();
    }
  };

  const journalMutation = async (request, purpose, operation) => {
    let writer;
    try {
      const workspaceId = request.workspaceId ?? request.token?.workspaceId;
      assertTokenWorkspace(request.token, workspaceId);
      writer = await mutations.registerWriter(request.token, { purpose });
      const result = await operation();
      if (result.status === 'written' || result.status === 'deleted') await writer.markMutated();
      return result;
    } catch (error) {
      if (error?.code === 'stale-epoch') {
        return { status: 'stale-epoch', currentEpoch: error.currentEpoch };
      }
      fail(error);
    } finally {
      await writer?.close();
    }
  };

  const dirtyBufferKey = (ownerId, workspaceId) => `${ownerId}\0${workspaceId}`;

  const publishDirtyBuffers = async (request) => {
    if (!request || typeof request.ownerId !== 'string' || !request.ownerId
      || typeof request.workspaceId !== 'string' || !request.workspaceId
      || !Number.isSafeInteger(request.generation) || request.generation < 0
      || !Array.isArray(request.resources)) {
      throw new DocumentAuthorityError('Dirty buffer publication is malformed', { code: 'failed', statusCode: 400 });
    }
    await loadWorkspace(request.workspaceId);
    const key = dirtyBufferKey(request.ownerId, request.workspaceId);
    const existing = dirtyBuffersByOwner.get(key);
    if (existing && existing.generation > request.generation) {
      throw new DocumentAuthorityError('Dirty buffer publication is stale', {
        code: 'stale-completion',
        statusCode: 409,
      });
    }
    const resources = request.resources.map((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)
        || !entry.resource || entry.resource.workspaceId !== request.workspaceId
        || typeof entry.resource.resourceId !== 'string' || !entry.resource.resourceId
        || (entry.baseRevision !== null && typeof entry.baseRevision !== 'string')
        || !Number.isSafeInteger(entry.localEditRevision) || entry.localEditRevision < 0) {
        throw new DocumentAuthorityError('Dirty buffer resource is malformed', { code: 'failed', statusCode: 400 });
      }
      return {
        baseRevision: entry.baseRevision,
        localEditRevision: entry.localEditRevision,
        resource: { ...entry.resource },
      };
    });
    const record = {
      generation: request.generation,
      ownerId: request.ownerId,
      resources,
      updatedAt: new Date().toISOString(),
      workspaceId: request.workspaceId,
    };
    dirtyBuffersByOwner.set(key, record);
    return structuredClone(record);
  };

  const clearDirtyBuffers = async (request) => {
    if (!request || typeof request.ownerId !== 'string' || !request.ownerId
      || typeof request.workspaceId !== 'string' || !request.workspaceId
      || !Number.isSafeInteger(request.generation) || request.generation < 0) {
      throw new DocumentAuthorityError('Dirty buffer clear request is malformed', { code: 'failed', statusCode: 400 });
    }
    const key = dirtyBufferKey(request.ownerId, request.workspaceId);
    const existing = dirtyBuffersByOwner.get(key);
    if (existing && existing.generation > request.generation) {
      throw new DocumentAuthorityError('Dirty buffer clear request is stale', {
        code: 'stale-completion',
        statusCode: 409,
      });
    }
    return { cleared: dirtyBuffersByOwner.delete(key) };
  };

  const inspectDirtyBuffers = async (workspaceId) => {
    await loadWorkspace(workspaceId);
    return [...dirtyBuffersByOwner.values()]
      .filter((record) => record.workspaceId === workspaceId)
      .map((record) => structuredClone(record))
      .sort((left, right) => left.ownerId.localeCompare(right.ownerId));
  };

  const dispose = () => {
    if (disposePromise) return disposePromise;
    disposed = true;
    const records = [...watchers.values()];
    watchers.clear();
    for (const record of records) {
      record.listeners.clear();
      record.controller?.close();
    }
    for (const tracked of captureWatches.values()) {
      tracked.subscription.close();
      tracked.controller.close();
    }
    captureWatches.clear();
    dirtyBuffersByOwner.clear();
    // Mutation disposal flips its admission gate synchronously, before an
    // asynchronously starting watcher can register more mutation work.
    const mutationDisposal = mutations.dispose();
    disposePromise = (async () => {
      await Promise.allSettled(records.map((record) => record.ready));
      await mutationDisposal;
    })();
    return disposePromise;
  };

  return {
    hostId,
    resolveWorkspace,
    inspectWorkspace: async (workspaceId) => {
      try {
        const workspace = await loadWorkspace(workspaceId);
        return {
          workspaceId: workspace.workspaceId,
          hostId,
          root: workspace.root,
          ...(await mutations.inspect(workspaceId)),
        };
      } catch (error) {
        fail(error);
      }
      throw new DocumentAuthorityError('Workspace is not registered on this application host', {
        code: 'failed',
        statusCode: 404,
      });
    },
    resolveScopeId,
    registerWriterForScope,
    runMutationForScope,
    read,
    write,
    move,
    delete: remove,
    watch,
    listRecoveryJournals: (request) => journals.list(request),
    readRecoveryJournal: (journalId) => journals.read(journalId),
    publishDirtyBuffers,
    clearDirtyBuffers,
    inspectDirtyBuffers,
    writeRecoveryJournal: (request) => journalMutation(
      request,
      'document-recovery-journal-write',
      () => journals.write(request),
    ),
    deleteRecoveryJournal: (request) => journalMutation(
      request,
      'document-recovery-journal-delete',
      () => journals.delete(request),
    ),
    mutationAuthority: mutations,
    inspectMutation: mutations.inspect,
    beginCapture,
    completeCapture,
    dispose,
    advanceEpoch: mutations.advanceEpoch,
    setMaintenance: mutations.setMaintenance,
    registerWriter: mutations.registerWriter,
    emitWatchOverflow: (workspaceId) => {
      const controller = watcherController(workspaceId);
      if (!controller) return false;
      controller.overflow();
      return true;
    },
    reconnectWatch: (workspaceId) => watcherController(workspaceId)?.reconnect(),
    emitAuthorityChanged: (workspaceId) => watcherController(workspaceId)?.authorityChanged(),
    hasWatch: (workspaceId) => Boolean(watcherController(workspaceId)),
  };
};
