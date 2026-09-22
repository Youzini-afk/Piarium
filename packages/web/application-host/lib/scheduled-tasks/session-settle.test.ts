import { describe, expect, it } from 'vitest';
import { createSessionSettleTracker } from './session-settle.js';

const agentEvent = (sessionId: string, event: Record<string, unknown>) => ({
  envelope: {
    data: { event },
    event: 'agent.event',
    kind: 'event',
  },
  kind: 'host',
  sessionId,
});

const withTimeout = <T>(promise: Promise<T>, ms = 500): Promise<T | 'pending'> =>
  Promise.race([promise, new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), ms))]);

describe('session settle tracker', () => {
  it('resolves when the run settles after agent_start', async () => {
    const tracker = createSessionSettleTracker();
    const pending = tracker.waitForSettled('s-1');
    tracker.processEvent(agentEvent('s-1', { type: 'agent_start' }));
    tracker.processEvent(agentEvent('s-1', { type: 'agent_end', messages: [] }));
    tracker.processEvent(agentEvent('s-1', { type: 'agent_settled' }));
    await expect(pending).resolves.toEqual({ settled: true });
  });

  it('ignores a settle from an earlier turn before this run started', async () => {
    const tracker = createSessionSettleTracker();
    const pending = tracker.waitForSettled('s-1');
    // A settle event for work that predates our dispatch must not resolve us.
    tracker.processEvent(agentEvent('s-1', { type: 'agent_settled' }));
    await expect(withTimeout(pending, 100)).resolves.toBe('pending');
    tracker.processEvent(agentEvent('s-1', { type: 'agent_start' }));
    tracker.processEvent(agentEvent('s-1', { type: 'agent_settled' }));
    await expect(pending).resolves.toEqual({ settled: true });
  });

  it('reports an aborted final turn as a failed run', async () => {
    const tracker = createSessionSettleTracker();
    const pending = tracker.waitForSettled('s-1');
    tracker.processEvent(agentEvent('s-1', { type: 'agent_start' }));
    tracker.processEvent(agentEvent('s-1', {
      messages: [{ role: 'assistant', stopReason: 'aborted' }],
      type: 'agent_end',
    }));
    tracker.processEvent(agentEvent('s-1', { type: 'agent_settled' }));
    const outcome = await pending;
    expect(outcome.settled).toBe(true);
    expect(outcome.aborted).toBe(true);
  });

  it('fails the waiter when the session closes before settling', async () => {
    const tracker = createSessionSettleTracker();
    const pending = tracker.waitForSettled('s-1');
    tracker.processEvent({
      envelope: { data: {}, event: 'session.closed', kind: 'event' },
      kind: 'host',
      sessionId: 's-1',
    });
    const outcome = await pending;
    expect(outcome.settled).toBe(false);
    expect(outcome.error).toMatch(/ended before/);
  });

  it('fails the waiter when the worker exits before settling', async () => {
    const tracker = createSessionSettleTracker();
    const pending = tracker.waitForSettled('s-1');
    tracker.processEvent({ kind: 'worker.exit', sessionId: 's-1', role: 'session' });
    const outcome = await pending;
    expect(outcome.settled).toBe(false);
  });

  it('does not resolve waiters of other sessions', async () => {
    const tracker = createSessionSettleTracker();
    const a = tracker.waitForSettled('s-a');
    const b = tracker.waitForSettled('s-b');
    tracker.processEvent(agentEvent('s-a', { type: 'agent_start' }));
    tracker.processEvent(agentEvent('s-a', { type: 'agent_settled' }));
    await expect(a).resolves.toEqual({ settled: true });
    await expect(withTimeout(b, 100)).resolves.toBe('pending');
    tracker.forget('s-b');
  });
});
