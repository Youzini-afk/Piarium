import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  canonicalizePathIdentity,
  normalizePathIdentity,
  resolveWorkspacePath,
  WorkspacePathError,
} from '../workspace/path-safety.js';
import {
  DocumentAuthorityError,
  DocumentPathError,
  DocumentUntrustedError,
  DocumentWorkspaceUnavailableError,
  isDocumentAuthorityError,
} from './errors.js';
import { encodeDocumentText, inspectDocumentBytes, revisionFromBytes } from './inspect.js';
import { createWorkspaceMutationAuthority } from './mutation-authority.js';
import {
  createRecoveryJournalStore,
  type RecoveryJournalDeleteRequest,
  type RecoveryJournalListRequest,
  type RecoveryJournalWriteRequest,
} from './recovery-journal.js';
import { createSerialQueues } from './serialize.js';
import {
  createWorkspaceWatcher,
  type WatchEvent,
  type WorkspaceWatcher,
  type WorkspaceWatchFs,
} from './watch.js';
import {
  createWorkspaceRegistry,
  looksLikeCanonicalWorkspaceId,
  looksLikeFilesystemWorkspaceScopeId,
  type WorkspaceMapping,
} from './workspace-registry.js';

// ── Types ────────────────────────────────────────────────────────────────

export interface DocumentResource {
  workspaceId: string;
  resourceId: string;
}

export interface MutationToken {
  workspaceId: string;
  epoch: number;
  owner: unknown;
}

export interface MutationOwner {
  kind: string;
  id: string;
  generation?: number | undefined;
}

interface DocumentWriter {
  owner: MutationOwner;
  markMutated: () => Promise<void>;
  close: () => Promise<void>;
}

interface ResolvedWorkspacePath {
  absolutePath: string;
  relativePath: string;
}

interface LoadedWorkspace extends WorkspaceMapping {
  root: string;
}

interface ResolveResourceResult {
  workspace: LoadedWorkspace;
  resolved: ResolvedWorkspacePath;
}

type SnapshotResult =
  | { status: 'missing'; resource: DocumentResource }
  | { status: 'binary'; resource: DocumentResource; revision: string; byteLength: number; modifiedAt: string }
  | { status: 'unsupported-encoding'; resource: DocumentResource; revision: string; byteLength: number; modifiedAt: string; candidates?: string[] }
  | { status: 'ready'; resource: DocumentResource; revision: string; content: string; encoding: string; bom: boolean; byteLength: number; modifiedAt: string };

type SnapshotWithEpoch = SnapshotResult & { epoch: number };

type WithoutContentResult =
  | { status: 'ready'; epoch: number; resource: DocumentResource; revision: string; encoding: string; bom: boolean; byteLength: number; modifiedAt?: string }
  | Exclude<SnapshotWithEpoch, { status: 'ready' }>;

interface WriteRequest {
  resource: DocumentResource;
  token: MutationToken;
  content: string;
  encoding: string;
  bom: boolean;
  expectedRevision: string | null;
  operationId?: string | undefined;
}

interface MoveRequest {
  from: DocumentResource;
  to: DocumentResource;
  token: MutationToken;
  expectedRevision: string;
  operationId?: string | undefined;
}

interface DeleteRequest {
  resource: DocumentResource;
  token: MutationToken;
  expectedRevision: string;
  operationId?: string | undefined;
}

interface ResolveWorkspaceInput {
  workspaceId?: string;
  path?: string;
}

export interface ResolveWorkspaceResult {
  workspaceId: string;
  hostId: string;
  epoch: number;
}

interface WatchSubscription {
  ready: Promise<boolean>;
  settle: () => Promise<void>;
  close: () => void;
}

interface WatcherRecord {
  listeners: Set<(event: WatchEvent) => void>;
  controller: WorkspaceWatcher | null;
  ready: Promise<WorkspaceWatcher | null> | null;
}

interface CaptureWatch {
  subscription: WatchSubscription;
  controller: WorkspaceWatcher;
}

interface DirtySurfaceRequest {
  ownerId: string;
  workspaceId: string;
  generation: number;
}

interface DirtySurfaceRecord extends DirtySurfaceRequest {
  key: string;
  listener: (event: unknown) => void;
  registrationId: string;
}

interface DirtySurfaceSubscription {
  close: () => void;
}

export interface DirtyBufferResource {
  baseRevision: string | null;
  localEditRevision: number;
  resource: DocumentResource;
}

interface DirtyBufferRecord {
  generation: number;
  ownerId: string;
  publicationRevision: number;
  resources: DirtyBufferResource[];
  updatedAt: string;
  workspaceId: string;
}

export interface DirtyBufferPublication {
  generation: number;
  ownerId: string;
  resources: DirtyBufferResource[];
  updatedAt: string;
  workspaceId: string;
}

interface DirtyBarrierWaiter {
  resolve: () => void;
  reject: (error: unknown) => void;
}

interface DirtyBarrier {
  barrierId: string;
  caseSensitive: boolean;
  paths: string[];
  pending: Set<string>;
  requiredPublications: Map<string, number>;
  released: boolean;
  surfaceKeys: Set<string>;
  timer: ReturnType<typeof setTimeout> | null;
  waiters: Set<DirtyBarrierWaiter>;
  workspaceId: string;
}

export interface DirtyStateBarrierHandle {
  barrierId: string;
  release: () => Promise<void>;
  settle: () => Promise<void>;
}

interface DirtyStateBarrierAckRequest {
  barrierId: string;
  ownerId: string;
  workspaceId: string;
  generation: number;
}

interface PublishDirtyBuffersRequest {
  ownerId: string;
  workspaceId: string;
  generation: number;
  resources: unknown[];
}

interface ClearDirtyBuffersRequest {
  ownerId: string;
  workspaceId: string;
  generation: number;
}

interface BeginDirtyStateBarrierOptions {
  caseSensitive?: boolean;
}

interface JournalMutationRequest {
  workspaceId?: string;
  token?: MutationToken;
}

type StaleEpochResult = { status: 'stale-epoch'; currentEpoch: number | undefined };

export type DocumentReadResult = SnapshotWithEpoch;
export type DocumentWriteResult =
  | { status: 'written'; revision: string; byteLength: number; modifiedAt?: string | undefined }
  | { status: 'conflict'; current: WithoutContentResult }
  | StaleEpochResult;
export type DocumentMoveResult =
  | { status: 'moved'; resource: DocumentResource; revision: string; byteLength: number; modifiedAt?: string | undefined }
  | { status: 'missing'; resource: DocumentResource }
  | { status: 'target-exists'; resource: DocumentResource }
  | { status: 'conflict'; current: WithoutContentResult }
  | StaleEpochResult;
export type DocumentDeleteResult =
  | { status: 'deleted'; resource: DocumentResource }
  | { status: 'missing'; resource: DocumentResource }
  | { status: 'conflict'; current: WithoutContentResult }
  | StaleEpochResult;

export interface DocumentAuthorityOptions {
  hostId: string;
  dataDir: string;
  fsPromises?: DocumentFsPromises;
  fsModule?: WorkspaceWatchFs;
  pathModule?: typeof path;
  processLike?: Pick<NodeJS.Process, 'pid' | 'platform' | 'kill'>;
  isTrusted?: (root: string) => Promise<boolean>;
  isAllowedRoot?: (root: string) => Promise<boolean>;
  onWorkspaceResolved?: (resolved: ResolveWorkspaceResult) => void;
  onMutation?: (event: DocumentMutationObservation) => void | Promise<void>;
  maxReadBytes?: number;
  overflowLimit?: number;
  dirtyBarrierTimeoutMs?: number;
}

export interface DocumentMutationObservation {
  workspaceId: string;
  resourceId: string;
  kind: 'created' | 'modified' | 'deleted';
  owner: MutationOwner;
}

export type DocumentFsPromises = typeof fs.promises;

// ── Helpers ──────────────────────────────────────────────────────────────

const resourceKey = (resource: DocumentResource): string => `${resource.workspaceId}\0${resource.resourceId}`;

const toIso = (mtimeMs: number): string => new Date(mtimeMs).toISOString();

const withoutContent = (result: SnapshotWithEpoch): WithoutContentResult => {
  if (result.status === 'ready') {
    const next: WithoutContentResult = {
      status: 'ready',
      epoch: result.epoch,
      resource: result.resource,
      revision: result.revision,
      encoding: result.encoding,
      bom: result.bom,
      byteLength: result.byteLength,
    };
    if (result.modifiedAt) (next as { modifiedAt?: string }).modifiedAt = result.modifiedAt;
    return next;
  }
  return result;
};

// ── Factory ──────────────────────────────────────────────────────────────

export const createDocumentAuthority = (options: DocumentAuthorityOptions) => {
  const {
    hostId,
    dataDir,
    fsPromises = fs.promises,
    fsModule = fs,
    pathModule = path,
    processLike = process,
    isTrusted = async () => true,
    isAllowedRoot = async () => true,
    onWorkspaceResolved = () => undefined,
    onMutation = () => undefined,
    maxReadBytes = Number.POSITIVE_INFINITY,
    overflowLimit,
    dirtyBarrierTimeoutMs = 15_000,
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
  const watchers = new Map<string, WatcherRecord>();
  const captureWatches = new Map<string, CaptureWatch>();
  const dirtyBuffersByOwner = new Map<string, DirtyBufferRecord>();
  const dirtySurfaces = new Map<string, DirtySurfaceRecord>();
  const dirtyBarriers = new Map<string, DirtyBarrier>();
  let dirtyPublicationRevision = 0;
  let disposed = false;
  let disposePromise: Promise<void> | null = null;
  const platform = typeof processLike?.platform === 'string' ? processLike.platform : process.platform;
  const mutations = createWorkspaceMutationAuthority({
    dataDir,
    hostId,
    fsModule,
    fsPromises,
    pathModule,
    processLike,
  });

  const publishMutation = (event: DocumentMutationObservation): void => {
    try {
      void Promise.resolve(onMutation({ ...event, owner: { ...event.owner } })).catch((error: unknown) => {
        console.warn(`[Documents] Mutation observer failed: ${(error as Error)?.message || error}`);
      });
    } catch (error) {
      console.warn(`[Documents] Mutation observer failed: ${(error as Error)?.message || error}`);
    }
  };

  const loadWorkspace = async (workspaceId: string): Promise<LoadedWorkspace> => {
    const mapping = await registry.get(workspaceId);
    if (!mapping) {
      throw new DocumentAuthorityError('Workspace is not registered on this application host', {
        code: 'failed',
        statusCode: 404,
      });
    }
    let root: string;
    try {
      root = await canonicalizePathIdentity(mapping.canonicalPath, { fsPromises, pathModule });
    } catch (error) {
      throw new DocumentWorkspaceUnavailableError(undefined, { cause: error });
    }
    if (
      normalizePathIdentity(root, { pathModule, platform })
      !== normalizePathIdentity(mapping.canonicalPath, { pathModule, platform })
    ) {
      throw new DocumentUntrustedError('Workspace root identity changed');
    }
    if (!await isTrusted(root)) {
      throw new DocumentUntrustedError();
    }
    return { ...mapping, root };
  };

  const fail = (error: unknown): never => {
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

  const resolveResourcePath = async (resource: DocumentResource, allowMissing = false): Promise<ResolveResourceResult> => {
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
      return fail(error);
    }
    throw new DocumentPathError('Path is outside workspace');
  };

  const assertTokenWorkspace = (token: MutationToken | undefined, workspaceId: string | undefined): void => {
    if (!token || token.workspaceId !== workspaceId) {
      throw new DocumentAuthorityError('Workspace mutation token does not match the target workspace', {
        code: 'failed',
        statusCode: 400,
      });
    }
  };

  const snapshotFile = async (resource: DocumentResource, absolutePath: string): Promise<SnapshotResult> => {
    let stat: import('node:fs').Stats;
    try {
      stat = await fsPromises.lstat(absolutePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return { status: 'missing', resource };
      throw error;
    }
    if (stat.isSymbolicLink()) {
      let real: string;
      try {
        real = await fsPromises.realpath(absolutePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return { status: 'missing', resource };
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
      const result: SnapshotResult = {
        status: 'unsupported-encoding',
        resource,
        revision,
        byteLength: inspected.byteLength,
        modifiedAt,
      };
      if (inspected.candidates) (result as { candidates?: string[] }).candidates = inspected.candidates;
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

  const atomicReplace = async (absolutePath: string, bytes: Uint8Array): Promise<void> => {
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

  const resolveWorkspace = async (input: ResolveWorkspaceInput = {}): Promise<ResolveWorkspaceResult> => {
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
      let canonicalPath: string;
      try {
        canonicalPath = await canonicalizePathIdentity(rawPath, { fsPromises, pathModule });
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
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
      if (!mapping) throw new DocumentAuthorityError('Workspace resolution failed', { code: 'failed', statusCode: 500 });
      const mutation = await mutations.inspect(mapping.workspaceId);
      const resolved = { workspaceId: mapping.workspaceId, hostId, epoch: mutation.epoch };
      void Promise.resolve().then(() => onWorkspaceResolved(resolved)).catch((error: unknown) => {
        console.warn(`[Documents] Workspace resolution observer failed: ${(error as Error)?.message || error}`);
      });
      return resolved;
    } catch (error) {
      return fail(error);
    }
    throw new DocumentAuthorityError('Workspace resolution failed', { code: 'failed', statusCode: 500 });
  };

  const resolveScopeId = async (scopeId: unknown): Promise<string | null> => {
    if (looksLikeCanonicalWorkspaceId(scopeId)) {
      const mapping = await registry.get(scopeId);
      return mapping ? mapping.workspaceId : null;
    }
    if (!looksLikeFilesystemWorkspaceScopeId(scopeId)) return null;
    try {
      const canonicalPath = await canonicalizePathIdentity(scopeId as string, {
        allowMissing: true,
        fsPromises,
        pathModule,
      });
      const containing = await registry.findContaining(canonicalPath);
      if (containing) return containing.workspaceId;
      await fsPromises.stat(canonicalPath);
      if (!await isAllowedRoot(canonicalPath)) return null;
      const mapping = await registry.resolve({ canonicalPath, create: true });
      return mapping?.workspaceId ?? null;
    } catch {
      return null;
    }
  };

  const registerWriterForScope = async (
    scopeId: unknown,
    owner: MutationOwner,
    options: Record<string, unknown> = {},
  ) => {
    const workspaceId = await resolveScopeId(scopeId);
    if (!workspaceId) return null;
    const state = await mutations.inspect(workspaceId);
    return mutations.registerWriter({ workspaceId, epoch: state.epoch, owner }, options);
  };

  const runMutationForScope = async <Result>(
    scopeId: unknown,
    owner: MutationOwner,
    operation: () => Promise<Result>,
    options: Record<string, unknown> = {},
  ): Promise<Result> => {
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

  const read = (resource: DocumentResource): Promise<DocumentReadResult> => queues.run(resourceKey(resource), async () => {
    try {
      const mutation = await mutations.inspect(resource.workspaceId);
      const { resolved } = await resolveResourcePath(resource, true);
      return { ...(await snapshotFile(resource, resolved.absolutePath)), epoch: mutation.epoch };
    } catch (error) {
      return fail(error);
    }
  });

  const write = (request: WriteRequest): Promise<DocumentWriteResult> => queues.run(resourceKey(request.resource), async () => {
    let writer: DocumentWriter | undefined;
    try {
      assertTokenWorkspace(request.token, request.resource.workspaceId);
      writer = await mutations.registerWriter(request.token, { purpose: 'document-write' });
      const { resolved } = await resolveResourcePath(request.resource, true);
      const current = {
        ...(await snapshotFile(request.resource, resolved.absolutePath)),
        epoch: request.token.epoch,
      } as SnapshotWithEpoch;
      if (request.expectedRevision === null) {
        if (current.status !== 'missing') {
          return { status: 'conflict', current: withoutContent(current) };
        }
      } else if (current.status === 'missing' || (current.status !== 'binary' && current.status !== 'unsupported-encoding' && current.revision !== request.expectedRevision)) {
        return { status: 'conflict', current: withoutContent(current) };
      }
      let bytes: Uint8Array;
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
      const result: { status: 'written'; revision: string; byteLength: number; modifiedAt?: string } = {
        status: 'written',
        revision: next.revision,
        byteLength: next.byteLength,
      };
      if (next.modifiedAt) result.modifiedAt = next.modifiedAt;
      publishMutation({
        workspaceId: request.resource.workspaceId,
        resourceId: request.resource.resourceId,
        kind: current.status === 'missing' ? 'created' : 'modified',
        owner: writer.owner,
      });
      return result;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'stale-epoch') {
        return { status: 'stale-epoch', currentEpoch: (error as NodeJS.ErrnoException & { currentEpoch?: number }).currentEpoch };
      }
      return fail(error);
    } finally {
      await writer?.close();
    }
  });

  const move = (request: MoveRequest): Promise<DocumentMoveResult> => queues.runMany([resourceKey(request.from), resourceKey(request.to)], async () => {
    let writer: DocumentWriter | undefined;
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
      } as SnapshotWithEpoch;
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
      const result: { status: 'moved'; resource: DocumentResource; revision: string; byteLength: number; modifiedAt?: string } = {
        status: 'moved',
        resource: request.to,
        revision: next.status === 'missing' ? '' : next.revision,
        byteLength: next.status === 'missing' ? 0 : next.byteLength ?? 0,
      };
      if (next.status !== 'missing' && next.modifiedAt) result.modifiedAt = next.modifiedAt;
      publishMutation({
        workspaceId: request.from.workspaceId,
        resourceId: request.from.resourceId,
        kind: 'deleted',
        owner: writer.owner,
      });
      publishMutation({
        workspaceId: request.to.workspaceId,
        resourceId: request.to.resourceId,
        kind: 'created',
        owner: writer.owner,
      });
      return result;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'stale-epoch') {
        return { status: 'stale-epoch', currentEpoch: (error as NodeJS.ErrnoException & { currentEpoch?: number }).currentEpoch };
      }
      return fail(error);
    } finally {
      await writer?.close();
    }
  });

  const remove = (request: DeleteRequest): Promise<DocumentDeleteResult> => queues.run(resourceKey(request.resource), async () => {
    let writer: DocumentWriter | undefined;
    try {
      assertTokenWorkspace(request.token, request.resource.workspaceId);
      writer = await mutations.registerWriter(request.token, { purpose: 'document-delete' });
      const { resolved } = await resolveResourcePath(request.resource, true);
      const current = {
        ...(await snapshotFile(request.resource, resolved.absolutePath)),
        epoch: request.token.epoch,
      } as SnapshotWithEpoch;
      if (current.status === 'missing') return { status: 'missing', resource: request.resource };
      if ((current.status === 'ready' || current.status === 'binary' || current.status === 'unsupported-encoding') && current.revision !== request.expectedRevision) {
        return { status: 'conflict', current: withoutContent(current) };
      }
      await fsPromises.unlink(resolved.absolutePath);
      await writer.markMutated();
      publishMutation({
        workspaceId: request.resource.workspaceId,
        resourceId: request.resource.resourceId,
        kind: 'deleted',
        owner: writer.owner,
      });
      return { status: 'deleted', resource: request.resource };
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'stale-epoch') {
        return { status: 'stale-epoch', currentEpoch: (error as NodeJS.ErrnoException & { currentEpoch?: number }).currentEpoch };
      }
      return fail(error);
    } finally {
      await writer?.close();
    }
  });

  const watch = (workspaceId: string, listener: (event: WatchEvent) => void): WatchSubscription => {
    if (disposed) {
      throw new DocumentAuthorityError('Document authority is disposed', {
        code: 'failed',
        statusCode: 500,
      });
    }
    let record: WatcherRecord | undefined = watchers.get(workspaceId);
    if (!record) {
      const newRecord: WatcherRecord = { listeners: new Set(), controller: null, ready: null };
      watchers.set(workspaceId, newRecord);
      newRecord.ready = Promise.all([loadWorkspace(workspaceId), mutations.inspect(workspaceId)]).then(([workspace]) => {
        const controller = createWorkspaceWatcher({
          workspaceId,
          rootPath: workspace.root,
          fsModule,
          fsPromises,
          pathModule,
          ...(overflowLimit !== undefined ? { overflowLimit } : {}),
          onEvent: (event) => {
            void mutations.observeWatchEvent(workspaceId, event).catch(() => undefined);
            for (const current of newRecord.listeners) current(event);
          },
        });
        if (watchers.get(workspaceId) !== newRecord) {
          controller.close();
          return null;
        }
        newRecord.controller = controller;
        return controller;
      }).catch(() => {
        if (watchers.get(workspaceId) === newRecord) watchers.delete(workspaceId);
        return null;
      });
      record = newRecord;
    }
    const rec = record;
    rec.listeners.add(listener);
    return {
      ready: Promise.resolve(rec.ready).then((controller) => Boolean(controller)),
      settle: () => Promise.resolve(rec.ready).then((controller) => controller?.settle()),
      close() {
        rec.listeners.delete(listener);
        if (rec.listeners.size === 0) {
          rec.controller?.close();
          if (watchers.get(workspaceId) === rec) watchers.delete(workspaceId);
        }
      },
    };
  };

  const watcherController = (workspaceId: string): WorkspaceWatcher | null => watchers.get(workspaceId)?.controller ?? null;

  const beginCapture = async (workspaceId: string, options: Record<string, unknown> = {}) => {
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

  const completeCapture = async (capture: unknown) => {
    const captureId = (capture as { captureId?: string })?.captureId;
    const tracked = captureId ? captureWatches.get(captureId) : undefined;
    try {
      await tracked?.controller.settle();
      return await mutations.completeCapture(capture as never);
    } finally {
      if (captureId) captureWatches.delete(captureId);
      tracked?.subscription.close();
    }
  };

  const journalMutation = async <T extends { status: string }>(
    request: JournalMutationRequest,
    purpose: string,
    operation: () => Promise<T>,
  ): Promise<T | StaleEpochResult> => {
    let writer: DocumentWriter | undefined;
    try {
      const workspaceId = request.workspaceId ?? request.token?.workspaceId;
      assertTokenWorkspace(request.token, workspaceId);
      writer = await mutations.registerWriter(request.token, { purpose });
      const result = await operation();
      if (result.status === 'written' || result.status === 'deleted') await writer.markMutated();
      return result;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'stale-epoch') {
        return { status: 'stale-epoch', currentEpoch: (error as NodeJS.ErrnoException & { currentEpoch?: number }).currentEpoch };
      }
      return fail(error);
    } finally {
      await writer?.close();
    }
  };

  const dirtyBufferKey = (ownerId: string, workspaceId: string): string => `${ownerId}\0${workspaceId}`;
  const publicDirtyBufferRecord = (record: DirtyBufferRecord): DirtyBufferPublication => {
    const result = structuredClone(record);
    delete (result as Partial<DirtyBufferRecord>).publicationRevision;
    return result;
  };

  const releaseDirtyBarrier = (barrier: DirtyBarrier, error?: unknown): void => {
    if (!barrier || barrier.released) return;
    barrier.released = true;
    if (barrier.timer) clearTimeout(barrier.timer);
    dirtyBarriers.delete(barrier.barrierId);
    for (const surfaceKey of barrier.surfaceKeys) {
      const surface = dirtySurfaces.get(surfaceKey);
      if (!surface) continue;
      try {
        surface.listener({
          action: 'release',
          barrierId: barrier.barrierId,
          caseSensitive: barrier.caseSensitive,
          kind: 'dirty-state-barrier',
          paths: barrier.paths,
          workspaceId: barrier.workspaceId,
        });
      } catch {
        // Releasing every other surface and settling waiters is more important
        // than propagating an already-disconnected listener failure.
      }
    }
    for (const waiter of barrier.waiters) {
      if (error) waiter.reject(error);
      else waiter.resolve();
    }
    barrier.waiters.clear();
  };

  const dirtyBarrierFailure = (message: string): DocumentAuthorityError => new DocumentAuthorityError(message, {
    code: 'failed',
    statusCode: 503,
  });

  const armDirtyBarrierDeadline = (barrier: DirtyBarrier): void => {
    if (barrier.timer) clearTimeout(barrier.timer);
    if (barrier.pending.size === 0 || barrier.released) {
      barrier.timer = null;
      return;
    }
    barrier.timer = setTimeout(() => {
      releaseDirtyBarrier(barrier, dirtyBarrierFailure('Document surfaces did not publish dirty state before the barrier deadline'));
    }, dirtyBarrierTimeoutMs);
    barrier.timer.unref?.();
  };

  const settleDirtyBarrier = (barrier: DirtyBarrier): Promise<void> => {
    if (barrier.released) {
      return Promise.reject(dirtyBarrierFailure('Dirty-state barrier was released before it settled'));
    }
    if (barrier.pending.size === 0) return Promise.resolve();
    return new Promise<void>((resolve, reject) => barrier.waiters.add({ reject, resolve }));
  };

  const resolveDirtyBarrierWaiters = (barrier: DirtyBarrier): void => {
    if (barrier.pending.size > 0 || barrier.released) return;
    if (barrier.timer) clearTimeout(barrier.timer);
    barrier.timer = null;
    for (const waiter of barrier.waiters) waiter.resolve();
    barrier.waiters.clear();
  };

  const registerDirtySurface = (request: DirtySurfaceRequest, listener: (event: unknown) => void): DirtySurfaceSubscription => {
    if (disposed) {
      throw new DocumentAuthorityError('Document authority is disposed', { code: 'failed', statusCode: 500 });
    }
    if (!request || typeof request.ownerId !== 'string' || !request.ownerId
      || typeof request.workspaceId !== 'string' || !request.workspaceId
      || !Number.isSafeInteger(request.generation) || request.generation < 0
      || typeof listener !== 'function') {
      throw new DocumentAuthorityError('Dirty surface registration is malformed', { code: 'failed', statusCode: 400 });
    }
    const key = dirtyBufferKey(request.ownerId, request.workspaceId);
    const record: DirtySurfaceRecord = { ...request, key, listener, registrationId: randomUUID() };
    dirtySurfaces.set(key, record);
    for (const barrier of dirtyBarriers.values()) {
      if (barrier.workspaceId !== request.workspaceId || barrier.released) continue;
      barrier.surfaceKeys.add(key);
      barrier.pending.add(key);
      barrier.requiredPublications.set(key, dirtyPublicationRevision + 1);
      armDirtyBarrierDeadline(barrier);
      try {
        listener({
          action: 'acquire',
          barrierId: barrier.barrierId,
          caseSensitive: barrier.caseSensitive,
          kind: 'dirty-state-barrier',
          paths: barrier.paths,
          workspaceId: barrier.workspaceId,
        });
      } catch {
        releaseDirtyBarrier(barrier, dirtyBarrierFailure('A document surface could not receive the dirty-state barrier'));
      }
    }
    return {
      close() {
        if (dirtySurfaces.get(key)?.registrationId !== record.registrationId) return;
        dirtySurfaces.delete(key);
        dirtyBuffersByOwner.delete(key);
        for (const barrier of dirtyBarriers.values()) {
          if (!barrier.surfaceKeys.has(key) || barrier.released) continue;
          releaseDirtyBarrier(barrier, dirtyBarrierFailure('A document surface disconnected while the dirty-state barrier was held'));
        }
      },
    };
  };

  const beginDirtyStateBarrier = async (
    workspaceId: string,
    paths: unknown,
    options: BeginDirtyStateBarrierOptions = {},
  ): Promise<DirtyStateBarrierHandle> => {
    if (disposed) {
      throw new DocumentAuthorityError('Document authority is disposed', { code: 'failed', statusCode: 500 });
    }
    await loadWorkspace(workspaceId);
    if (!Array.isArray(paths) || paths.some((entry) => typeof entry !== 'string' || !entry)) {
      throw new DocumentAuthorityError('Dirty-state barrier paths are malformed', { code: 'failed', statusCode: 400 });
    }
    if (options.caseSensitive !== undefined && typeof options.caseSensitive !== 'boolean') {
      throw new DocumentAuthorityError('Dirty-state barrier path comparison is malformed', { code: 'failed', statusCode: 400 });
    }
    if (!Number.isSafeInteger(dirtyBarrierTimeoutMs) || dirtyBarrierTimeoutMs <= 0) {
      throw new DocumentAuthorityError('Dirty-state barrier timeout is malformed', { code: 'failed', statusCode: 500 });
    }
    const barrierId = randomUUID();
    const surfaces = [...dirtySurfaces.values()].filter((surface) => surface.workspaceId === workspaceId);
    const barrier: DirtyBarrier = {
      barrierId,
      caseSensitive: options.caseSensitive ?? platform !== 'win32',
      paths: [...new Set(paths as string[])].sort(),
      pending: new Set(surfaces.map((surface) => surface.key)),
      requiredPublications: new Map(surfaces.map((surface) => [surface.key, dirtyPublicationRevision + 1])),
      released: false,
      surfaceKeys: new Set(surfaces.map((surface) => surface.key)),
      timer: null,
      waiters: new Set(),
      workspaceId,
    };
    armDirtyBarrierDeadline(barrier);
    dirtyBarriers.set(barrierId, barrier);
    for (const surface of surfaces) {
      if (barrier.released) break;
      try {
        surface.listener({
          action: 'acquire',
          barrierId,
          caseSensitive: barrier.caseSensitive,
          kind: 'dirty-state-barrier',
          paths: barrier.paths,
          workspaceId,
        });
      } catch {
        releaseDirtyBarrier(barrier, dirtyBarrierFailure('A document surface could not receive the dirty-state barrier'));
      }
    }
    await settleDirtyBarrier(barrier);
    return {
      barrierId,
      async release() {
        releaseDirtyBarrier(barrier);
      },
      settle: () => settleDirtyBarrier(barrier),
    };
  };

  const acknowledgeDirtyStateBarrier = async (request: DirtyStateBarrierAckRequest): Promise<{ acknowledged: boolean }> => {
    if (!request || typeof request.barrierId !== 'string' || !request.barrierId
      || typeof request.ownerId !== 'string' || !request.ownerId
      || typeof request.workspaceId !== 'string' || !request.workspaceId
      || !Number.isSafeInteger(request.generation) || request.generation < 0) {
      throw new DocumentAuthorityError('Dirty-state barrier acknowledgement is malformed', { code: 'failed', statusCode: 400 });
    }
    const barrier = dirtyBarriers.get(request.barrierId);
    if (!barrier || barrier.released || barrier.workspaceId !== request.workspaceId) {
      return { acknowledged: false };
    }
    const key = dirtyBufferKey(request.ownerId, request.workspaceId);
    const surface = dirtySurfaces.get(key);
    const publication = dirtyBuffersByOwner.get(key);
    const requiredPublication = barrier.requiredPublications.get(key) ?? Number.POSITIVE_INFINITY;
    if (!surface || surface.generation !== request.generation || !barrier.pending.has(key)
      || publication?.generation !== request.generation
      || publication.publicationRevision < requiredPublication) {
      return { acknowledged: false };
    }
    barrier.pending.delete(key);
    resolveDirtyBarrierWaiters(barrier);
    return { acknowledged: true };
  };

  const publishDirtyBuffers = async (request: PublishDirtyBuffersRequest): Promise<DirtyBufferPublication> => {
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
        || !(entry as Record<string, unknown>).resource
        || ((entry as Record<string, unknown>).resource as Record<string, unknown>).workspaceId !== request.workspaceId
        || typeof ((entry as Record<string, unknown>).resource as Record<string, unknown>).resourceId !== 'string'
        || !((entry as Record<string, unknown>).resource as Record<string, unknown>).resourceId
        || ((entry as Record<string, unknown>).baseRevision !== null && typeof (entry as Record<string, unknown>).baseRevision !== 'string')
        || !Number.isSafeInteger((entry as Record<string, unknown>).localEditRevision)
        || ((entry as Record<string, unknown>).localEditRevision as number) < 0) {
        throw new DocumentAuthorityError('Dirty buffer resource is malformed', { code: 'failed', statusCode: 400 });
      }
      return {
        baseRevision: (entry as Record<string, unknown>).baseRevision as string | null,
        localEditRevision: (entry as Record<string, unknown>).localEditRevision as number,
        resource: { ...((entry as Record<string, unknown>).resource as DocumentResource) },
      };
    });
    const record: DirtyBufferRecord = {
      generation: request.generation,
      ownerId: request.ownerId,
      publicationRevision: ++dirtyPublicationRevision,
      resources,
      updatedAt: new Date().toISOString(),
      workspaceId: request.workspaceId,
    };
    dirtyBuffersByOwner.set(key, record);
    return publicDirtyBufferRecord(record);
  };

  const clearDirtyBuffers = async (request: ClearDirtyBuffersRequest): Promise<{ cleared: boolean }> => {
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

  const inspectDirtyBuffers = async (workspaceId: string): Promise<DirtyBufferPublication[]> => {
    await loadWorkspace(workspaceId);
    return [...dirtyBuffersByOwner.values()]
      .filter((record) => record.workspaceId === workspaceId)
      .map(publicDirtyBufferRecord)
      .sort((left, right) => left.ownerId.localeCompare(right.ownerId));
  };

  const dispose = (): Promise<void> => {
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
    for (const barrier of [...dirtyBarriers.values()]) {
      releaseDirtyBarrier(barrier, dirtyBarrierFailure('Document authority was disposed during a dirty-state barrier'));
    }
    dirtySurfaces.clear();
    dirtyBuffersByOwner.clear();
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
    listWorkspaceRegistrations: () => registry.list(),
    inspectWorkspace: async (workspaceId: string) => {
      try {
        const workspace = await loadWorkspace(workspaceId);
        const rest = { ...await mutations.inspect(workspaceId) } as Record<string, unknown>;
        delete rest.workspaceId;
        return {
          ...rest,
          workspaceId: workspace.workspaceId,
          hostId,
          root: workspace.root,
        };
      } catch (error) {
        return fail(error);
      }
    },
    resolveScopeId,
    registerWriterForScope,
    runMutationForScope,
    read,
    write,
    move,
    delete: remove,
    watch,
    listRecoveryJournals: (request: RecoveryJournalListRequest) => journals.list(request),
    readRecoveryJournal: (journalId: string) => journals.read(journalId),
    publishDirtyBuffers,
    clearDirtyBuffers,
    inspectDirtyBuffers,
    registerDirtySurface,
    beginDirtyStateBarrier,
    acknowledgeDirtyStateBarrier,
    writeRecoveryJournal: (request: RecoveryJournalWriteRequest) => journalMutation(
      request,
      'document-recovery-journal-write',
      () => journals.write(request),
    ),
    deleteRecoveryJournal: (request: RecoveryJournalDeleteRequest) => journalMutation(
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
    emitWatchOverflow: (workspaceId: string) => {
      const controller = watcherController(workspaceId);
      if (!controller) return false;
      controller.overflow();
      return true;
    },
    reconnectWatch: (workspaceId: string) => watcherController(workspaceId)?.reconnect(),
    emitAuthorityChanged: (workspaceId: string) => watcherController(workspaceId)?.authorityChanged(),
    hasWatch: (workspaceId: string) => Boolean(watcherController(workspaceId)),
  };
};

export type DocumentAuthority = ReturnType<typeof createDocumentAuthority>;
