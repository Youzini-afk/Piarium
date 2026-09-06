import { createHash, randomUUID } from 'node:crypto';
import type { AgentInputContext } from '@piarium/protocol';

export interface SurfaceSnapshotResource {
  baseRevision: string | null;
  encoding: string;
  bom: boolean;
  content: string;
  localEditRevision: number;
  resource: { workspaceId: string; resourceId: string };
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
  ref: string;
  resources: ReadonlyMap<string, StoredResource>;
  sessionId: string;
  state: 'active' | 'pending';
  workspaceId: string;
}

export type SurfaceSnapshotReadResult =
  | { status: 'disk' }
  | { status: 'ready'; bom: boolean; content: string; encoding: string; revision: string; source: 'surface-draft' }
  | { status: 'unavailable'; message: string };

export type SurfaceSnapshotCloneResult =
  | { status: 'disk' }
  | { status: 'ready'; resources: Array<SurfaceSnapshotResource & { revision: string }>; workspaceId: string }
  | { status: 'unavailable'; message: string };

const contentHash = (content: string): string => createHash('sha256').update(content, 'utf8').digest('hex');

export interface SurfaceSnapshotStoreOptions {
  caseSensitive?: boolean;
}

export const createSurfaceSnapshotStore = (options: SurfaceSnapshotStoreOptions = {}) => {
  const caseSensitive = options.caseSensitive ?? process.platform !== 'win32';
  const pathKey = (value: string): string => caseSensitive ? value : value.toLowerCase();
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
      }));
    }
    const dirtyPaths = Object.freeze([...resources.values()]
      .map((resource) => resource.resource.resourceId)
      .sort());
    const snapshot: StoredSnapshot = Object.freeze({
      dirtyPaths,
      ownerId: input.ownerId,
      ref,
      resources,
      sessionId: input.sessionId,
      state: 'pending',
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

  const clone = (sessionId: string, context: AgentInputContext): SurfaceSnapshotCloneResult => {
    if (context.source === 'disk') return { status: 'disk' };
    if (context.snapshot.status === 'unavailable') {
      return { status: 'unavailable', message: 'The editor source snapshot is unavailable.' };
    }
    const snapshot = resolveReady(sessionId, context);
    if (!snapshot) return { status: 'unavailable', message: 'The editor source snapshot expired on the application host.' };
    const resources: Array<SurfaceSnapshotResource & { revision: string }> = [];
    for (const resourceId of snapshot.dirtyPaths) {
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
      });
    }
    return { status: 'ready', resources, workspaceId: snapshot.workspaceId };
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

  return { capture, clone, commit, dispose, dropPendingOwner, dropSession, read, release };
};

export type SurfaceSnapshotStore = ReturnType<typeof createSurfaceSnapshotStore>;
