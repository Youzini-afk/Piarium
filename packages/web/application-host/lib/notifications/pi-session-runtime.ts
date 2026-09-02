import type { PiRuntimeBrokerEvent } from '@piarium/runtime-broker';

const SESSION_COOLDOWN_DURATION_MS = 2000;
const SESSION_STATE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

const activeAgentEventTypes = new Set([
  'agent_start',
  'turn_start',
  'message_start',
  'message_update',
  'tool_execution_start',
  'tool_execution_update',
  'compaction_start',
  'summarization_retry_attempt_start',
]);

type SessionPhase = 'busy' | 'cooldown' | 'idle';
type SessionStatus = 'busy' | 'idle' | 'retry';

interface SessionAttentionState {
  isViewed: boolean;
  lastStatusChangeAt: number;
  lastUserMessageAt: number | null;
  needsAttention: boolean;
  status: SessionStatus;
  viewedByClients: Set<string>;
}

interface SessionState {
  lastUpdateAt: number;
  metadata: Record<string, unknown>;
  status: SessionStatus;
}

interface BroadcastEvent extends Record<string, unknown> {
  properties: Record<string, unknown>;
  type: string;
}

export const createPiSessionRuntime = ({ broadcastEvent }: {
  broadcastEvent?: (event: BroadcastEvent) => void;
}) => {
  const activity = new Map<string, { phase: SessionPhase; updatedAt: number }>();
  const cooldownTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const states = new Map<string, SessionState>();
  const attention = new Map<string, SessionAttentionState>();
  let activeSessionCount = 0;

  const attentionState = (sessionId: string): SessionAttentionState => {
    let state = attention.get(sessionId);
    if (!state) {
      state = {
        isViewed: false,
        lastStatusChangeAt: Date.now(),
        lastUserMessageAt: null,
        needsAttention: false,
        status: 'idle',
        viewedByClients: new Set(),
      };
      attention.set(sessionId, state);
    }
    return state;
  };

  const emitStatus = (sessionId: string): void => {
    const state = states.get(sessionId);
    const attentionEntry = attention.get(sessionId);
    broadcastEvent?.({
      type: 'piarium:session-status',
      properties: {
        sessionID: sessionId,
        status: state?.status ?? attentionEntry?.status ?? 'idle',
        timestamp: state?.lastUpdateAt ?? Date.now(),
        metadata: state?.metadata ?? {},
        needsAttention: attentionEntry?.needsAttention ?? false,
      },
    });
  };

  const setActivity = (sessionId: string, phase: SessionPhase): void => {
    if (!sessionId) return;
    const previous = activity.get(sessionId)?.phase ?? 'idle';
    if (previous === phase) return;
    const timer = cooldownTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      cooldownTimers.delete(sessionId);
    }
    if (previous === 'busy' && phase !== 'busy') activeSessionCount = Math.max(0, activeSessionCount - 1);
    if (previous !== 'busy' && phase === 'busy') activeSessionCount += 1;
    activity.set(sessionId, { phase, updatedAt: Date.now() });
    broadcastEvent?.({ type: 'piarium:session-activity', properties: { sessionId, phase } });
    if (phase === 'cooldown') {
      const cooldown = setTimeout(() => {
        cooldownTimers.delete(sessionId);
        setActivity(sessionId, 'idle');
      }, SESSION_COOLDOWN_DURATION_MS);
      cooldown.unref?.();
      cooldownTimers.set(sessionId, cooldown);
    }
  };

  const updateStatus = (sessionId: string, status: SessionStatus, metadata: Record<string, unknown> = {}): void => {
    if (!sessionId) return;
    const now = Date.now();
    const previous = states.get(sessionId);
    states.set(sessionId, {
      status,
      lastUpdateAt: now,
      metadata: { ...(previous?.metadata ?? {}), ...metadata },
    });
    const attentionEntry = attentionState(sessionId);
    const wasWorking = attentionEntry.status === 'busy' || attentionEntry.status === 'retry';
    attentionEntry.status = status;
    attentionEntry.lastStatusChangeAt = now;
    attentionEntry.isViewed = attentionEntry.viewedByClients.size > 0;
    if (wasWorking && status === 'idle' && !attentionEntry.isViewed) attentionEntry.needsAttention = true;
    emitStatus(sessionId);
    setActivity(sessionId, status === 'busy' || status === 'retry' ? 'busy' : 'cooldown');
  };

  const processBrokerEvent = (event: PiRuntimeBrokerEvent): void => {
    if (event?.kind !== 'host' || !event.envelope || event.envelope.kind !== 'event') return;
    const envelope = event.envelope;
    const sessionId = event.sessionId || ('sessionId' in envelope.data ? envelope.data.sessionId : null);
    if (!sessionId) return;
    if (envelope.event === 'session.closed') {
      updateStatus(sessionId, 'idle', { closed: true });
      return;
    }
    if (envelope.event === 'session.snapshot') {
      const snapshot = envelope.data;
      const isWorking = snapshot.isStreaming === true || snapshot.busy === true;
      updateStatus(sessionId, isWorking ? 'busy' : 'idle');
      return;
    }
    if (envelope.event !== 'agent.event') return;
    const agentEvent = envelope.data?.event;
    const type = agentEvent?.type;
    if (activeAgentEventTypes.has(type)) {
      updateStatus(sessionId, 'busy');
    } else if (type === 'auto_retry_start' || type === 'summarization_retry_scheduled') {
      updateStatus(sessionId, 'retry', {
        attempt: agentEvent.attempt,
        message: agentEvent.errorMessage,
        next: typeof agentEvent.delayMs === 'number' ? Date.now() + agentEvent.delayMs : undefined,
      });
    } else if (type === 'agent_end') {
      updateStatus(sessionId, agentEvent.willRetry === true ? 'retry' : 'idle');
    } else if (type === 'agent_settled') {
      updateStatus(sessionId, 'idle');
    }
  };

  const markSessionViewed = (sessionId: string, clientId: string): void => {
    if (!sessionId || !clientId) return;
    const state = attentionState(sessionId);
    state.viewedByClients.add(clientId);
    state.isViewed = true;
    if (state.needsAttention) {
      state.needsAttention = false;
      emitStatus(sessionId);
    }
  };

  const markSessionUnviewed = (sessionId: string, clientId: string): void => {
    const state = attention.get(sessionId);
    if (!state || !clientId) return;
    state.viewedByClients.delete(clientId);
    state.isViewed = state.viewedByClients.size > 0;
  };

  const markUserMessageSent = (sessionId: string): void => {
    if (!sessionId) return;
    attentionState(sessionId).lastUserMessageAt = Date.now();
  };

  const getSessionActivitySnapshot = () => Object.fromEntries(
    [...activity].map(([sessionId, entry]) => [sessionId, { type: entry.phase }]),
  );
  const getSessionStateSnapshot = () => Object.fromEntries(
    [...states].map(([sessionId, entry]) => [sessionId, entry]),
  );
  const getSessionAttentionSnapshot = () => Object.fromEntries(
    [...attention].map(([sessionId, entry]) => [sessionId, {
      isViewed: entry.viewedByClients.size > 0,
      lastStatusChangeAt: entry.lastStatusChangeAt,
      lastUserMessageAt: entry.lastUserMessageAt,
      needsAttention: entry.needsAttention,
      status: entry.status,
    }]),
  );
  const getSessionState = (sessionId: string) => states.get(sessionId) ?? null;
  const getSessionAttentionState = (sessionId: string) => {
    const entry = attention.get(sessionId);
    return entry ? {
      isViewed: entry.viewedByClients.size > 0,
      lastStatusChangeAt: entry.lastStatusChangeAt,
      lastUserMessageAt: entry.lastUserMessageAt,
      needsAttention: entry.needsAttention,
      status: entry.status,
    } : null;
  };

  const cleanup = (): void => {
    const cutoff = Date.now() - SESSION_STATE_MAX_AGE_MS;
    for (const [sessionId, entry] of states) if (entry.lastUpdateAt < cutoff) states.delete(sessionId);
    for (const [sessionId, entry] of attention) if (entry.lastStatusChangeAt < cutoff) attention.delete(sessionId);
    for (const [sessionId, entry] of activity) if (entry.updatedAt < cutoff) activity.delete(sessionId);
  };
  const cleanupTimer = setInterval(cleanup, CLEANUP_INTERVAL_MS);
  cleanupTimer.unref?.();

  const dispose = (): void => {
    clearInterval(cleanupTimer);
    for (const timer of cooldownTimers.values()) clearTimeout(timer);
    cooldownTimers.clear();
    activity.clear();
    states.clear();
    attention.clear();
    activeSessionCount = 0;
  };

  return {
    dispose,
    getActiveSessionCount: () => activeSessionCount,
    getSessionActivitySnapshot,
    getSessionAttentionSnapshot,
    getSessionAttentionState,
    getSessionState,
    getSessionStateSnapshot,
    markSessionUnviewed,
    markSessionViewed,
    markUserMessageSent,
    processBrokerEvent,
  };
};
