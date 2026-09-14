import type { DurableRecoveryChangeSelection, RecoveryDurableMetadataPort } from "./journal-engine.js";

interface MemoryOperation extends Record<string, unknown> {
  operationId: string;
  workspaceId: string;
  kind: string;
  state: string;
  revision: number;
  data: Record<string, unknown>;
  result?: Record<string, unknown>;
  files: Array<Record<string, unknown> & { path: string; phase: string; revision: number }>;
}

export interface InMemoryRecoveryDurablePort extends RecoveryDurableMetadataPort {
  snapshot(workspaceId: string, operationId: string): MemoryOperation | null;
}

/** Strict, process-local recovery port for tests. It models operation/file revisions independently. */
export const createInMemoryRecoveryDurablePort = (): InMemoryRecoveryDurablePort => {
  const operations = new Map<string, MemoryOperation>();
  const checkpoints = new Map<string, Array<Record<string, unknown>>>();
  const turns = new Map<string, DurableRecoveryChangeSelection["turns"][number] & { workspaceId: string }>();
  const changes = new Map<string, DurableRecoveryChangeSelection["changes"][number] & { workspaceId: string }>();
  let turnSequence = 0;
  const key = (workspaceId: string, operationId: string) => `${workspaceId}\0${operationId}`;
  const clone = (operation: MemoryOperation): MemoryOperation => structuredClone(operation);
  const get = (workspaceId: string, operationId: string): MemoryOperation | null => {
    const operation = operations.get(key(workspaceId, operationId));
    return operation ? clone(operation) : null;
  };
  return {
    snapshot: get,
    async createOperation(input) {
      const id = key(input.workspaceId, input.operationId);
      const existing = operations.get(id);
      if (existing) return clone(existing);
      const surface = new Set(input.surfacePaths ?? []);
      const operation: MemoryOperation = {
        operationId: input.operationId,
        workspaceId: input.workspaceId,
        kind: input.kind,
        state: input.state,
        revision: 1,
        data: structuredClone(input.data),
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        ...(input.threadId ? { threadId: input.threadId } : {}),
        ...(input.runId ? { runId: input.runId } : {}),
        files: Object.entries(input.targets).sort(([left], [right]) => left.localeCompare(right)).map(([path, states]) => ({
          path,
          phase: "pending",
          revision: 1,
          ...(surface.has(path) || !states.expected ? {} : { expectedJson: JSON.stringify(states.expected) }),
          ...(surface.has(path) || !states.target ? {} : { targetJson: JSON.stringify(states.target) }),
          ...(surface.has(path) || !states.safety ? {} : { safetyJson: JSON.stringify(states.safety) }),
        })),
      };
      operations.set(id, operation);
      return clone(operation);
    },
    async updateOperationFile(input) {
      const operation = operations.get(key(input.workspaceId, input.operationId));
      const file = operation?.files.find((value) => value.path === input.path);
      if (!operation || !file || file.revision !== input.expectedRevision || file.phase !== input.expectedPhase) {
        throw new Error("operation file phase conflict");
      }
      file.phase = input.phase;
      file.revision += 1;
      if (input.observedFingerprint) file.observedFingerprint = input.observedFingerprint;
      if (input.expected) file.expectedJson = JSON.stringify(input.expected);
      if (input.target) file.targetJson = JSON.stringify(input.target);
      if (input.safety) file.safetyJson = JSON.stringify(input.safety);
      return { operationId: input.operationId, workspaceId: input.workspaceId, path: input.path, phase: file.phase, revision: file.revision };
    },
    async completeOperation(input) {
      const operation = operations.get(key(input.workspaceId, input.operationId));
      if (!operation || operation.revision !== input.expectedRevision) throw new Error("operation state conflict");
      operation.state = input.state;
      operation.revision += 1;
      if (input.result) operation.result = structuredClone(input.result);
      if (input.failure) operation.failure = structuredClone(input.failure);
      return { operationId: input.operationId, workspaceId: input.workspaceId, state: operation.state, revision: operation.revision };
    },
    async getOperation(workspaceId, operationId) { return get(workspaceId, operationId); },
    async listOperations(workspaceId, kind) {
      return [...operations.values()].filter((operation) => operation.workspaceId === workspaceId && (!kind || operation.kind === kind)).map(clone);
    },
    async releaseOperation(workspaceId, operationId) {
      const id = key(workspaceId, operationId);
      const operation = operations.get(id);
      if (!operation) return { operationId, released: false };
      if (!["complete", "aborted", "compensated", "undone"].includes(operation.state)) {
        return { operationId, released: false };
      }
      operations.delete(id);
      return { operationId, released: true };
    },
    async listChanges(input): Promise<DurableRecoveryChangeSelection> {
      return {
        changes: [...changes.values()]
          .filter((change) => change.workspaceId === input.workspaceId && (!input.executionId || change.executionId === input.executionId))
          .map(({ workspaceId: _workspaceId, ...change }) => structuredClone(change)),
        turns: [...turns.values()]
          .filter((turn) => turn.workspaceId === input.workspaceId && (!input.executionId || turn.executionId === input.executionId))
          .map(({ workspaceId: _workspaceId, ...turn }) => structuredClone(turn)),
      };
    },
    async recordIntegrationChanges(input) {
      const turn = turns.get(`${input.workspaceId}\0${input.executionId}`);
      if (!turn || (turn.status !== "pending" && turn.status !== "ready")) return false;
      if (turn.status === "ready") {
        return Object.entries(input.changes).every(([path, states]) => {
          const prior = changes.get(`${input.workspaceId}\0${turn.checkpointId}\0${path}`);
          return prior !== undefined && JSON.stringify(prior.after) === JSON.stringify(states.after);
        });
      }
      for (const [path, states] of Object.entries(input.changes).sort(([left], [right]) => left.localeCompare(right))) {
        const id = `${input.workspaceId}\0${turn.checkpointId}\0${path}`;
        const prior = changes.get(id);
        changes.set(id, {
          workspaceId: input.workspaceId,
          checkpointId: turn.checkpointId,
          executionId: input.executionId,
          mutationId: prior?.mutationId ?? `thread.merge:${input.operationId}:${path}`,
          path,
          sequence: turn.sequence,
          toolName: prior?.toolName ?? "thread.merge",
          before: prior?.before ?? structuredClone(states.before),
          after: structuredClone(states.after),
        });
      }
      return true;
    },
    async createNamedCheckpoint(workspaceId, name) {
      const createdAt = new Date().toISOString();
      const values = checkpoints.get(workspaceId) ?? [];
      const checkpoint = {
        id: `checkpoint-${values.length + 1}`,
        workspaceId,
        sequence: values.length + 1,
        source: "named",
        state: "ready",
        createdAt,
        changedPathCount: 0,
        byteLength: 0,
        name,
      };
      values.unshift(checkpoint);
      checkpoints.set(workspaceId, values);
      return structuredClone(checkpoint) as never;
    },
    async listCheckpoints(workspaceId) {
      return structuredClone(checkpoints.get(workspaceId) ?? []) as never;
    },
    async recordMutationAfter() { return true; },
    async recordMutationBefore() { return true; },
    async recordTurnSettled(input) {
      const turnKey = `${input.workspaceId}\0${input.executionId}`;
      const previous = turns.get(turnKey);
      const next = {
        workspaceId: input.workspaceId,
        executionId: input.executionId,
        checkpointId: previous?.checkpointId ?? `turn-${input.executionId}`,
        sequence: previous?.sequence ?? ++turnSequence,
        activeWriterScopes: [...input.activeWriterScopes],
        status: input.observationComplete ? "ready" : "incomplete",
        unrecordedResourceIds: [],
        ...(input.failure ? { failure: structuredClone(input.failure) as unknown as Record<string, unknown> } : {}),
      };
      turns.set(turnKey, next);
      return {
        executionId: input.executionId, workspaceId: input.workspaceId, checkpointId: next.checkpointId,
        status: next.status, activeWriterScopes: next.activeWriterScopes, unrecordedResourceIds: [],
      } as never;
    },
    async recordTurnStart(input) {
      const turnKey = `${input.workspaceId}\0${input.executionId}`;
      const next = {
        workspaceId: input.workspaceId, executionId: input.executionId, checkpointId: `turn-${input.executionId}`,
        sequence: ++turnSequence, activeWriterScopes: [...input.activeWriterScopes], status: "pending", unrecordedResourceIds: [],
        ...(input.failure ? { failure: structuredClone(input.failure) as unknown as Record<string, unknown> } : {}),
      };
      turns.set(turnKey, next);
      return {
        executionId: input.executionId, workspaceId: input.workspaceId, checkpointId: next.checkpointId,
        status: "pending", activeWriterScopes: next.activeWriterScopes, unrecordedResourceIds: [],
      } as never;
    },
    async resolveEntry() {
      return {
        status: "failed",
        failure: { code: "checkpoint-missing", message: "The in-memory fixture has no entry binding", origin: "storage", retryable: false },
      } as never;
    },
    async health() { return { blobs: 0, catalogBytes: 0, walBytes: 0 }; },
    async collectUnreachableObjects() { return { byteLengthReclaimed: 0, objectsDeleted: 0 }; },
  };
};
