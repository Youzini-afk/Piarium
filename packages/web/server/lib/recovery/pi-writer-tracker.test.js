import { describe, expect, it, vi } from 'vitest';
import { createPiWorkspaceWriterTracker } from './pi-writer-tracker.js';

const snapshotEvent = ({ isRunning = false } = {}) => ({
  kind: 'host',
  workerId: 'worker-1',
  sessionId: 'session-1',
  envelope: {
    kind: 'event',
    event: 'session.snapshot',
    data: { sessionId: 'session-1', cwd: 'D:/workspace', isRunning },
  },
});

const agentEvent = (type) => ({
  kind: 'host',
  workerId: 'worker-1',
  sessionId: 'session-1',
  envelope: {
    kind: 'event',
    event: 'agent.event',
    data: { sessionId: 'session-1', event: { type } },
  },
});

describe('Pi workspace writer tracker', () => {
  it('uses pre-execution admission as authority and releases on agent settlement', async () => {
    const markMutated = vi.fn(async () => undefined);
    const close = vi.fn(async () => undefined);
    const registerWriterForScope = vi.fn(async () => ({ markMutated, close }));
    const tracker = createPiWorkspaceWriterTracker({ documents: { registerWriterForScope } });

    const lease = await tracker.admit({
      cwd: 'D:/workspace',
      sessionId: 'session-1',
      workerId: 'worker-1',
    });
    expect(registerWriterForScope).toHaveBeenCalledWith(
      'D:/workspace',
      { kind: 'pi-worker', id: 'worker-1' },
      { mode: 'process', purpose: 'pi-session:session-1' },
    );
    expect(lease).toEqual(expect.objectContaining({ close: expect.any(Function) }));
    await tracker.processEvent(snapshotEvent({ isRunning: true }));
    await tracker.processEvent(agentEvent('agent_start'));
    expect(registerWriterForScope).toHaveBeenCalledTimes(1);
    await tracker.processEvent(agentEvent('agent_settled'));
    expect(markMutated).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    await lease.close();
    expect(markMutated).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    await tracker.dispose();
  });

  it('keeps concurrent authoritative leases independent', async () => {
    const markMutated = vi.fn(async () => undefined);
    const close = vi.fn(async () => undefined);
    const registerWriterForScope = vi.fn(async () => ({ markMutated, close }));
    const tracker = createPiWorkspaceWriterTracker({ documents: { registerWriterForScope } });

    const [first, second] = await Promise.all([
      tracker.admit({ cwd: 'D:/workspace', sessionId: 'session-1', workerId: 'worker-1' }),
      tracker.admit({ cwd: 'D:/workspace', sessionId: 'session-1', workerId: 'worker-1' }),
    ]);
    expect(first).not.toBe(second);
    expect(registerWriterForScope).toHaveBeenCalledTimes(1);

    await first.close();
    expect(close).not.toHaveBeenCalled();
    await second.close();
    expect(markMutated).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('does not advance workspace content history when a Pi turn changes no files', async () => {
    const markMutated = vi.fn(async () => undefined);
    const close = vi.fn(async () => undefined);
    const closeWatch = vi.fn();
    const settle = vi.fn(async () => undefined);
    const tracker = createPiWorkspaceWriterTracker({
      documents: {
        registerWriterForScope: vi.fn(async () => ({ markMutated, close })),
        resolveScopeId: vi.fn(async () => 'workspace-1'),
        watch: vi.fn(() => ({
          close: closeWatch,
          ready: Promise.resolve(true),
          settle,
        })),
      },
    });

    const lease = await tracker.admit({
      cwd: 'D:/workspace',
      sessionId: 'session-1',
      workerId: 'worker-1',
    });
    await lease.close();
    await expect(tracker.waitForIdle('worker-1')).resolves.toEqual({
      changedResourceIds: [],
      coverageComplete: true,
      mutationObserved: false,
    });

    expect(settle).toHaveBeenCalledOnce();
    expect(markMutated).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
    expect(closeWatch).toHaveBeenCalledOnce();
  });

  it('advances workspace content history after the watcher observes a Pi change', async () => {
    const markMutated = vi.fn(async () => undefined);
    const close = vi.fn(async () => undefined);
    let onWorkspaceEvent = () => {};
    const tracker = createPiWorkspaceWriterTracker({
      documents: {
        registerWriterForScope: vi.fn(async () => ({ markMutated, close })),
        resolveScopeId: vi.fn(async () => 'workspace-1'),
        watch: vi.fn((_workspaceId, listener) => {
          onWorkspaceEvent = listener;
          return {
            close: vi.fn(),
            ready: Promise.resolve(true),
            settle: vi.fn(async () => undefined),
          };
        }),
      },
    });

    const lease = await tracker.admit({
      cwd: 'D:/workspace',
      sessionId: 'session-1',
      workerId: 'worker-1',
    });
    onWorkspaceEvent({
      kind: 'changed',
      resource: { resourceId: 'src/changed.ts', workspaceId: 'workspace-1' },
    });
    await lease.close();

    expect(markMutated).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    await expect(tracker.waitForIdle('worker-1')).resolves.toEqual({
      changedResourceIds: ['src/changed.ts'],
      coverageComplete: true,
      mutationObserved: true,
    });
  });

  it('falls back from incremental coverage when the workspace watcher resets', async () => {
    let onWorkspaceEvent = () => {};
    const tracker = createPiWorkspaceWriterTracker({
      documents: {
        registerWriterForScope: vi.fn(async () => ({
          close: vi.fn(async () => undefined),
          markMutated: vi.fn(async () => undefined),
        })),
        resolveScopeId: vi.fn(async () => 'workspace-1'),
        watch: vi.fn((_workspaceId, listener) => {
          onWorkspaceEvent = listener;
          return {
            close: vi.fn(),
            ready: Promise.resolve(true),
            settle: vi.fn(async () => undefined),
          };
        }),
      },
    });
    const lease = await tracker.admit({
      cwd: 'D:/workspace',
      sessionId: 'session-1',
      workerId: 'worker-1',
    });
    onWorkspaceEvent({ kind: 'reset', reason: 'overflow' });
    await lease.close();

    await expect(tracker.waitForIdle('worker-1')).resolves.toMatchObject({
      coverageComplete: false,
      mutationObserved: true,
    });
  });

  it('waits for a closing writer before admitting a replacement lease', async () => {
    let finishClose;
    const firstClose = vi.fn(() => new Promise((resolve) => { finishClose = resolve; }));
    const secondClose = vi.fn(async () => undefined);
    const registerWriterForScope = vi.fn()
      .mockResolvedValueOnce({ markMutated: vi.fn(async () => undefined), close: firstClose })
      .mockResolvedValueOnce({ markMutated: vi.fn(async () => undefined), close: secondClose });
    const tracker = createPiWorkspaceWriterTracker({ documents: { registerWriterForScope } });

    const first = await tracker.admit({
      cwd: 'D:/workspace',
      sessionId: 'session-1',
      workerId: 'worker-1',
    });
    const closing = first.close();
    const replacement = tracker.admit({
      cwd: 'D:/workspace',
      sessionId: 'session-1',
      workerId: 'worker-1',
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(registerWriterForScope).toHaveBeenCalledTimes(1);

    finishClose();
    await closing;
    const second = await replacement;
    expect(registerWriterForScope).toHaveBeenCalledTimes(2);
    await second.close();
    expect(secondClose).toHaveBeenCalledTimes(1);
  });

  it('propagates maintenance and stale-epoch refusals as typed runtime failures', async () => {
    for (const [code, currentEpoch] of [['maintenance', 4], ['stale-epoch', 5]]) {
      const denied = Object.assign(new Error(`${code} denied`), {
        code,
        currentEpoch,
        name: 'DocumentAuthorityError',
        statusCode: 409,
      });
      const tracker = createPiWorkspaceWriterTracker({
        documents: { registerWriterForScope: vi.fn(async () => { throw denied; }) },
      });

      await expect(tracker.admit({
        cwd: 'D:/workspace',
        sessionId: 'session-1',
        workerId: `worker-${code}`,
      })).rejects.toMatchObject({
        code,
        details: { currentEpoch },
        name: 'PiRuntimeBrokerError',
        retryable: true,
      });
      await tracker.dispose();
    }
  });

  it('does not invent a writer for a scope outside registered workspaces', async () => {
    const registerWriterForScope = vi.fn(async () => null);
    const tracker = createPiWorkspaceWriterTracker({ documents: { registerWriterForScope } });

    await expect(tracker.admit({
      cwd: 'D:/outside',
      sessionId: 'session-outside',
      workerId: 'worker-outside',
    })).resolves.toBeNull();
    expect(registerWriterForScope).toHaveBeenCalledTimes(1);
    await tracker.dispose();
  });

  it('releases an active writer when its worker exits', async () => {
    const markMutated = vi.fn(async () => undefined);
    const close = vi.fn(async () => undefined);
    const tracker = createPiWorkspaceWriterTracker({
      documents: { registerWriterForScope: vi.fn(async () => ({ markMutated, close })) },
    });
    await tracker.processEvent(snapshotEvent());
    await tracker.processEvent(agentEvent('agent_start'));
    await tracker.processEvent({ kind: 'worker.exit', workerId: 'worker-1' });
    expect(markMutated).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('does not recreate a writer when a worker exits during pending admission', async () => {
    let resolveWriter;
    const markMutated = vi.fn(async () => undefined);
    const close = vi.fn(async () => undefined);
    const registerWriterForScope = vi.fn(() => new Promise((resolve) => { resolveWriter = resolve; }));
    const tracker = createPiWorkspaceWriterTracker({ documents: { registerWriterForScope } });
    const admission = tracker.admit({
      cwd: 'D:/workspace',
      sessionId: 'session-1',
      workerId: 'worker-1',
    });
    const exited = tracker.processEvent({ kind: 'worker.exit', workerId: 'worker-1' });
    resolveWriter({ markMutated, close });

    await expect(admission).rejects.toMatchObject({ code: 'runtime_not_ready', retryable: true });
    await exited;
    expect(registerWriterForScope).toHaveBeenCalledTimes(1);
    expect(markMutated).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('uses agent settlement to release only a fallback writer', async () => {
    const markMutated = vi.fn(async () => undefined);
    const close = vi.fn(async () => undefined);
    const tracker = createPiWorkspaceWriterTracker({
      documents: { registerWriterForScope: vi.fn(async () => ({ markMutated, close })) },
    });

    await tracker.processEvent(snapshotEvent());
    await tracker.processEvent(agentEvent('agent_start'));
    await tracker.processEvent(agentEvent('agent_settled'));
    expect(markMutated).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('releases a pending admitted writer during stop without leaking it', async () => {
    let resolveWriter;
    const markMutated = vi.fn(async () => undefined);
    const close = vi.fn(async () => undefined);
    const registerWriterForScope = vi.fn(() => new Promise((resolve) => { resolveWriter = resolve; }));
    const tracker = createPiWorkspaceWriterTracker({ documents: { registerWriterForScope } });
    const admission = tracker.admit({
      cwd: 'D:/workspace',
      sessionId: 'session-1',
      workerId: 'worker-1',
    });
    const stopping = tracker.dispose();
    resolveWriter({ markMutated, close });

    await expect(admission).rejects.toMatchObject({
      code: 'runtime_not_ready',
      name: 'PiRuntimeBrokerError',
      retryable: true,
    });
    await stopping;
    expect(markMutated).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });
});
