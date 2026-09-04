import type { Thread, ThreadRun } from '@piarium/protocol';

export interface HarnessThreadSnapshot {
  thread: Thread;
  activeRun: ThreadRun | null;
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

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

export const parseHarnessThreadList = (value: unknown): HarnessThreadSnapshot[] => {
  if (!isRecord(value) || !Array.isArray(value.threads)) throw new Error('Malformed thread list response');
  return value.threads.map((item) => {
    if (!isRecord(item) || !isRecord(item.thread)) throw new Error('Malformed thread snapshot');
    const thread = item.thread;
    if (
      typeof thread.id !== 'string'
      || typeof thread.workspaceId !== 'string'
      || typeof thread.eventSeq !== 'number'
      || !isRecord(thread.parent)
      || (thread.parent.kind !== 'session' && thread.parent.kind !== 'thread')
      || typeof thread.parent.id !== 'string'
    ) throw new Error('Malformed thread record');
    if (item.activeRun !== null && !isRecord(item.activeRun)) throw new Error('Malformed thread run');
    return { thread: thread as unknown as Thread, activeRun: item.activeRun as ThreadRun | null };
  }).filter((item) => !item.thread.hidden && item.thread.lifecycle !== 'archived');
};
