import { createHash, randomUUID } from 'node:crypto';
import type { AgentInputContext } from '@piarium/protocol';

export interface SurfaceSnapshotResource {
  baseRevision: string | null;
  encoding: string;
  bom: boolean;
  content: string;
  localEditRevision: number;
  resource: { workspaceId: string; resourceId: string };
  /** Editor-normalized buffer identity (`sha256-` + hex). Not a hash of serialized file text. */
  bufferHash?: string;
  lineEnding?: 'lf' | 'crlf' | 'cr';
}

interface StoredContent {
  content: string;
  references: number;
}

interface StoredResource extends Omit<SurfaceSnapshotResource, 'content'> {
  contentHash: string;
}

interface StoredSnapshot {
  dirtyPaths: readonly string[];
  ownerId: string;
  ownerGeneration: number;
  ref: string;
  resources: Map<string, StoredResource>;
  sessionId: string;
  state: 'active' | 'pending';
  /**
   * Paths whose captured draft has been replaced by an observed write. The
   * fixed draft is this turn's input; once something writes that path, disk
   * holds the newer text and the draft must stop answering for it (D-088).
   */
  superseded: Set<string>;
  invalidated: Set<string>;
  workspaceId: string;
}

export type SurfaceSnapshotReadResult =
  | { status: 'disk'; superseded?: true }
  | { status: 'ready'; bom: boolean; content: string; encoding: string; revision: string; source: 'surface-draft' }
  | { status: 'unavailable'; message: string };

export type SurfaceSnapshotInspectResult =
  | { status: 'disk'; superseded?: true }
  | { status: 'unavailable'; message: string }
  | {
      status: 'ready';
      bom: boolean;
      content: string;
      encoding: string;
      localEditRevision: number;
      baseRevision: string | null;
      revision: string;
      resource: { workspaceId: string; resourceId: string };
      source: 'surface-draft';
      bufferHash?: string;
      lineEnding?: 'lf' | 'crlf' | 'cr';
    };

export interface SurfaceSnapshotOverlayEntry {
  path: string;
  kind: 'file' | 'directory';
  revision?: string;
}

export type SurfaceSnapshotOverlayResult =
  | { status: 'disk' }
  | { status: 'ready'; entries: SurfaceSnapshotOverlayEntry[] }
  | { status: 'unavailable'; message: string };

export type SurfaceSnapshotCloneResult =
  | { status: 'disk' }
  | {
      status: 'ready';
      resources: Array<SurfaceSnapshotResource & { revision: string }>;
      /** Dirty paths a write already superseded; disk is their newer baseline. */
      supersededPaths: string[];
      workspaceId: string;
    }
  | { status: 'unavailable'; message: string };

const contentHash = (content: string): string => createHash('sha256').update(content, 'utf8').digest('hex');

export interface SurfaceSnapshotStoreOptions {
  caseSensitive?: boolean;
}

export const createSurfaceSnapshotStore = (options: SurfaceSnapshotStoreOptions = {}) => {
  const caseSensitive = options.caseSensitive ?? process.platform !== 'win32';
  const pathKey = (value: string): string => caseSensitive ? value : value.toLowerCase();
  const normalizeResourceId = (value: string): string => {
    const normalized = value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
    return normalized === '.' ? '' : normalized;
  };
  const isWithin = (resourceId: string, root: string): boolean => {
    const resourceKey = pathKey(normalizeResourceId(resourceId));
    const rootKey = pathKey(normalizeResourceId(root));
    return !rootKey || resourceKey === rootKey || resourceKey.startsWith(`${rootKey}/`);
  };
  const samePaths = (left: readonly string[], right: readonly string[]): boolean => {
    const leftKeys = left.map(pathKey).sort();
    const rightKeys = right.map(pathKey).sort();
    return leftKeys.length === rightKeys.length && leftKeys.every((entry, index) => entry === rightKeys[index]);
  };
  const contents = new Map<string, StoredContent>();
  const snapshots = new Map<string, StoredSnapshot>();
  const pendingBySession = new Map<string, Set<string>>();
  const activeBySession = new Map<string, string>();

  const releaseStored = (snapshot: StoredSnapshot): void => {
    if (snapshots.get(snapshot.ref) !== snapshot) return;
    snapshots.delete(snapshot.ref);
    pendingBySession.get(snapshot.sessionId)?.delete(snapshot.ref);
    if (pendingBySession.get(snapshot.sessionId)?.size === 0) pendingBySession.delete(snapshot.sessionId);
    if (activeBySession.get(snapshot.sessionId) === snapshot.ref) activeBySession.delete(snapshot.sessionId);
    for (const resource of snapshot.resources.values()) {
      const stored = contents.get(resource.contentHash);
      if (!stored) continue;
      stored.references -= 1;
      if (stored.references === 0) contents.delete(resource.contentHash);
    }
  };

  const capture = (input: {
    ownerId: string;
    ownerGeneration?: number;
    resources: readonly SurfaceSnapshotResource[];
    sessionId: string;
    workspaceId: string;
  }): AgentInputContext => {
    const ref = randomUUID();
    const resources = new Map<string, StoredResource>();
    for (const resource of input.resources) {
      const hash = contentHash(resource.content);
      const stored = contents.get(hash);
      if (stored) stored.references += 1;
      else contents.set(hash, { content: resource.content, references: 1 });
      resources.set(pathKey(resource.resource.resourceId), Object.freeze({
        baseRevision: resource.baseRevision,
        encoding: resource.encoding,
        bom: resource.bom,
        contentHash: hash,
        localEditRevision: resource.localEditRevision,
        resource: Object.freeze({ ...resource.resource }),
        ...(resource.bufferHash === undefined ? {} : { bufferHash: resource.bufferHash }),
        ...(resource.lineEnding === undefined ? {} : { lineEnding: resource.lineEnding }),
      }));
    }
    const dirtyPaths = Object.freeze([...resources.values()]
      .map((resource) => resource.resource.resourceId)
      .sort());
    const snapshot: StoredSnapshot = Object.freeze({
      dirtyPaths,
      ownerId: input.ownerId,
      ownerGeneration: input.ownerGeneration ?? 0,
      ref,
      resources,
      sessionId: input.sessionId,
      state: 'pending',
      superseded: new Set<string>(),
      invalidated: new Set<string>(),
      workspaceId: input.workspaceId,
    });
    snapshots.set(ref, snapshot);
    const pending = pendingBySession.get(input.sessionId) ?? new Set<string>();
    pending.add(ref);
    pendingBySession.set(input.sessionId, pending);
    return {
      source: 'surface',
      workspaceId: input.workspaceId,
      dirtyPaths: [...dirtyPaths],
      snapshot: { status: 'ready', ref },
    };
  };

  /**
   * Record that something wrote this path. Every snapshot captured before the
   * write stops serving its draft for it, so a later read, search, enumeration
   * or language answer sees the text that is now on disk — including the
   * agent's own write. Snapshots captured after the write keep their draft,
   * because that draft is what the user had on screen at that point.
   *
   * Only Host-observed writes reach this hook: Documents-mediated writes and
   * the Pi mutation journal. A shell or external write stays uncovered, the
   * same boundary the recovery journal reports.
   */
  const observeWrite = (workspaceId: string, resourceId: string): void => {
    const written = pathKey(normalizeResourceId(resourceId));
    if (!written) return;
    for (const snapshot of snapshots.values()) {
      if (snapshot.workspaceId !== workspaceId) continue;
      for (const [key, resource] of snapshot.resources) {
        if (snapshot.superseded.has(key)) continue;
        if (pathKey(normalizeResourceId(resource.resource.resourceId)) === written) {
          snapshot.superseded.add(key);
        }
      }
    }
  };

  const applyOwnerEdit = (input: {
    ownerId: string;
    ownerGeneration: number;
    workspaceId: string;
    resourceId: string;
    expectedBaseRevision: string | null;
    expectedLocalEditRevision: number;
    nextLocalEditRevision: number;
    content: string;
    encoding: string;
    bom: boolean;
    bufferHash?: string;
    lineEnding?: 'lf' | 'crlf' | 'cr';
  }): void => {
    const key = pathKey(input.resourceId);
    const hash = contentHash(input.content);
    for (const snapshot of snapshots.values()) {
      if (snapshot.ownerId !== input.ownerId || snapshot.ownerGeneration !== input.ownerGeneration
        || snapshot.workspaceId !== input.workspaceId || snapshot.superseded.has(key)) continue;
      const resource = snapshot.resources.get(key);
      if (!resource) continue;
      if (resource.baseRevision !== input.expectedBaseRevision
        || resource.localEditRevision !== input.expectedLocalEditRevision) {
        snapshot.invalidated.add(key);
        continue;
      }
      const previous = contents.get(resource.contentHash);
      if (previous) {
        previous.references -= 1;
        if (previous.references === 0) contents.delete(resource.contentHash);
      }
      const existing = contents.get(hash);
      if (existing) existing.references += 1;
      else contents.set(hash, { content: input.content, references: 1 });
      snapshot.resources.set(key, Object.freeze({
        ...resource,
        contentHash: hash,
        localEditRevision: input.nextLocalEditRevision,
        encoding: input.encoding,
        bom: input.bom,
        ...(input.bufferHash === undefined ? {} : { bufferHash: input.bufferHash }),
        ...(input.lineEnding === undefined ? {} : { lineEnding: input.lineEnding }),
      }));
      snapshot.invalidated.delete(key);
    }
  };

  const invalidateOwnerEdit = (input: {
    ownerId: string;
    ownerGeneration: number;
    workspaceId: string;
    resourceIds: readonly string[];
  }): void => {
    const keys = new Set(input.resourceIds.map(pathKey));
    for (const snapshot of snapshots.values()) {
      if (snapshot.ownerId !== input.ownerId || snapshot.ownerGeneration !== input.ownerGeneration
        || snapshot.workspaceId !== input.workspaceId) continue;
      for (const key of keys) {
        if (snapshot.resources.has(key) && !snapshot.superseded.has(key)) snapshot.invalidated.add(key);
      }
    }
  };

  const resolveReady = (sessionId: string, context: AgentInputContext): StoredSnapshot | null => {
    if (context.source !== 'surface' || context.snapshot.status !== 'ready') return null;
    const snapshot = snapshots.get(context.snapshot.ref);
    if (!snapshot || snapshot.sessionId !== sessionId || snapshot.workspaceId !== context.workspaceId) return null;
    return samePaths(snapshot.dirtyPaths, context.dirtyPaths) ? snapshot : null;
  };

  const commit = (sessionId: string, context: AgentInputContext): { committed: boolean } => {
    const previousRef = activeBySession.get(sessionId);
    let nextRef: string | undefined;
    if (context.source === 'surface' && context.snapshot.status === 'ready') {
      const snapshot = resolveReady(sessionId, context);
      if (!snapshot) return { committed: false };
      const active: StoredSnapshot = Object.freeze({ ...snapshot, state: 'active' });
      snapshots.set(snapshot.ref, active);
      pendingBySession.get(sessionId)?.delete(snapshot.ref);
      if (pendingBySession.get(sessionId)?.size === 0) pendingBySession.delete(sessionId);
      activeBySession.set(sessionId, snapshot.ref);
      nextRef = snapshot.ref;
    }
    if (previousRef && previousRef !== nextRef) {
      const previous = snapshots.get(previousRef);
      if (previous) releaseStored(previous);
    }
    if (nextRef === undefined) activeBySession.delete(sessionId);
    return { committed: true };
  };

  const release = (sessionId: string, context: AgentInputContext): { released: boolean } => {
    const snapshot = resolveReady(sessionId, context);
    if (!snapshot || snapshot.state !== 'pending') return { released: false };
    releaseStored(snapshot);
    return { released: true };
  };

  const read = (sessionId: string, context: AgentInputContext, resourceId: string): SurfaceSnapshotReadResult => {
    if (context.source === 'disk') return { status: 'disk' };
    const dirty = context.dirtyPaths.some((path) => pathKey(path) === pathKey(resourceId));
    if (context.snapshot.status === 'unavailable') {
      return dirty
        ? { status: 'unavailable', message: 'The editor source snapshot is unavailable for this dirty document.' }
        : { status: 'disk' };
    }
    const snapshot = resolveReady(sessionId, context);
    if (!snapshot) {
      return dirty
        ? { status: 'unavailable', message: 'The editor source snapshot expired on the application host.' }
        : { status: 'disk' };
    }
    const resource = snapshot.resources.get(pathKey(resourceId));
    if (!resource) return { status: 'disk' };
    if (snapshot.superseded.has(pathKey(resourceId))) return { status: 'disk', superseded: true };
    if (snapshot.invalidated.has(pathKey(resourceId))) {
      return { status: 'unavailable', message: 'The editor source changed during a Host surface operation.' };
    }
    const content = contents.get(resource.contentHash)?.content;
    if (content === undefined) {
      return { status: 'unavailable', message: 'The editor source snapshot expired on the application host.' };
    }
    return {
      status: 'ready',
      bom: resource.bom,
      content,
      encoding: resource.encoding,
      revision: `surface-draft:${snapshot.ref}:${resource.localEditRevision}`,
      source: 'surface-draft',
    };
  };

  const inspect = (
    sessionId: string,
    context: AgentInputContext,
    resourceId: string,
  ): SurfaceSnapshotInspectResult => {
    const draft = read(sessionId, context, resourceId);
    if (draft.status !== 'ready') return draft;
    const snapshot = resolveReady(sessionId, context);
    const resource = snapshot?.resources.get(pathKey(resourceId));
    if (!snapshot || !resource) {
      return { status: 'unavailable', message: 'The editor source snapshot expired on the application host.' };
    }
    return {
      status: 'ready',
      bom: resource.bom,
      content: draft.content,
      encoding: resource.encoding,
      localEditRevision: resource.localEditRevision,
      baseRevision: resource.baseRevision,
      revision: draft.revision,
      resource: { ...resource.resource },
      source: 'surface-draft',
      ...(resource.bufferHash === undefined ? {} : { bufferHash: resource.bufferHash }),
      ...(resource.lineEnding === undefined ? {} : { lineEnding: resource.lineEnding }),
    };
  };

  const clone = (sessionId: string, context: AgentInputContext): SurfaceSnapshotCloneResult => {
    if (context.source === 'disk') return { status: 'disk' };
    if (context.snapshot.status === 'unavailable') {
      return { status: 'unavailable', message: 'The editor source snapshot is unavailable.' };
    }
    const snapshot = resolveReady(sessionId, context);
    if (!snapshot) return { status: 'unavailable', message: 'The editor source snapshot expired on the application host.' };
    const resources: Array<SurfaceSnapshotResource & { revision: string }> = [];
    const supersededPaths: string[] = [];
    for (const resourceId of snapshot.dirtyPaths) {
      // A superseded path already has its newer text on disk, which the child
      // materializes anyway; overlaying the stale draft would undo the write.
      if (snapshot.superseded.has(pathKey(resourceId))) {
        supersededPaths.push(resourceId);
        continue;
      }
      if (snapshot.invalidated.has(pathKey(resourceId))) {
        return { status: 'unavailable', message: 'The editor source changed during a Host surface operation.' };
      }
      const resource = snapshot.resources.get(pathKey(resourceId));
      const content = resource ? contents.get(resource.contentHash)?.content : undefined;
      if (!resource || content === undefined) {
        return { status: 'unavailable', message: 'The editor source snapshot expired on the application host.' };
      }
      resources.push({
        baseRevision: resource.baseRevision,
        encoding: resource.encoding,
        bom: resource.bom,
        content,
        localEditRevision: resource.localEditRevision,
        resource: { ...resource.resource },
        revision: `surface-draft:${snapshot.ref}:${resource.localEditRevision}`,
        ...(resource.bufferHash === undefined ? {} : { bufferHash: resource.bufferHash }),
        ...(resource.lineEnding === undefined ? {} : { lineEnding: resource.lineEnding }),
      });
    }
    return { status: 'ready', resources, supersededPaths, workspaceId: snapshot.workspaceId };
  };

  /**
   * Dirty paths this turn's fixed source still owns: the ones it can serve plus
   * the ones it must refuse. A superseded path is not in the set, so callers
   * search and enumerate it on disk like any other file, while an expired
   * capture keeps every dirty path here and never becomes a silent disk read.
   */
  const draftPaths = (sessionId: string, context: AgentInputContext): string[] => {
    if (context.source === 'disk') return [];
    if (context.snapshot.status === 'unavailable') return [...context.dirtyPaths];
    const snapshot = resolveReady(sessionId, context);
    if (!snapshot) return [...context.dirtyPaths];
    return snapshot.dirtyPaths.filter((resourceId) => !snapshot.superseded.has(pathKey(resourceId)));
  };

  const owner = (sessionId: string, context: AgentInputContext): { ownerId: string; generation: number; workspaceId: string } | null => {
    const snapshot = resolveReady(sessionId, context);
    return snapshot ? { ownerId: snapshot.ownerId, generation: snapshot.ownerGeneration, workspaceId: snapshot.workspaceId } : null;
  };

  /**
   * Return a content-free fixed path view for native find/ls wrappers. A
   * request outside the dirty set remains a disk operation; a related request
   * never falls back to disk when its immutable snapshot is unavailable.
   */
  const overlay = (
    sessionId: string,
    context: AgentInputContext,
    root: string,
  ): SurfaceSnapshotOverlayResult => {
    if (context.source === 'disk') return { status: 'disk' };
    const normalizedRoot = normalizeResourceId(root);
    const contextHasRelatedDirtyPath = context.dirtyPaths.some((path) => isWithin(path, normalizedRoot));
    if (context.snapshot.status === 'unavailable') {
      return contextHasRelatedDirtyPath
        ? { status: 'unavailable', message: 'The editor source snapshot is unavailable.' }
        : { status: 'disk' };
    }
    const snapshot = resolveReady(sessionId, context);
    if (!snapshot) {
      return contextHasRelatedDirtyPath
        ? { status: 'unavailable', message: 'The editor source snapshot expired on the application host.' }
        : { status: 'disk' };
    }
    const dirtyPaths = snapshot.dirtyPaths
      .filter((resourceId) => !snapshot.superseded.has(pathKey(resourceId)))
      .map(normalizeResourceId)
      .filter((resourceId) => isWithin(resourceId, normalizedRoot));
    if (dirtyPaths.length === 0) return { status: 'disk' };
    if (dirtyPaths.some((resourceId) => snapshot.invalidated.has(pathKey(resourceId)))) {
      return { status: 'unavailable', message: 'The editor source changed during a Host surface operation.' };
    }
    const files = dirtyPaths
      .map((resourceId) => {
        const resource = snapshot.resources.get(pathKey(resourceId));
        const content = resource ? contents.get(resource.contentHash)?.content : undefined;
        if (!resource || content === undefined) return null;
        return {
          // Overlay paths are relative to the authorized request root. This
          // keeps a canonical or symlinked root independent from pi-host cwd.
          path: normalizedRoot
            ? resourceId.slice(normalizedRoot.length + 1) || '.'
            : resourceId || '.',
          kind: 'file' as const,
          revision: `surface-draft:${snapshot.ref}:${resource.localEditRevision}`,
        };
      });
    if (files.some((entry) => entry === null)) {
      return { status: 'unavailable', message: 'The editor source snapshot expired on the application host.' };
    }
    const entries = files.filter((entry): entry is NonNullable<typeof entry> => entry !== null);
    const directories = new Map<string, SurfaceSnapshotOverlayEntry>();
    for (const file of entries) {
      const relative = file.path === '.' ? '' : file.path;
      const parts = relative.split('/').filter(Boolean);
      for (let index = 1; index < parts.length; index += 1) {
        const directory = parts.slice(0, index).join('/');
        directories.set(pathKey(directory), { path: directory, kind: 'directory' });
      }
      // A dirty path below the request root makes that root itself virtual.
      if (parts.length > 0) {
        directories.set(pathKey('.'), { path: '.', kind: 'directory' });
      }
    }
    return {
      status: 'ready',
      entries: [...entries, ...directories.values()].sort((left, right) => (
        pathKey(left.path).localeCompare(pathKey(right.path))
        || left.kind.localeCompare(right.kind)
      )),
    };
  };

  const dropSession = (sessionId: string): void => {
    const refs = new Set<string>(pendingBySession.get(sessionId) ?? []);
    const active = activeBySession.get(sessionId);
    if (active) refs.add(active);
    for (const ref of refs) {
      const snapshot = snapshots.get(ref);
      if (snapshot) releaseStored(snapshot);
    }
    pendingBySession.delete(sessionId);
    activeBySession.delete(sessionId);
  };

  const dropPendingOwner = (ownerId: string, workspaceId: string): void => {
    for (const snapshot of [...snapshots.values()]) {
      if (snapshot.state === 'pending' && snapshot.ownerId === ownerId && snapshot.workspaceId === workspaceId) {
        releaseStored(snapshot);
      }
    }
  };

  const dispose = (): void => {
    snapshots.clear();
    contents.clear();
    pendingBySession.clear();
    activeBySession.clear();
  };

  return {
    applyOwnerEdit,
    capture,
    clone,
    commit,
    dispose,
    draftPaths,
    dropPendingOwner,
    dropSession,
    inspect,
    invalidateOwnerEdit,
    observeWrite,
    overlay,
    owner,
    read,
    release,
  };
};

export type SurfaceSnapshotStore = ReturnType<typeof createSurfaceSnapshotStore>;
