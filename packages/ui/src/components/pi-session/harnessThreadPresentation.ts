import type { Thread, ThreadParent, ThreadRun } from '@piarium/protocol';

export interface HarnessThreadSnapshot {
  thread: Thread;
  activeRun: ThreadRun | null;
}

export interface HarnessThreadProjection {
  workspaceId: string;
  parent: ThreadParent;
  threads: HarnessThreadSnapshot[];
}

export type HarnessThreadState =
  | 'queued'
  | 'starting'
  | 'running'
  | 'waiting'
  | 'stalled'
  | 'looping'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
  | 'merge-ready'
  | 'conflict'
  | 'merged';

export const projectHarnessThreadState = ({ thread, activeRun }: HarnessThreadSnapshot): HarnessThreadState => {
  if (thread.integration === 'merged') return 'merged';
  if (thread.integration === 'conflict') return 'conflict';
  if (thread.lifecycle === 'queued') return 'queued';
  if (thread.attention === 'user' || thread.attention === 'permission') return 'waiting';
  if (thread.attention === 'stalled') return 'stalled';
  if (thread.attention === 'looping') return 'looping';
  if (thread.lifecycle === 'settled') {
    if (activeRun?.outcome === 'failure') return 'failed';
    if (activeRun?.outcome === 'cancelled') return 'cancelled';
    if (activeRun?.outcome === 'lost') return 'interrupted';
    if (thread.integration === 'merge-ready') return 'merge-ready';
    return 'completed';
  }
  if (activeRun?.workerState === 'lost') return 'interrupted';
  if (activeRun?.workerState === 'starting') return 'starting';
  return 'running';
};

export const sameHarnessThreadParent = (left: ThreadParent, right: ThreadParent): boolean => (
  left.kind === right.kind && left.id === right.id
);

export const mergeHarnessThreadSnapshot = (
  current: HarnessThreadSnapshot[],
  incoming: HarnessThreadSnapshot,
): HarnessThreadSnapshot[] => {
  const existing = current.find((entry) => entry.thread.id === incoming.thread.id);
  if (existing && existing.thread.eventSeq > incoming.thread.eventSeq) return current;
  const next = current.filter((entry) => entry.thread.id !== incoming.thread.id);
  if (!incoming.thread.hidden && incoming.thread.lifecycle !== 'archived') next.push(incoming);
  return next.sort((left, right) => right.thread.updatedAt.localeCompare(left.thread.updatedAt));
};

export const harnessThreadsAtEntry = (
  threads: readonly HarnessThreadSnapshot[],
  entryId: string,
): HarnessThreadSnapshot[] => threads.filter(({ thread }) => thread.forkPoint?.entryId === entryId);

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const parseParent = (value: unknown): ThreadParent => {
  if (
    !isRecord(value)
    || (value.kind !== 'session' && value.kind !== 'thread')
    || typeof value.id !== 'string'
  ) throw new Error('Malformed thread parent');
  return value as unknown as ThreadParent;
};

const parseSnapshot = (value: unknown): HarnessThreadSnapshot => {
  if (!isRecord(value) || !isRecord(value.thread)) throw new Error('Malformed thread snapshot');
  const thread = value.thread;
  if (
    typeof thread.id !== 'string'
    || typeof thread.workspaceId !== 'string'
    || typeof thread.eventSeq !== 'number'
    || (thread.kind !== 'discussion' && thread.kind !== 'implementation')
    || !isRecord(thread.manifest)
    || !Array.isArray(thread.manifest.tools)
    || !thread.manifest.tools.every((tool) => typeof tool === 'string')
    || !Array.isArray(thread.manifest.scope)
    || !thread.manifest.scope.every((scope) => typeof scope === 'string')
  ) throw new Error('Malformed thread record');
  parseParent(thread.parent);
  if (
    value.activeRun !== null
    && (
      !isRecord(value.activeRun)
      || typeof value.activeRun.id !== 'string'
      || (value.activeRun.sessionId !== null && typeof value.activeRun.sessionId !== 'string')
    )
  ) throw new Error('Malformed thread run');
  return { thread: thread as unknown as Thread, activeRun: value.activeRun as ThreadRun | null };
};

export const parseHarnessThreadProjection = (value: unknown): HarnessThreadProjection => {
  if (!isRecord(value) || typeof value.workspaceId !== 'string' || !Array.isArray(value.threads)) {
    throw new Error('Malformed thread list response');
  }
  return {
    workspaceId: value.workspaceId,
    parent: parseParent(value.parent),
    threads: value.threads.map(parseSnapshot).filter((item) => !item.thread.hidden && item.thread.lifecycle !== 'archived'),
  };
};

export const parseHarnessThreadList = (value: unknown): HarnessThreadSnapshot[] => (
  parseHarnessThreadProjection(value).threads
);

export const parseHarnessThreadMutation = (value: unknown): HarnessThreadProjection & HarnessThreadSnapshot => {
  if (!isRecord(value) || typeof value.workspaceId !== 'string') throw new Error('Malformed thread mutation response');
  const snapshot = parseSnapshot(value);
  return {
    workspaceId: value.workspaceId,
    parent: parseParent(value.parent),
    threads: [snapshot],
    ...snapshot,
  };
};
