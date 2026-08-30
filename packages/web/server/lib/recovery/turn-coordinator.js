import { createWorkspaceRecoveryAPI } from '@piarium/extension-contract';

const writerScope = (writer) => {
  const generation = writer.owner?.generation === undefined ? '' : `@${writer.owner.generation}`;
  return `${writer.owner?.kind || 'writer'}:${writer.owner?.id || writer.writerId}${generation}`;
};

const incompleteFailure = (message) => ({
  code: 'checkpoint-incomplete',
  message,
  retryable: false,
});

const isBoundWorkspace = (workspace) => (
  workspace?.kind === 'workspace'
  && typeof workspace.id === 'string'
  && workspace.id
);

const reportFailure = (turn, stage, failure) => {
  console.warn(
    `[WorkspaceRecovery] ${stage} failed for session ${turn.sessionId} `
    + `(execution ${turn.executionId}, workspace ${turn.workspaceId}): `
    + (failure?.message || String(failure || 'unknown failure')),
  );
};

export const createRecoveryTurnCoordinator = ({
  documents,
  getSessionSnapshot,
  invokeService,
  respondMutation,
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
      scopes: state.activeWriters.map(writerScope),
      state,
    };
  };

  const recordStart = async (turn, executionId, userEntryId, failure) => {
    try {
      const result = await apiFor(turn).recordTurnStart({
        activeWriterScopes: [...turn.activeWriterScopes],
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
      else reportFailure(turn, 'turn binding start', result.failure);
    } catch (error) {
      reportFailure(turn, 'turn binding start', error);
    }
  };

  const settleBinding = async (turn, executionId, input) => {
    try {
      const result = await apiFor(turn).recordTurnSettled({
        activeWriterScopes: [...turn.activeWriterScopes],
        executionId,
        provenance: turn.provenance,
        workspaceId: turn.workspaceId,
        ...input,
      });
      if (result.status === 'failed') reportFailure(turn, 'turn binding settlement', result.failure);
    } catch (error) {
      reportFailure(turn, 'turn binding settlement', error);
    }
  };

  const finalize = async (turn, failureOverride) => {
    if (turn.finalizing) return turn.finalizing;
    turn.finalizing = (async () => {
      const mutationSummary = await writerTracker.waitForIdle(turn.workerId);
      const afterMutation = await inspectScopes(turn.workspaceId).catch(() => null);
      if (afterMutation) {
        turn.activeWriterScopes = [...new Set([
          ...turn.activeWriterScopes,
          ...afterMutation.scopes,
        ])].sort();
        if (afterMutation.state.activeWriters.length > 0) turn.provenance = 'overlapped';
      }
      const lastBindingId = turn.bindingIds.at(-1);
      for (const executionId of turn.bindingIds) {
        if (executionId !== lastBindingId) {
          await settleBinding(turn, executionId, {
            failure: incompleteFailure('A queued user turn did not receive an independent mutation journal'),
            mutationObserved: true,
            observationComplete: false,
            observedResourceIds: [],
          });
          continue;
        }
        await settleBinding(turn, executionId, {
          ...(turn.lastAssistantEntryId ? { assistantEntryId: turn.lastAssistantEntryId } : {}),
          ...(failureOverride ? { failure: failureOverride } : {}),
          mutationObserved: mutationSummary?.mutationObserved === true
            || turn.recordedMutation
            || (turn.unjournalledTool && mutationSummary?.coverageComplete !== true),
          observationComplete: mutationSummary?.coverageComplete === true,
          observedResourceIds: mutationSummary?.changedResourceIds ?? [],
        });
      }
      pending.delete(turn.executionId);
    })();
    return turn.finalizing;
  };

  const handleMutationRequest = async (turn, request) => {
    let accepted = false;
    try {
      if (!turn || request.sessionId !== turn.sessionId) return;
      const api = apiFor(turn);
      const input = {
        executionId: turn.executionId,
        mutationId: request.requestId,
        path: request.path,
        toolCallId: request.toolCallId,
        toolName: request.toolName,
        workspaceId: turn.workspaceId,
      };
      const result = request.phase === 'before'
        ? await api.recordMutationBefore(input)
        : await api.recordMutationAfter({ ...input, succeeded: request.succeeded === true });
      accepted = result.status === 'ready' && result.recorded;
      if (accepted && request.phase === 'after') turn.recordedMutation = true;
      else if (result.status === 'failed') reportFailure(turn, `mutation ${request.phase}`, result.failure);
    } catch (error) {
      if (turn) reportFailure(turn, `mutation ${request.phase}`, error);
    } finally {
      await respondMutation(request, accepted).catch((error) => {
        if (turn) reportFailure(turn, 'mutation response', error);
      });
    }
  };

  return {
    async admit(request) {
      if (disposed) throw new Error('Recovery turn coordinator is disposed');
      if (request.phase !== 'agent-run' || !request.sessionId) return writerTracker.admit(request);
      const workspace = request.workspace ?? getSessionSnapshot(request.sessionId)?.workspace;
      if (!isBoundWorkspace(workspace)) return writerTracker.admit(request);
      const workspaceId = workspace.authorityId ?? workspace.id;
      const turn = {
        activeWriterScopes: [],
        agentStarted: false,
        bindingIds: [],
        eventTail: Promise.resolve(),
        executionId: request.executionId,
        finalizing: null,
        lastAssistantEntryId: undefined,
        provenance: 'observed-during',
        recordedMutation: false,
        runtimeGeneration: request.runtimeGeneration,
        sessionId: request.sessionId,
        userEntryCount: 0,
        unjournalledTool: false,
        workerId: request.workerId,
        workspaceId,
      };
      const before = await inspectScopes(workspaceId).catch(() => null);
      if (before) turn.activeWriterScopes = before.scopes;
      const writerLease = await writerTracker.admit(request);
      const admitted = await inspectScopes(workspaceId).catch(() => null);
      if (admitted) {
        turn.activeWriterScopes = [...new Set([
          ...turn.activeWriterScopes,
          ...admitted.scopes,
        ])].sort();
        const foreignWriters = admitted.state.activeWriters.filter((writer) => (
          writer.owner?.kind !== 'pi-worker' || writer.owner?.id !== request.workerId
        ));
        if (foreignWriters.length > 0) turn.provenance = 'overlapped';
      }
      pending.set(request.executionId, turn);
      let closed = false;
      return {
        async close() {
          if (closed) return;
          closed = true;
          await writerLease?.close();
          // agent.prompt acknowledges before Pi emits agent_start. The turn must
          // remain addressable for the later ordered agent and mutation events.
        },
      };
    },

    processEvent(event) {
      const executionId = event?.executionId;
      const turn = executionId ? pending.get(executionId) : null;
      if (event?.kind === 'host' && event.envelope?.event === 'workspace.mutation.request') {
        const request = event.envelope.data;
        const handle = () => handleMutationRequest(turn, request);
        if (!turn) return handle();
        turn.eventTail = turn.eventTail.then(handle, handle);
        return turn.eventTail;
      }
      if (!turn) return Promise.resolve();
      const handle = async () => {
        if (event.kind === 'worker.exit') {
          return finalize(turn, incompleteFailure('Pi worker exited before the turn settled'));
        }
        if (event.kind !== 'host' || event.envelope?.event !== 'agent.event') return;
        const agentEvent = event.envelope.data?.event;
        if (agentEvent?.type === 'agent_start') turn.agentStarted = true;
        if (
          agentEvent?.type === 'tool_execution_start'
          && !['read', 'grep', 'find', 'ls', 'write', 'edit'].includes(agentEvent.toolName)
        ) {
          turn.unjournalledTool = true;
        }
        if (agentEvent?.type === 'entry_appended' && agentEvent.entry?.type === 'message') {
          if (agentEvent.entry.message?.role === 'user') {
            turn.userEntryCount += 1;
            const bindingId = turn.userEntryCount === 1
              ? turn.executionId
              : `${turn.executionId}:${agentEvent.entry.id}`;
            await recordStart(
              turn,
              bindingId,
              agentEvent.entry.id,
              turn.userEntryCount === 1
                ? undefined
                : incompleteFailure('Queued user turn has no independently paused mutation journal'),
            );
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
