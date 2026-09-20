/**
 * Session settle tracker (D-307 W3.6): observes the real Pi event stream so a
 * scheduled-task run reports its actual outcome instead of the prompt's
 * delivery receipt.
 *
 * Resolution rules:
 * - `agent_settled` → the session finished every queued turn.
 * - `session.closed` / `worker.exit` before settle → the run died waiting.
 * - An aborted final turn (`stopReason: "aborted"`) surfaces as a failed run,
 *   not a success — the prompt was cut off, not completed.
 */

export interface SessionSettleOutcome {
  settled: boolean;
  aborted?: boolean;
  error?: string;
}

interface PendingWaiter {
  resolve: (outcome: SessionSettleOutcome) => void;
  sawRun: boolean;
  aborted: boolean;
}

const recordOf = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};

export function createSessionSettleTracker() {
  const waiters = new Map<string, PendingWaiter>();

  const processEvent = (event: unknown): void => {
    const record = recordOf(event);
    const envelope = recordOf(record.envelope);
    const sessionId = typeof record.sessionId === 'string' && record.sessionId
      ? record.sessionId
      : typeof recordOf(envelope.data).sessionId === 'string'
        ? recordOf(envelope.data).sessionId as string
        : '';
    if (!sessionId) return;
    const waiter = waiters.get(sessionId);
    if (!waiter) return;
    if (record.kind === 'worker.exit' || envelope.event === 'session.closed') {
      waiters.delete(sessionId);
      waiter.resolve({ settled: false, error: 'session ended before the run settled' });
      return;
    }
    if (envelope.kind !== 'event' || envelope.event !== 'agent.event') return;
    const agentEvent = recordOf(envelope.data).event;
    const agentEventRecord = recordOf(agentEvent);
    if (agentEventRecord.type === 'agent_start') {
      waiter.sawRun = true;
      return;
    }
    if (agentEventRecord.type === 'agent_end') {
      // The last assistant message of a cancelled run carries the abort marker.
      const messages = Array.isArray(agentEventRecord.messages) ? agentEventRecord.messages : [];
      const last = recordOf(messages[messages.length - 1]);
      if (last.stopReason === 'aborted') waiter.aborted = true;
      return;
    }
    if (agentEventRecord.type === 'agent_settled') {
      // A settle observed before this task's run started belongs to an earlier
      // turn — keep waiting for the run we actually dispatched.
      if (!waiter.sawRun) return;
      waiters.delete(sessionId);
      waiter.resolve(waiter.aborted
        ? { aborted: true, error: 'the run was aborted before completion', settled: true }
        : { settled: true });
    }
  };

  const waitForSettled = (sessionId: string): Promise<SessionSettleOutcome> => (
    new Promise<SessionSettleOutcome>((resolve) => {
      waiters.set(sessionId, { aborted: false, resolve, sawRun: false });
    })
  );

  const forget = (sessionId: string): void => {
    const waiter = waiters.get(sessionId);
    waiters.delete(sessionId);
    waiter?.resolve({ error: 'settle tracking was dropped', settled: false });
  };

  return { forget, processEvent, waitForSettled };
}

export type SessionSettleTracker = ReturnType<typeof createSessionSettleTracker>;
