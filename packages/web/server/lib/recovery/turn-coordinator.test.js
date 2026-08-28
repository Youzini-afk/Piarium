import { describe, expect, it, vi } from 'vitest';
import { createRecoveryTurnCoordinator } from './turn-coordinator.js';

const workspaceId = 'workspace-1';

const snapshot = (id, source) => ({
  availability: 'ready',
  byteLength: 1,
  consistency: 'validated',
  coverage: { excludedUnknown: 0, issues: [], knownAbsent: 0, present: 1, unstable: 0 },
  createdAt: '2026-08-28T00:00:00.000Z',
  entryCount: 1,
  id,
  manifestHash: `sha256-${'a'.repeat(64)}`,
  parentSnapshotId: null,
  policyRevision: 'test-v1',
  sequence: id === 'before' ? 1 : 2,
  source,
  workspaceId,
});

const binding = (input, settled = false) => ({
  activeWriterScopes: input.activeWriterScopes,
  executionId: input.executionId,
  provenance: input.provenance,
  runtimeGeneration: input.runtimeGeneration ?? 2,
  runtimeKey: `${input.runtimeGeneration ?? 2}:worker-1`,
  sessionId: input.sessionId ?? 'session-1',
  startedAt: '2026-08-28T00:00:00.000Z',
  status: settled ? 'ready' : 'pending',
  userEntryId: input.userEntryId ?? 'user-1',
  workerId: input.workerId ?? 'worker-1',
  workspaceId,
  ...(input.beforeSnapshotId ? { beforeSnapshotId: input.beforeSnapshotId } : {}),
  ...(input.afterSnapshotId ? { afterSnapshotId: input.afterSnapshotId } : {}),
  ...(input.assistantEntryId ? { assistantEntryId: input.assistantEntryId } : {}),
  ...(input.failure ? { failure: input.failure, status: 'incomplete' } : {}),
  ...(settled ? { settledAt: '2026-08-28T00:00:01.000Z' } : {}),
});

const agentEvent = (executionId, event) => ({
  executionId,
  kind: 'host',
  runtimeGeneration: 2,
  role: 'session',
  sessionId: 'session-1',
  workerId: 'worker-1',
  envelope: { data: { event, sessionId: 'session-1' }, event: 'agent.event', kind: 'event' },
});

describe('recovery turn coordinator', () => {
  it('captures before writer admission, binds stable entries, and captures after writer release', async () => {
    const starts = [];
    const settlements = [];
    const state = {
      activeWriters: [],
      epoch: 1,
      maintenance: false,
      mutationRevision: 1,
      reconciliationRequired: false,
      writerRevision: 1,
    };
    let captureCount = 0;
    const invokeService = vi.fn(async (request) => {
      const input = request.args[0];
      if (request.method === 'captureSnapshot') {
        captureCount += 1;
        return {
          reused: false,
          snapshot: snapshot(captureCount === 1 ? 'before' : 'after', input.source),
          status: 'captured',
          witness: {
            epoch: state.epoch,
            mutationRevision: state.mutationRevision,
            writerRevision: state.writerRevision,
          },
        };
      }
      if (request.method === 'recordTurnStart') {
        starts.push(input);
        return { binding: binding(input), status: 'ready' };
      }
      if (request.method === 'recordTurnSettled') {
        settlements.push(input);
        return { binding: binding({ ...starts.at(-1), ...input }, true), status: 'ready' };
      }
      throw new Error(`Unexpected service method: ${request.method}`);
    });
    let resolveIdle = () => {};
    let idle = Promise.resolve();
    const writerTracker = {
      async admit(request) {
        state.writerRevision += 1;
        state.activeWriters = [{
          owner: { id: request.workerId, kind: 'pi-worker' },
          purpose: 'pi-agent-run',
          writerId: 'writer-1',
        }];
        idle = new Promise((resolve) => { resolveIdle = resolve; });
        return {
          async close() {
            state.mutationRevision += 1;
            state.writerRevision += 1;
            state.activeWriters = [];
            resolveIdle();
          },
        };
      },
      waitForIdle: () => idle,
    };
    const coordinator = createRecoveryTurnCoordinator({
      documents: { inspectMutation: async () => structuredClone(state) },
      getSessionSnapshot: () => ({ workspace: { id: 'legacy-project-id', kind: 'workspace' } }),
      invokeService,
      writerTracker,
    });
    const request = {
      cwd: '/workspace',
      executionId: 'execution-1',
      method: 'agent.prompt',
      phase: 'agent-run',
      runtimeGeneration: 2,
      sessionId: 'session-1',
      workerId: 'worker-1',
      workspace: { authorityId: workspaceId, id: 'project-1', kind: 'workspace' },
    };

    const lease = await coordinator.admit(request);
    await coordinator.processEvent(agentEvent('execution-1', {
      entry: { id: 'user-1', message: { role: 'user' }, type: 'message' },
      leafId: 'user-1',
      turnIndex: 0,
      type: 'entry_appended',
    }));
    await coordinator.processEvent(agentEvent('execution-1', {
      entry: { id: 'assistant-1', message: { role: 'assistant' }, type: 'message' },
      leafId: 'assistant-1',
      turnIndex: 1,
      type: 'entry_appended',
    }));
    await lease.close();
    await coordinator.processEvent(agentEvent('execution-1', {
      leafId: 'assistant-1', turnIndex: 1, type: 'agent_settled',
    }));

    expect(starts).toEqual([expect.objectContaining({ beforeSnapshotId: 'before', userEntryId: 'user-1' })]);
    expect(settlements).toEqual([expect.objectContaining({
      afterSnapshotId: 'after',
      assistantEntryId: 'assistant-1',
      executionId: 'execution-1',
    })]);
    expect(captureCount).toBe(2);
    await coordinator.dispose();
  });

  it('does not claim file bindings for an unbound session', async () => {
    const invokeService = vi.fn();
    const lease = { close: vi.fn(async () => undefined) };
    const writerTracker = {
      admit: vi.fn(async () => lease),
      waitForIdle: vi.fn(async () => undefined),
    };
    const coordinator = createRecoveryTurnCoordinator({
      documents: { inspectMutation: vi.fn() },
      getSessionSnapshot: () => ({ workspace: { kind: 'unbound' } }),
      invokeService,
      writerTracker,
    });
    expect(await coordinator.admit({
      cwd: '/chat',
      executionId: 'unbound',
      method: 'agent.prompt',
      phase: 'agent-run',
      runtimeGeneration: 1,
      sessionId: 'session-chat',
      workerId: 'worker-chat',
    })).toBe(lease);
    expect(invokeService).not.toHaveBeenCalled();
    await coordinator.dispose();
  });
});
