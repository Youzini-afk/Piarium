import { PiRuntimeBrokerError } from '@piarium/runtime-broker';

const admissionError = (error) => {
  if (error instanceof PiRuntimeBrokerError) return error;
  if (
    !error
    || typeof error !== 'object'
    || typeof error.code !== 'string'
    || !Number.isInteger(error.statusCode)
  ) return error;
  const currentEpoch = Number.isSafeInteger(error.currentEpoch) && error.currentEpoch > 0
    ? error.currentEpoch
    : undefined;
  return new PiRuntimeBrokerError(error.code, error.message || 'Pi session writer admission failed', {
    ...(currentEpoch === undefined ? {} : { details: { currentEpoch } }),
    retryable: error.code === 'maintenance' || error.code === 'stale-epoch',
  });
};

export const createPiWorkspaceWriterTracker = ({ documents }) => {
  const snapshots = new Map();
  const writers = new Map();
  let disposed = false;

  const finalize = async (workerId, state, force = false) => {
    if (!state || state.closed || state.closePromise) return state?.closePromise;
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
      state.closed = true;
      state.resolveClosed();
      if (writers.get(workerId) === state) writers.delete(workerId);
    });
    return state.closePromise;
  };

  const closeLease = (workerId, state, lease) => {
    if (lease.closed) return state.closePromise || Promise.resolve();
    lease.closed = true;
    if (state.fallbackLease === lease) state.fallbackLease = null;
    if (state.holders > 0) state.holders -= 1;
    return finalize(workerId, state) || Promise.resolve();
  };

  const forceRelease = (workerId) => {
    const state = writers.get(workerId);
    if (state) state.retired = true;
    return finalize(workerId, state, true) || Promise.resolve();
  };

  const createState = ({ cwd, method, phase, sessionId, workerId }) => {
    let resolveClosed = () => {};
    const closedPromise = new Promise((resolve) => {
      resolveClosed = () => resolve();
    });
    const state = {
      closed: false,
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
      writer: null,
    };
    writers.set(workerId, state);
    state.ready = (async () => {
      if (typeof documents.resolveScopeId === 'function' && typeof documents.watch === 'function') {
        try {
          const workspaceId = await documents.resolveScopeId(cwd);
          if (workspaceId) {
            state.watch = documents.watch(workspaceId, () => {
              state.mutationObserved = true;
            });
            state.watchAvailable = await state.watch.ready;
          }
        } catch {
          state.watch?.close();
          state.watch = null;
          state.watchAvailable = false;
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
    })().catch((error) => {
      state.watch?.close();
      state.closed = true;
      state.resolveClosed();
      if (writers.get(workerId) === state) writers.delete(workerId);
      throw admissionError(error);
    });
    return state;
  };

  const acquire = async ({ cwd, method, phase, sessionId, workerId }, { fallback = false } = {}) => {
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
      const lease = {
        closed: false,
        close: () => closeLease(workerId, state, lease),
      };
      state.holders += 1;
      if (fallback) state.fallbackLease = lease;
      return lease;
    }
  };

  const admit = (request) => acquire(request);

  const ensureFallback = async (event, sessionId) => {
    if (!event?.workerId || disposed) return;
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

  const processEvent = (event) => {
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
    async waitForIdle(workerId) {
      const state = writers.get(workerId);
      if (state) await state.closedPromise;
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      await Promise.allSettled([...writers].map(([workerId]) => forceRelease(workerId)));
      snapshots.clear();
    },
  };
};
