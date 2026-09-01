import { PiRuntimeBrokerError } from '@piarium/runtime-broker';

interface AdmissionFailure {
  code?: string | undefined;
  message?: string | undefined;
  statusCode?: number | undefined;
  currentEpoch?: number | undefined;
}

interface PiWriter {
  markMutated: () => Promise<void>;
  close: () => Promise<void>;
}

interface MutationOwner {
  kind: string;
  id: string;
  generation?: number | undefined;
}

interface WatchSubscription {
  ready: Promise<boolean>;
  settle: () => Promise<void>;
  close: () => void;
}

interface WorkspaceWatchEvent {
  kind?: string | undefined;
  resource?: {
    workspaceId?: string | undefined;
    resourceId?: string | undefined;
  } | undefined;
}

interface PiWriterDocuments {
  resolveScopeId?: ((scopeId: unknown) => Promise<string | null>) | undefined;
  watch?: ((
    workspaceId: string,
    listener: (event: WorkspaceWatchEvent) => void,
  ) => WatchSubscription) | undefined;
  registerWriterForScope: (
    scopeId: unknown,
    owner: MutationOwner,
    options: Record<string, unknown>,
  ) => Promise<PiWriter | null>;
}

interface PiWriterLease {
  closed: boolean;
  close: () => Promise<void>;
}

interface PiWriterState {
  closed: boolean;
  changedResourceIds: Set<string>;
  closedPromise: Promise<void>;
  closePromise: Promise<void> | null;
  closing: boolean;
  fallbackLease: PiWriterLease | null;
  holders: number;
  mutationObserved: boolean;
  ready: Promise<void> | null;
  resolveClosed: () => void;
  retired: boolean;
  watch: WatchSubscription | null;
  watchAvailable: boolean;
  watchCoverageComplete: boolean;
  writer: PiWriter | null;
}

interface SettledSummary {
  changedResourceIds: string[];
  coverageComplete: boolean;
  mutationObserved: boolean;
}

interface PiWriterAdmissionRequest {
  cwd?: string | undefined;
  method?: string | undefined;
  phase?: string | undefined;
  sessionId?: string | undefined;
  workerId?: string | undefined;
}

interface ResolvedAdmissionRequest {
  cwd: string;
  method?: string | undefined;
  phase?: string | undefined;
  sessionId?: string | undefined;
  workerId: string;
}

interface PiWriterAcquireOptions {
  fallback?: boolean | undefined;
}

interface SessionSnapshotData {
  cwd?: string | undefined;
  isRunning?: boolean | undefined;
  busy?: boolean | undefined;
  isStreaming?: boolean | undefined;
}

interface PiEventEnvelopeData extends SessionSnapshotData {
  sessionId?: string | undefined;
  event?: { type?: string | undefined } | undefined;
}

interface HostEventEnvelope {
  kind?: string | undefined;
  event?: string | undefined;
  data?: PiEventEnvelopeData | undefined;
}

interface PiWorkerEvent {
  kind?: string | undefined;
  workerId: string;
  sessionId?: string | undefined;
  envelope?: HostEventEnvelope | undefined;
}

interface PiWorkspaceWriterTracker {
  admit: (request: PiWriterAdmissionRequest) => Promise<PiWriterLease | null>;
  processEvent: (event: PiWorkerEvent | undefined) => Promise<void>;
  waitForIdle: (workerId: string) => Promise<SettledSummary | null>;
  dispose: () => Promise<void>;
}

const admissionError = (error: unknown): PiRuntimeBrokerError | unknown => {
  if (error instanceof PiRuntimeBrokerError) return error;
  if (!error || typeof error !== 'object') return error;
  const failure = error as AdmissionFailure;
  if (typeof failure.code !== 'string' || !Number.isInteger(failure.statusCode)) return error;
  const currentEpoch = Number.isSafeInteger(failure.currentEpoch) && (failure.currentEpoch as number) > 0
    ? failure.currentEpoch as number
    : undefined;
  return new PiRuntimeBrokerError(failure.code, failure.message || 'Pi session writer admission failed', {
    ...(currentEpoch === undefined ? {} : { details: { currentEpoch } }),
    retryable: failure.code === 'maintenance' || failure.code === 'stale-epoch',
  });
};

export const createPiWorkspaceWriterTracker = ({
  documents,
}: { documents: PiWriterDocuments }): PiWorkspaceWriterTracker => {
  const snapshots = new Map<string, SessionSnapshotData | undefined>();
  const settledSummaries = new Map<string, SettledSummary>();
  const writers = new Map<string, PiWriterState>();
  let disposed = false;

  const finalize = async (
    workerId: string,
    state: PiWriterState | undefined,
    force = false,
  ): Promise<void> => {
    if (!state || state.closed || state.closePromise) return state?.closePromise ?? undefined;
    if (!force && state.holders > 0) return undefined;
    state.closing = true;
    state.closePromise = (async () => {
      await Promise.resolve(state.ready).catch(() => undefined);
      try {
        if (state.watch) {
          try {
            await state.watch.settle();
          } catch {
            state.watchAvailable = false;
          }
        }
        if (state.mutationObserved || !state.watchAvailable) {
          await state.writer?.markMutated();
        }
      } catch {
        // The writer still has to close when mutation accounting is stopping.
      }
      try {
        await state.writer?.close();
      } catch {
        // Authority shutdown owns any remaining in-memory cleanup.
      } finally {
        state.watch?.close();
      }
    })().finally(() => {
      settledSummaries.set(workerId, {
        changedResourceIds: [...state.changedResourceIds].sort(),
        coverageComplete: state.watchAvailable && state.watchCoverageComplete,
        mutationObserved: state.mutationObserved,
      });
      state.closed = true;
      state.resolveClosed();
      if (writers.get(workerId) === state) writers.delete(workerId);
    });
    return state.closePromise;
  };

  const closeLease = (
    workerId: string,
    state: PiWriterState,
    lease: PiWriterLease,
  ): Promise<void> => {
    if (lease.closed) return state.closePromise || Promise.resolve();
    lease.closed = true;
    if (state.fallbackLease === lease) state.fallbackLease = null;
    if (state.holders > 0) state.holders -= 1;
    return finalize(workerId, state) || Promise.resolve();
  };

  const forceRelease = (workerId: string): Promise<void> => {
    const state = writers.get(workerId);
    if (state) state.retired = true;
    return finalize(workerId, state, true) || Promise.resolve();
  };

  const createState = ({
    cwd,
    method,
    phase,
    sessionId,
    workerId,
  }: ResolvedAdmissionRequest): PiWriterState => {
    settledSummaries.delete(workerId);
    let resolveClosed: () => void = () => {};
    const closedPromise = new Promise<void>((resolve) => {
      resolveClosed = () => resolve();
    });
    const state: PiWriterState = {
      closed: false,
      changedResourceIds: new Set<string>(),
      closedPromise,
      closePromise: null,
      closing: false,
      fallbackLease: null,
      holders: 0,
      mutationObserved: false,
      ready: null,
      resolveClosed,
      retired: false,
      watch: null,
      watchAvailable: false,
      watchCoverageComplete: false,
      writer: null,
    };
    writers.set(workerId, state);
    state.ready = (async () => {
      if (typeof documents.resolveScopeId === 'function' && typeof documents.watch === 'function') {
        try {
          const workspaceId = await documents.resolveScopeId(cwd);
          if (workspaceId) {
            state.watchCoverageComplete = true;
            state.watch = documents.watch(workspaceId, (event) => {
              state.mutationObserved = true;
              if (event?.kind === 'reset') {
                state.watchCoverageComplete = false;
              } else if (event?.resource?.workspaceId === workspaceId
                && typeof event.resource.resourceId === 'string'
                && event.resource.resourceId) {
                state.changedResourceIds.add(event.resource.resourceId);
              }
            });
            state.watchAvailable = await state.watch.ready;
            if (!state.watchAvailable) state.watchCoverageComplete = false;
          }
        } catch {
          state.watch?.close();
          state.watch = null;
          state.watchAvailable = false;
          state.watchCoverageComplete = false;
        }
      }
      const writer = await documents.registerWriterForScope(cwd, {
        kind: 'pi-worker',
        id: workerId,
      }, {
        mode: 'process',
        purpose: method
          ? `pi-${phase || 'execution'}:${method}`
          : sessionId ? `pi-session:${sessionId}` : `pi-${phase || 'execution'}`,
      });
      state.writer = writer;
      if (!writer) {
        state.watch?.close();
        state.closed = true;
        state.resolveClosed();
        if (writers.get(workerId) === state) writers.delete(workerId);
      }
    })().catch((error: unknown) => {
      state.watch?.close();
      state.closed = true;
      state.resolveClosed();
      if (writers.get(workerId) === state) writers.delete(workerId);
      throw admissionError(error);
    });
    return state;
  };

  const acquire = async (
    { cwd, method, phase, sessionId, workerId }: PiWriterAdmissionRequest,
    { fallback = false }: PiWriterAcquireOptions = {},
  ): Promise<PiWriterLease | null> => {
    if (disposed) {
      throw new PiRuntimeBrokerError('runtime_not_ready', 'Pi workspace writer admission is stopping', {
        retryable: true,
      });
    }
    if (typeof cwd !== 'string' || !cwd || typeof workerId !== 'string' || !workerId) return null;
    for (;;) {
      const state = writers.get(workerId) || createState({ cwd, method, phase, sessionId, workerId });
      await state.ready;
      if (!state.writer) return null;
      if (state.retired) {
        await state.closedPromise;
        throw new PiRuntimeBrokerError('runtime_not_ready', 'Pi session worker stopped during admission', {
          retryable: true,
        });
      }
      if (disposed) {
        await (finalize(workerId, state, true) || Promise.resolve());
        throw new PiRuntimeBrokerError('runtime_not_ready', 'Pi workspace writer admission is stopping', {
          retryable: true,
        });
      }
      if (state.closing || state.closed || writers.get(workerId) !== state) {
        await state.closedPromise;
        continue;
      }
      if (fallback && state.fallbackLease) return state.fallbackLease;
      const lease: PiWriterLease = {
        closed: false,
        close: () => closeLease(workerId, state, lease),
      };
      state.holders += 1;
      if (fallback) state.fallbackLease = lease;
      return lease;
    }
  };

  const admit = (request: PiWriterAdmissionRequest): Promise<PiWriterLease | null> => acquire(request);

  const ensureFallback = async (event: PiWorkerEvent, sessionId: string): Promise<void> => {
    if (!event.workerId || disposed) return;
    const snapshot = snapshots.get(sessionId);
    const cwd = typeof snapshot?.cwd === 'string' ? snapshot.cwd : '';
    if (!cwd) return;
    try {
      await acquire({ cwd, phase: 'event-fallback', sessionId, workerId: event.workerId }, { fallback: true });
    } catch {
      // Event registration is only a compatibility fallback. Pre-execution
      // admission is the authority and propagates its own typed refusal.
    }
  };

  const processEvent = (event: PiWorkerEvent | undefined): Promise<void> => {
    if (event?.kind === 'worker.exit') return forceRelease(event.workerId);
    if (event?.kind !== 'host' || event.envelope?.kind !== 'event') return Promise.resolve();
    const envelope = event.envelope;
    const sessionId = event.sessionId || envelope.data?.sessionId;
    if (!sessionId) return Promise.resolve();
    if (envelope.event === 'session.closed') {
      snapshots.delete(sessionId);
      return forceRelease(event.workerId);
    }
    if (envelope.event === 'session.snapshot') {
      snapshots.set(sessionId, envelope.data);
      if (
        envelope.data?.isRunning === true
        || envelope.data?.busy === true
        || envelope.data?.isStreaming === true
      ) return ensureFallback(event, sessionId);
      return Promise.resolve();
    }
    if (envelope.event !== 'agent.event') return Promise.resolve();
    const agentEvent = envelope.data?.event;
    if (agentEvent?.type === 'agent_start') return ensureFallback(event, sessionId);
    if (agentEvent?.type === 'agent_settled') {
      const state = writers.get(event.workerId);
      return state?.fallbackLease?.close() || Promise.resolve();
    }
    return Promise.resolve();
  };

  return {
    admit,
    processEvent,
    async waitForIdle(workerId: string): Promise<SettledSummary | null> {
      const state = writers.get(workerId);
      if (state) await state.closedPromise;
      const summary = settledSummaries.get(workerId) ?? null;
      settledSummaries.delete(workerId);
      return summary;
    },
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      await Promise.allSettled([...writers].map(([workerId]) => forceRelease(workerId)));
      snapshots.clear();
      settledSummaries.clear();
    },
  };
};
