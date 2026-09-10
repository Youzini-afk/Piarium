import { describe, expect, test } from 'bun:test';
import type { Thread, ThreadRun } from '@piarium/protocol';
import {
  harnessThreadsAtEntry,
  mergeHarnessThreadSnapshot,
  parseHarnessThreadList,
  parseHarnessThreadMutation,
  parseHarnessThreadSpace,
  projectHarnessThreadState,
} from './harnessThreadPresentation';

const thread = (overrides: Partial<Thread> = {}): Thread => ({
  id: 'thread-1',
  parent: { kind: 'session', id: 'parent-1' },
  workspaceId: 'workspace-1',
  forkPoint: null,
  brief: 'Check the implementation',
  role: 'check',
  model: null,
  manifest: { carryBlocks: true, concurrency: 12, draftBaselineId: null, scope: [], systemPromptFragment: 'Run checks.', tools: ['read', 'bash'], worktree: 'shared' },
  createdBy: 'agent',
  kind: 'implementation',
  worktree: null,
  lifecycle: 'active',
  attention: 'none',
  waitingFor: null,
  integration: 'none',
  diffStats: null,
  report: null,
  activeRunId: 'run-1',
  createdAt: '2026-09-04T00:00:00.000Z',
  updatedAt: '2026-09-04T00:00:00.000Z',
  eventSeq: 1,
  hidden: false,
  ...overrides,
});

const run = (overrides: Partial<ThreadRun> = {}): ThreadRun => ({
  id: 'run-1',
  threadId: 'thread-1',
  attempt: 1,
  runtimeId: 'pi',
  sessionId: 'child-1',
  workerState: 'running',
  outcome: null,
  exitReason: null,
  tokens: { input: 0, output: 0, cacheRead: 0 },
  costUsd: null,
  steps: 0,
  lastToolCall: null,
  startedAt: '2026-09-04T00:00:00.000Z',
  lastActivityAt: '2026-09-04T00:00:00.000Z',
  endedAt: null,
  ...overrides,
});

describe('HarnessThreadsPanel projection', () => {
  test('keeps execution, attention, and integration states distinct', () => {
    expect(projectHarnessThreadState({ thread: thread(), activeRun: run() })).toBe('running');
    expect(projectHarnessThreadState({ thread: thread({ attention: 'user' }), activeRun: run() })).toBe('waiting');
    expect(projectHarnessThreadState({
      thread: thread({ lifecycle: 'settled', integration: 'dirty' }),
      activeRun: run({ workerState: 'exited', outcome: 'success', endedAt: '2026-09-04T00:01:00.000Z' }),
    })).toBe('dirty');
    expect(projectHarnessThreadState({
      thread: thread({ lifecycle: 'settled', integration: 'merge-ready' }),
      activeRun: run({ workerState: 'exited', outcome: 'success', endedAt: '2026-09-04T00:01:00.000Z' }),
    })).toBe('merge-ready');
    expect(projectHarnessThreadState({
      thread: thread({ lifecycle: 'settled', integration: 'conflict' }),
      activeRun: run({ workerState: 'exited', outcome: 'success', endedAt: '2026-09-04T00:01:00.000Z' }),
    })).toBe('conflict');
  });

  test('rejects malformed API responses instead of showing empty success', () => {
    expect(() => parseHarnessThreadList({ threads: [{ thread: { id: 'thread-1' }, activeRun: null }] })).toThrow(/Malformed/);
    const response = {
      workspaceId: 'workspace-1',
      parent: { kind: 'session', id: 'parent-1' },
      threads: [{ thread: thread(), activeRun: run() }],
    };
    expect(parseHarnessThreadList(response)).toHaveLength(1);
    const mutation = parseHarnessThreadMutation({
      ...response,
      thread: thread({ kind: 'discussion' }),
      activeRun: run(),
    });
    expect(mutation.workspaceId).toBe('workspace-1');
    expect(mutation.parent).toEqual({ kind: 'session', id: 'parent-1' });
    expect(mutation.thread.kind).toBe('discussion');
  });

  test('keeps the newest event projection and locates its source-message marker', () => {
    const original = { thread: thread({ forkPoint: { entryId: 'entry-1' }, eventSeq: 2 }), activeRun: run() };
    const stale = { thread: thread({ forkPoint: { entryId: 'entry-1' }, eventSeq: 1, brief: 'stale' }), activeRun: run() };
    expect(mergeHarnessThreadSnapshot([original], stale)).toEqual([original]);
    expect(harnessThreadsAtEntry([original], 'entry-1')).toEqual([original]);
    expect(harnessThreadsAtEntry([original], 'entry-2')).toEqual([]);
  });

  test('keeps archived threads only when the Host list asked for them', () => {
    const archived = { thread: thread({ lifecycle: 'archived' }), activeRun: run({ outcome: 'cancelled', workerState: 'exited' }) };
    expect(projectHarnessThreadState(archived)).toBe('archived');
    expect(mergeHarnessThreadSnapshot([], archived)).toEqual([]);
    expect(mergeHarnessThreadSnapshot([], archived, { includeArchived: true })).toEqual([archived]);
    const hidden = parseHarnessThreadList({
      workspaceId: 'workspace-1',
      parent: { kind: 'session', id: 'parent-1' },
      includeArchived: false,
      threads: [archived],
    });
    expect(hidden).toEqual([]);
    const shown = parseHarnessThreadList({
      workspaceId: 'workspace-1',
      parent: { kind: 'session', id: 'parent-1' },
      includeArchived: true,
      threads: [archived],
    });
    expect(shown).toHaveLength(1);
    const space = parseHarnessThreadSpace({
      workspaceId: 'workspace-1',
      threads: [{
        threadId: 'thread-1',
        materialized: { logicalBytes: 12, allocatedBytes: 16, unknown: false },
        exclusiveObjects: { logicalBytes: 4, allocatedBytes: null, unknown: false },
        sharedObjects: { logicalBytes: 8, allocatedBytes: null, unknown: false },
        reclaimable: false,
        reclaimableLogicalBytes: 0,
        keepReasons: ['User requested keep_worktree'],
      }],
      uniqueObjectLogicalBytes: 12,
      uniqueObjectUnknown: false,
      materializedLogicalBytes: 12,
      freeBytes: 100,
      status: 'ok',
      note: 'logical occupancy',
    });
    expect(space.threads[0]?.keepReasons).toEqual(['User requested keep_worktree']);
    expect(() => parseHarnessThreadSpace({ workspaceId: 'workspace-1', threads: [], status: 'ready' })).toThrow(/Malformed/);
  });
});
