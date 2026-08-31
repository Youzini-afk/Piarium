import {
  PIARIUM_CORE_SERVICE_VERSION,
  PIARIUM_WORKBENCH_IDE_PROFILE_ID,
  PIARIUM_WORKBENCH_LAYOUT_SERVICE_ID,
  type JsonObject,
  type JsonValue,
} from '@piarium/extension-contract';
import { getRegisteredRuntimeAPIs } from '@/lib/runtime-api/registry';
import { getRuntimeKey, registerRuntimeEndpointSwitchBlocker } from '@piarium/application-client';

const IDE_WORKBENCH_LAYOUT_VERSION = 1 as const;
const WRITE_COALESCE_MS = 250;

export type IdeWorkbenchActivityId = 'explorer' | 'search' | 'git' | 'run' | 'extensions';

/**
 * The secondary sidebar hosts the Agent session only. Notes and todos stay with the Agent profile,
 * and Git diffs open in the editor area, so no second built-in view is needed here. Extension
 * contributions are still preserved in the stack's view IDs, so this stays internal rather than
 * becoming a published vocabulary of one.
 */
type IdeWorkbenchSecondaryId = 'session';

export type PiariumIdeLayoutNode =
  | {
      axis: 'horizontal' | 'vertical';
      children: string[];
      id: string;
      kind: 'split';
      weights: number[];
    }
  | {
      activeViewId?: string;
      id: string;
      kind: 'stack';
      viewIds: string[];
      visible: boolean;
    }
  | { id: string; kind: 'editor-area' };

export interface PiariumIdeLayoutDocument {
  schemaVersion: typeof IDE_WORKBENCH_LAYOUT_VERSION;
  rootId: string;
  nodes: Record<string, PiariumIdeLayoutNode>;
  floating: Array<{ viewId: string; x: number; y: number; width: number; height: number }>;
  activityVisible: boolean;
  statusVisible: boolean;
}

export type IdeWorkbenchLayoutStatus = 'empty' | 'failure' | 'loading' | 'malformed' | 'missing' | 'ready';

export interface IdeWorkbenchLayoutState {
  document: PiariumIdeLayoutDocument;
  dirty: boolean;
  errorMessage: string | null;
  profileId: string;
  providerId: string | null;
  revision: number;
  status: IdeWorkbenchLayoutStatus;
  workspaceId: string;
}

export interface IdeWorkbenchLayoutProjection {
  activity: IdeWorkbenchActivityId;
  activityVisible: boolean;
  bottomPanelVisible: boolean;
  mainWeights: [number, number, number];
  primaryVisible: boolean;
  secondaryVisible: boolean;
  statusVisible: boolean;
}

export const IDE_LAYOUT_NODE_IDS = {
  root: 'ide.root',
  primary: 'ide.primary',
  center: 'ide.center',
  editor: 'ide.editor',
  bottom: 'ide.bottom',
  secondary: 'ide.secondary',
} as const;

const ACTIVITY_VIEW_IDS: IdeWorkbenchActivityId[] = ['explorer', 'search', 'git', 'run', 'extensions'];
const SECONDARY_VIEW_IDS: IdeWorkbenchSecondaryId[] = ['session'];
const RETIRED_SECONDARY_VIEW_IDS = new Set(['agent', 'context', 'fleet', 'recovery']);
const BOTTOM_VIEW_IDS = ['terminal', 'problems', 'output', 'tasks'];

export const DEFAULT_IDE_WORKBENCH_LAYOUT: PiariumIdeLayoutDocument = {
  schemaVersion: IDE_WORKBENCH_LAYOUT_VERSION,
  rootId: IDE_LAYOUT_NODE_IDS.root,
  nodes: {
    [IDE_LAYOUT_NODE_IDS.root]: {
      id: IDE_LAYOUT_NODE_IDS.root,
      kind: 'split',
      axis: 'horizontal',
      children: [IDE_LAYOUT_NODE_IDS.primary, IDE_LAYOUT_NODE_IDS.center, IDE_LAYOUT_NODE_IDS.secondary],
      weights: [0.2, 0.55, 0.25],
    },
    [IDE_LAYOUT_NODE_IDS.primary]: {
      id: IDE_LAYOUT_NODE_IDS.primary,
      kind: 'stack',
      activeViewId: 'explorer',
      viewIds: ACTIVITY_VIEW_IDS,
      visible: true,
    },
    [IDE_LAYOUT_NODE_IDS.center]: {
      id: IDE_LAYOUT_NODE_IDS.center,
      kind: 'split',
      axis: 'vertical',
      children: [IDE_LAYOUT_NODE_IDS.editor, IDE_LAYOUT_NODE_IDS.bottom],
      weights: [0.7, 0.3],
    },
    [IDE_LAYOUT_NODE_IDS.editor]: { id: IDE_LAYOUT_NODE_IDS.editor, kind: 'editor-area' },
    [IDE_LAYOUT_NODE_IDS.bottom]: {
      id: IDE_LAYOUT_NODE_IDS.bottom,
      kind: 'stack',
      activeViewId: 'terminal',
      viewIds: BOTTOM_VIEW_IDS,
      visible: false,
    },
    [IDE_LAYOUT_NODE_IDS.secondary]: {
      id: IDE_LAYOUT_NODE_IDS.secondary,
      kind: 'stack',
      activeViewId: 'session',
      viewIds: SECONDARY_VIEW_IDS,
      visible: true,
    },
  },
  floating: [],
  activityVisible: true,
  statusVisible: true,
};

const cloneDefault = (): PiariumIdeLayoutDocument => structuredClone(DEFAULT_IDE_WORKBENCH_LAYOUT);

const isObject = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

const parseNode = (value: unknown, key: string): PiariumIdeLayoutNode => {
  if (!isObject(value) || value.id !== key || typeof value.kind !== 'string') {
    throw new Error(`Invalid IDE layout node: ${key}`);
  }
  if (value.kind === 'editor-area') return { id: key, kind: 'editor-area' };
  if (value.kind === 'stack') {
    if (!Array.isArray(value.viewIds) || !value.viewIds.every((item) => typeof item === 'string' && item.length > 0)) {
      throw new Error(`Invalid IDE layout stack: ${key}`);
    }
    const viewIds = [...new Set(value.viewIds)];
    if (viewIds.length !== value.viewIds.length || typeof value.visible !== 'boolean') {
      throw new Error(`Invalid IDE layout stack: ${key}`);
    }
    const activeViewId = typeof value.activeViewId === 'string' && viewIds.includes(value.activeViewId)
      ? value.activeViewId
      : undefined;
    return { id: key, kind: 'stack', viewIds, visible: value.visible, ...(activeViewId ? { activeViewId } : {}) };
  }
  if (value.kind === 'split') {
    if (
      (value.axis !== 'horizontal' && value.axis !== 'vertical')
      || !Array.isArray(value.children)
      || value.children.length < 2
      || !value.children.every((item) => typeof item === 'string' && item.length > 0)
      || !Array.isArray(value.weights)
      || value.weights.length !== value.children.length
      || !value.weights.every((item) => finite(item) && item >= 0)
      || value.weights.every((item) => item === 0)
    ) {
      throw new Error(`Invalid IDE layout split: ${key}`);
    }
    return {
      id: key,
      kind: 'split',
      axis: value.axis,
      children: [...value.children],
      weights: [...value.weights],
    };
  }
  throw new Error(`Unknown IDE layout node kind: ${key}`);
};

export const parseIdeWorkbenchLayout = (value: unknown): PiariumIdeLayoutDocument => {
  if (!isObject(value) || value.schemaVersion !== IDE_WORKBENCH_LAYOUT_VERSION) {
    throw new Error('Unsupported IDE layout document');
  }
  if (typeof value.rootId !== 'string' || !isObject(value.nodes) || !Array.isArray(value.floating)) {
    throw new Error('Malformed IDE layout document');
  }
  if (typeof value.activityVisible !== 'boolean' || typeof value.statusVisible !== 'boolean') {
    throw new Error('Malformed IDE layout visibility');
  }
  const nodes = Object.fromEntries(Object.entries(value.nodes).map(([key, node]) => [key, parseNode(node, key)]));
  const secondary = nodes[IDE_LAYOUT_NODE_IDS.secondary];
  if (secondary?.kind === 'stack') {
    const preserved = secondary.viewIds.filter((viewId) => (
      !SECONDARY_VIEW_IDS.includes(viewId as IdeWorkbenchSecondaryId)
      && !RETIRED_SECONDARY_VIEW_IDS.has(viewId)
    ));
    // A retired or unknown active view falls back to the session; a surviving extension view keeps
    // its selection so a package update does not silently reset the user's choice.
    const active = secondary.activeViewId;
    nodes[IDE_LAYOUT_NODE_IDS.secondary] = {
      ...secondary,
      activeViewId: active !== undefined && preserved.includes(active) ? active : 'session',
      viewIds: [...SECONDARY_VIEW_IDS, ...preserved],
    };
  }
  if (!nodes[value.rootId]) throw new Error('IDE layout root is missing');
  for (const node of Object.values(nodes)) {
    if (node.kind === 'split' && node.children.some((child) => !nodes[child])) {
      throw new Error(`IDE layout split ${node.id} references a missing node`);
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error('IDE layout contains a cycle');
    if (visited.has(id)) return;
    visiting.add(id);
    const node = nodes[id];
    if (node?.kind === 'split') node.children.forEach(visit);
    visiting.delete(id);
    visited.add(id);
  };
  visit(value.rootId);
  const floating = value.floating.map((item) => {
    if (!isObject(item) || typeof item.viewId !== 'string' || !['x', 'y', 'width', 'height'].every((key) => finite(item[key]))) {
      throw new Error('Malformed IDE floating view');
    }
    return {
      viewId: item.viewId,
      x: item.x as number,
      y: item.y as number,
      width: item.width as number,
      height: item.height as number,
    };
  });
  return {
    schemaVersion: IDE_WORKBENCH_LAYOUT_VERSION,
    rootId: value.rootId,
    nodes,
    floating,
    activityVisible: value.activityVisible,
    statusVisible: value.statusVisible,
  };
};

const stack = (document: PiariumIdeLayoutDocument, id: string): Extract<PiariumIdeLayoutNode, { kind: 'stack' }> => {
  const node = document.nodes[id];
  if (!node || node.kind !== 'stack') throw new Error(`IDE layout stack is unavailable: ${id}`);
  return node;
};

const split = (document: PiariumIdeLayoutDocument, id: string): Extract<PiariumIdeLayoutNode, { kind: 'split' }> => {
  const node = document.nodes[id];
  if (!node || node.kind !== 'split') throw new Error(`IDE layout split is unavailable: ${id}`);
  return node;
};

export const projectIdeWorkbenchLayout = (document: PiariumIdeLayoutDocument): IdeWorkbenchLayoutProjection => {
  const root = split(document, IDE_LAYOUT_NODE_IDS.root);
  const primary = stack(document, IDE_LAYOUT_NODE_IDS.primary);
  const secondary = stack(document, IDE_LAYOUT_NODE_IDS.secondary);
  const bottom = stack(document, IDE_LAYOUT_NODE_IDS.bottom);
  const weights = root.weights.length === 3 ? root.weights : [0.2, 0.55, 0.25];
  return {
    activity: ACTIVITY_VIEW_IDS.includes(primary.activeViewId as IdeWorkbenchActivityId)
      ? primary.activeViewId as IdeWorkbenchActivityId
      : 'explorer',
    activityVisible: document.activityVisible,
    bottomPanelVisible: bottom.visible,
    mainWeights: [weights[0] ?? 0, weights[1] ?? 1, weights[2] ?? 0],
    primaryVisible: primary.visible,
    secondaryVisible: secondary.visible,
    statusVisible: document.statusVisible,
  };
};

type StoredLayoutSnapshot = {
  authoritative: boolean;
  document: { data: unknown; revision: number; schemaVersion: number; updatedAt: string };
  exists: boolean;
  storageState: 'missing' | 'ready' | 'stale';
};

interface LayoutRecord extends IdeWorkbenchLayoutState {
  key: string;
  localRevision: number;
  providerSignature: string;
  writeTimer: ReturnType<typeof setTimeout> | null;
  writeQueue: Promise<void>;
}

const records = new Map<string, LayoutRecord>();
const listeners = new Set<() => void>();
const loadGenerations = new Map<string, number>();

const emit = (): void => {
  for (const listener of listeners) listener();
};

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const subscribeIdeWorkbenchLayout = subscribe;

const recordKey = (workspaceId: string, profileId = PIARIUM_WORKBENCH_IDE_PROFILE_ID): string => (
  `${getRuntimeKey()}\0${profileId}\0${workspaceId}`
);

const emptyRecord = (workspaceId: string, profileId = PIARIUM_WORKBENCH_IDE_PROFILE_ID): LayoutRecord => ({
  document: cloneDefault(),
  dirty: false,
  errorMessage: null,
  key: recordKey(workspaceId, profileId),
  localRevision: 0,
  profileId,
  providerId: null,
  providerSignature: '',
  revision: 0,
  status: 'loading',
  workspaceId,
  writeQueue: Promise.resolve(),
  writeTimer: null,
});

const getRecord = (workspaceId: string): LayoutRecord => {
  const key = recordKey(workspaceId);
  const current = records.get(key);
  if (current) return current;
  const created = emptyRecord(workspaceId);
  records.set(key, created);
  return created;
};

export const peekIdeWorkbenchLayout = (workspaceId: string | undefined): IdeWorkbenchLayoutState | undefined => (
  workspaceId ? getRecord(workspaceId) : undefined
);

const parseStoredSnapshot = (value: JsonValue): StoredLayoutSnapshot => {
  if (!isObject(value) || value.authoritative !== true || !isObject(value.document)) {
    throw new Error('Workbench layout service returned an invalid snapshot');
  }
  const document = value.document;
  if (
    typeof value.exists !== 'boolean'
    || (value.storageState !== 'missing' && value.storageState !== 'ready' && value.storageState !== 'stale')
    || !Number.isSafeInteger(document.revision)
    || typeof document.schemaVersion !== 'number'
    || typeof document.updatedAt !== 'string'
  ) throw new Error('Workbench layout service returned an invalid document');
  return {
    authoritative: true,
    document: {
      data: document.data,
      revision: document.revision as number,
      schemaVersion: document.schemaVersion,
      updatedAt: document.updatedAt,
    },
    exists: value.exists,
    storageState: value.storageState,
  };
};

const invoke = async (record: LayoutRecord, method: 'read' | 'write', input: JsonObject): Promise<StoredLayoutSnapshot> => {
  const extensions = getRegisteredRuntimeAPIs()?.extensions;
  if (!extensions || !record.providerId) throw new Error('Workbench layout service is unavailable');
  const value = await extensions.invokeService({
    args: [input],
    method,
    providerId: record.providerId,
    serviceId: PIARIUM_WORKBENCH_LAYOUT_SERVICE_ID,
    version: PIARIUM_CORE_SERVICE_VERSION,
  });
  return parseStoredSnapshot(value);
};

const acceptStored = (record: LayoutRecord, stored: StoredLayoutSnapshot): LayoutRecord => {
  if (!stored.exists) {
    return { ...record, document: cloneDefault(), dirty: false, errorMessage: null, revision: 0, status: 'missing' };
  }
  if (!isObject(stored.document.data) || Object.keys(stored.document.data).length === 0) {
    return { ...record, document: cloneDefault(), dirty: false, errorMessage: null, revision: stored.document.revision, status: 'empty' };
  }
  try {
    return {
      ...record,
      document: parseIdeWorkbenchLayout(stored.document.data),
      dirty: false,
      errorMessage: null,
      revision: stored.document.revision,
      status: 'ready',
    };
  } catch (error) {
    return {
      ...record,
      errorMessage: error instanceof Error ? error.message : String(error),
      revision: stored.document.revision,
      status: 'malformed',
    };
  }
};

const load = async (workspaceId: string, providerId: string, providerSignature: string): Promise<void> => {
  const key = recordKey(workspaceId);
  const previous = getRecord(workspaceId);
  if (previous.providerSignature === providerSignature && !['failure', 'malformed'].includes(previous.status)) return;
  if (previous.dirty) {
    records.set(key, {
      ...previous,
      providerId,
      providerSignature,
      errorMessage: previous.providerSignature && previous.providerSignature !== providerSignature
        ? 'Workbench layout Host changed before pending changes were saved'
        : previous.errorMessage,
    });
    emit();
    if (!previous.providerSignature || previous.providerSignature === providerSignature) scheduleWrite(key);
    return;
  }
  const generation = (loadGenerations.get(key) ?? 0) + 1;
  loadGenerations.set(key, generation);
  const loading: LayoutRecord = {
    ...previous,
    errorMessage: null,
    providerId,
    providerSignature,
    status: 'loading',
  };
  records.set(key, loading);
  emit();
  try {
    const stored = await invoke(loading, 'read', {
      profileId: loading.profileId,
      workspaceId,
    });
    if (generation !== loadGenerations.get(key) || records.get(key)?.providerSignature !== providerSignature) return;
    records.set(key, acceptStored(records.get(key) ?? loading, stored));
  } catch (error) {
    if (generation !== loadGenerations.get(key) || records.get(key)?.providerSignature !== providerSignature) return;
    records.set(key, {
      ...(records.get(key) ?? loading),
      errorMessage: error instanceof Error ? error.message : String(error),
      status: 'failure',
    });
  }
  emit();
};

export const retryIdeWorkbenchLayout = (workspaceId: string): void => {
  const record = getRecord(workspaceId);
  if (!record.providerId || !record.providerSignature) return;
  if (record.dirty) {
    void queueWrite(record.key).catch(() => undefined);
    return;
  }
  void load(workspaceId, record.providerId, record.providerSignature);
};

const writeRecord = async (key: string): Promise<void> => {
  const current = records.get(key);
  if (!current?.dirty || !['ready', 'missing', 'empty'].includes(current.status)) return;
  const capturedLocalRevision = current.localRevision;
  const stored = await invoke(current, 'write', {
    document: current.document as unknown as JsonObject,
    expectedRevision: current.revision,
    profileId: current.profileId,
    workspaceId: current.workspaceId,
  });
  const latest = records.get(key);
  if (!latest || latest.providerSignature !== current.providerSignature) return;
  const accepted = acceptStored(latest, stored);
  if (latest.localRevision === capturedLocalRevision) {
    records.set(key, accepted);
  } else {
    records.set(key, {
      ...latest,
      errorMessage: null,
      revision: accepted.revision,
      status: 'ready',
    });
    scheduleWrite(key);
  }
  emit();
};

const queueWrite = (key: string): Promise<void> => {
  const record = records.get(key);
  if (!record) return Promise.resolve();
  const queued = record.writeQueue.catch(() => undefined).then(() => writeRecord(key)).catch((error) => {
    const latest = records.get(key);
    if (latest) {
      records.set(key, {
        ...latest,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      emit();
    }
    throw error;
  });
  record.writeQueue = queued;
  return queued;
};

function scheduleWrite(key: string): void {
  const record = records.get(key);
  if (!record) return;
  if (record.writeTimer) clearTimeout(record.writeTimer);
  record.writeTimer = setTimeout(() => {
    const latest = records.get(key);
    if (latest) latest.writeTimer = null;
    void queueWrite(key).catch(() => undefined);
  }, WRITE_COALESCE_MS);
}

export const patchIdeWorkbenchLayout = (
  workspaceId: string,
  update: (document: PiariumIdeLayoutDocument) => PiariumIdeLayoutDocument,
): void => {
  const key = recordKey(workspaceId);
  const current = getRecord(workspaceId);
  if (!['ready', 'missing', 'empty'].includes(current.status)) return;
  const document = parseIdeWorkbenchLayout(update(structuredClone(current.document)));
  records.set(key, {
    ...current,
    document,
    dirty: true,
    errorMessage: null,
    localRevision: current.localRevision + 1,
  });
  emit();
  scheduleWrite(key);
};

export const updateIdeLayoutNode = (
  document: PiariumIdeLayoutDocument,
  node: PiariumIdeLayoutNode,
): PiariumIdeLayoutDocument => ({
  ...document,
  nodes: { ...document.nodes, [node.id]: node },
});

export const flushPersistedIdeWorkbenchLayout = async (workspaceId?: string): Promise<void> => {
  const selected = [...records.entries()].filter(([, record]) => !workspaceId || record.workspaceId === workspaceId);
  await Promise.allSettled(selected.map(async ([key, record]) => {
    if (record.writeTimer) clearTimeout(record.writeTimer);
    record.writeTimer = null;
    await queueWrite(key);
  }));
};

export const setIdeWorkbenchLayoutProvider = (
  workspaceId: string,
  input: { providerId: string; signature: string } | null,
  authoritative: boolean,
): void => {
  if (!input) {
    const record = getRecord(workspaceId);
    const status = authoritative ? 'failure' : 'loading';
    const errorMessage = authoritative ? 'Workbench layout provider is unavailable' : null;
    if (record.status === status && record.errorMessage === errorMessage) return;
    records.set(record.key, { ...record, errorMessage, status });
    emit();
    return;
  }
  void load(workspaceId, input.providerId, input.signature);
};

export const resetIdeWorkbenchLayoutForRuntimeSwitch = (): void => {
  for (const record of records.values()) {
    if (record.writeTimer) clearTimeout(record.writeTimer);
  }
  records.clear();
  loadGenerations.clear();
  emit();
};

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  const flush = () => { void flushPersistedIdeWorkbenchLayout(); };
  window.addEventListener('pagehide', flush, { capture: true });
  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flush();
    });
    document.addEventListener('freeze', flush);
  }
  registerRuntimeEndpointSwitchBlocker(() => flushPersistedIdeWorkbenchLayout());
}
