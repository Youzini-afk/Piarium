import { createWorkspaceRecoveryAPI } from '@piarium/extension-contract';

const writerScope = (writer) => {
  const generation = writer.owner?.generation === undefined ? '' : `@${writer.owner.generation}`;
  return `${writer.owner?.kind || 'writer'}:${writer.owner?.id || writer.writerId}${generation}`;
};

const unavailableFailure = (error, message = 'Workspace turn checkpoint is unavailable') => ({
  code: 'unavailable',
  message: error instanceof Error ? `${message}: ${error.message}` : message,
  retryable: true,
});

const incompleteFailure = (message) => ({
  code: 'snapshot-incomplete',
  message,
  retryable: true,
});

const isBoundWorkspace = (snapshot) => (
  snapshot?.workspace?.kind === 'workspace'
  && typeof snapshot.workspace.id === 'string'
  && snapshot.workspace.id
);

export const createRecoveryTurnCoordinator = ({
  documents,
  getSessionSnapshot,
  invokeService,
  writerTracker,
}) => {
  const pending = new Map();
  let disposed = false;

  const apiFor = (turn) => createWorkspaceRecoveryAPI((request) => invokeService({
    ...request,
    routing: {
      invocationId: turn.executionId,
      runtimeId: String(turn.runtimeGeneration),
      sessionId: turn.sessionId,
      workspaceId: turn.workspaceId,
    },
  }));

  const inspectScopes = async (workspaceId) => {
    const state = await documents.inspectMutation(workspaceId);
    return {
      state,
      scopes: state.activeWriters.map(writerScope),
    };
  };

  const capture = async (turn, source) => {
    try {
      return await apiFor(turn).captureSnapshot({
        reuseIfUnchanged: true,
        source,
        workspaceId: turn.workspaceId,
      });
    } catch (error) {
      return { failure: unavailableFailure(error), status: 'failed' };
    }
  };

  const recordStart = async (turn, executionId, userEntryId, beforeSnapshotId, failure) => {
    try {
      const result = await apiFor(turn).recordTurnStart({
        activeWriterScopes: [...turn.activeWriterScopes],
        ...(beforeSnapshotId ? { beforeSnapshotId } : {}),
        executionId,
        ...(failure ? { failure } : {}),
        provenance: turn.provenance,
        runtimeGeneration: turn.runtimeGeneration,
        sessionId: turn.sessionId,
        userEntryId,
        workerId: turn.workerId,
        workspaceId: turn.workspaceId,
      });
      if (result.status === 'ready') turn.bindingIds.push(executionId);
    } catch {
      // A missing/replaced recovery provider leaves the conversation authoritative.
    }
  };

  const settleBinding = async (turn, executionId, input) => {
    try {
      await apiFor(turn).recordTurnSettled({
        activeWriterScopes: [...turn.activeWriterScopes],
        executionId,
        provenance: turn.provenance,
        workspaceId: turn.workspaceId,
        ...input,
      });
    } catch {
      // The binding remains pending/incomplete and can be diagnosed by the provider.
    }
  };

  const finalize = async (turn, failureOverride) => {
    if (turn.finalizing) return turn.finalizing;
    turn.finalizing = (async () => {
      await writerTracker.waitForIdle(turn.workerId);
      const afterMutation = await inspectScopes(turn.workspaceId).catch(() => null);
      if (afterMutation) {
        turn.activeWriterScopes = [...new Set([
          ...turn.activeWriterScopes,
          ...afterMutation.scopes,
        ])].sort();
        const expectedWriterRevision = turn.writerRevisionAfterAdmission + 1;
        if (afterMutation.state.writerRevision > expectedWriterRevision
          || afterMutation.state.activeWriters.length > 0) {
          turn.provenance = 'overlapped';
        }
      }
      const after = failureOverride ? null : await capture(turn, 'turn-after');
      const afterSnapshotId = after?.status === 'captured' && after.snapshot.availability === 'ready'
        ? after.snapshot.id
        : undefined;
      const afterFailure = failureOverride
        ?? (after?.status === 'failed'
          ? after.failure
          : afterSnapshotId ? undefined : incompleteFailure('Turn-after workspace snapshot is incomplete'));
      const lastBindingId = turn.bindingIds.at(-1);
      for (const executionId of turn.bindingIds) {
        if (executionId === lastBindingId) {
          await settleBinding(turn, executionId, {
            ...(afterSnapshotId ? { afterSnapshotId } : {}),
            ...(turn.lastAssistantEntryId ? { assistantEntryId: turn.lastAssistantEntryId } : {}),
            ...(afterFailure ? { failure: afterFailure } : {}),
          });
        } else {
          await settleBinding(turn, executionId, {
            failure: incompleteFailure('A later queued user turn shares this execution; no exact after snapshot exists'),
          });
        }
      }
      pending.delete(turn.executionId);
    })();
    return turn.finalizing;
  };

  return {
    async admit(request) {
      if (disposed) throw new Error('Recovery turn coordinator is disposed');
      if (request.phase !== 'agent-run' || !request.sessionId) {
        return writerTracker.admit(request);
      }
      const snapshot = getSessionSnapshot(request.sessionId);
      if (!isBoundWorkspace(snapshot)) return writerTracker.admit(request);
      const workspaceId = snapshot.workspace.id;
      const turn = {
        activeWriterScopes: [],
        agentStarted: false,
        beforeFailure: undefined,
        beforeSnapshotId: undefined,
        bindingIds: [],
        eventTail: Promise.resolve(),
        executionId: request.executionId,
        finalizing: null,
        lastAssistantEntryId: undefined,
        provenance: 'observed-during',
        runtimeGeneration: request.runtimeGeneration,
        sessionId: request.sessionId,
        userEntryCount: 0,
        workerId: request.workerId,
        workspaceId,
        writerRevisionAfterAdmission: 0,
      };
      const beforeMutation = await inspectScopes(workspaceId).catch(() => null);
      if (beforeMutation) turn.activeWriterScopes = beforeMutation.scopes;
      const before = await capture(turn, 'turn-before');
      const writerLease = await writerTracker.admit(request);
      const admittedMutation = await inspectScopes(workspaceId).catch(() => null);
      if (admittedMutation) {
        turn.writerRevisionAfterAdmission = admittedMutation.state.writerRevision;
        turn.activeWriterScopes = [...new Set([
          ...turn.activeWriterScopes,
          ...admittedMutation.scopes,
        ])].sort();
      }
      const currentWriter = admittedMutation?.state.activeWriters.filter((writer) => (
        writer.owner?.kind === 'pi-worker' && writer.owner?.id === request.workerId
      )) ?? [];
      const foreignWriters = admittedMutation?.state.activeWriters.filter((writer) => (
        writer.owner?.kind !== 'pi-worker' || writer.owner?.id !== request.workerId
      )) ?? [];
      const witnessMatches = before.status === 'captured'
        && admittedMutation
        && before.witness.epoch === admittedMutation.state.epoch
        && before.witness.mutationRevision === admittedMutation.state.mutationRevision
        && before.witness.writerRevision + currentWriter.length === admittedMutation.state.writerRevision
        && currentWriter.length === (writerLease ? 1 : 0)
        && foreignWriters.length === 0;
      if (witnessMatches && before.snapshot.availability === 'ready') {
        turn.beforeSnapshotId = before.snapshot.id;
      } else {
        turn.beforeFailure = before.status === 'failed'
          ? before.failure
          : incompleteFailure('Workspace changed between turn-before capture and writer admission');
        if (foreignWriters.length > 0) turn.provenance = 'overlapped';
      }
      pending.set(request.executionId, turn);
      let closed = false;
      return {
        async close() {
          if (closed) return;
          closed = true;
          await writerLease?.close();
          if (!turn.agentStarted && turn.bindingIds.length === 0) pending.delete(turn.executionId);
        },
      };
    },

    processEvent(event) {
      const executionId = event?.executionId;
      if (!executionId) return Promise.resolve();
      const turn = pending.get(executionId);
      if (!turn) return Promise.resolve();
      const handle = async () => {
        if (event.kind === 'worker.exit') {
          return finalize(turn, incompleteFailure('Pi worker exited before the turn settled'));
        }
        if (event.kind !== 'host' || event.envelope?.event !== 'agent.event') return;
        const agentEvent = event.envelope.data?.event;
        if (agentEvent?.type === 'agent_start') turn.agentStarted = true;
        if (agentEvent?.type === 'entry_appended' && agentEvent.entry?.type === 'message') {
          if (agentEvent.entry.message?.role === 'user') {
            turn.userEntryCount += 1;
            const bindingId = turn.userEntryCount === 1
              ? turn.executionId
              : `${turn.executionId}:${agentEvent.entry.id}`;
            const exactBefore = turn.userEntryCount === 1 ? turn.beforeSnapshotId : undefined;
            const failure = turn.userEntryCount === 1
              ? turn.beforeFailure
              : incompleteFailure('Queued user turn has no independently paused turn-before snapshot');
            await recordStart(turn, bindingId, agentEvent.entry.id, exactBefore, failure);
          } else if (agentEvent.entry.message?.role === 'assistant') {
            turn.lastAssistantEntryId = agentEvent.entry.id;
          }
        }
        if (agentEvent?.type === 'agent_settled') await finalize(turn);
      };
      turn.eventTail = turn.eventTail.then(handle, handle);
      return turn.eventTail;
    },

    async dispose() {
      disposed = true;
      await Promise.allSettled([...pending.values()].map((turn) => (
        finalize(turn, incompleteFailure('Application Host stopped before the turn settled'))
      )));
      pending.clear();
    },
  };
};
