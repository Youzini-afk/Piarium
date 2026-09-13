import type { WorkspaceRecoveryEngine } from "../recovery/engine.js";
import type {
  WorkspaceRecoveryCheckpointInput,
  WorkspaceRecoveryCheckpointQuery,
  WorkspaceRecoveryCheckpointSummary,
  WorkspaceRecoveryMutationAfterInput,
  WorkspaceRecoveryMutationBeforeInput,
  WorkspaceRecoveryTurnBinding,
  WorkspaceRecoveryTurnSettledInput,
  WorkspaceRecoveryTurnStartInput,
} from "@piarium/extension-contract";
import { KernelStorageAdapter } from "./storage-adapter.js";

type RecordContext = Awaited<ReturnType<KernelStorageAdapter["context"]>>;

const checkpointIdFor = (executionId: string): string => `recovery-checkpoint:${executionId}`;
const turnRecordId = (executionId: string): string => `recovery-turn:${executionId}`;
const toSummary = (payload: Record<string, unknown>): WorkspaceRecoveryCheckpointSummary => ({
  byteLength: Number(payload.byteLength ?? 0),
  changedPathCount: Number(payload.changedPathCount ?? 0),
  createdAt: String(payload.createdAt ?? new Date().toISOString()),
  ...(typeof payload.entryId === "string" ? { entryId: payload.entryId } : {}),
  ...(typeof payload.executionId === "string" ? { executionId: payload.executionId } : {}),
  id: String(payload.id),
  ...(typeof payload.label === "string" ? { label: payload.label } : {}),
  sequence: Number(payload.sequence ?? 0),
  ...(typeof payload.sessionId === "string" ? { sessionId: payload.sessionId } : {}),
  source: payload.source === "named" || payload.source === "restore" ? payload.source : "turn",
  state: payload.state === "ready" || payload.state === "incomplete" ? payload.state : "pending",
  workspaceId: String(payload.workspaceId),
});

const turnBinding = (payload: Record<string, unknown>): WorkspaceRecoveryTurnBinding => ({
  activeWriterScopes: Array.isArray(payload.activeWriterScopes) ? payload.activeWriterScopes.filter((item): item is string => typeof item === "string") : [],
  ...(typeof payload.assistantEntryId === "string" ? { assistantEntryId: payload.assistantEntryId } : {}),
  checkpointId: String(payload.checkpointId),
  executionId: String(payload.executionId),
  ...(payload.failure && typeof payload.failure === "object" ? { failure: payload.failure as WorkspaceRecoveryTurnBinding["failure"] } : {}),
  provenance: payload.provenance === "overlapped" || payload.provenance === "observed-during" ? payload.provenance : "caused-by",
  runtimeGeneration: Number(payload.runtimeGeneration ?? 0),
  runtimeKey: String(payload.runtimeKey ?? `${String(payload.workerId)}@${String(payload.runtimeGeneration)}`),
  sessionId: String(payload.sessionId),
  ...(typeof payload.settledAt === "string" ? { settledAt: payload.settledAt } : {}),
  startedAt: String(payload.startedAt ?? new Date().toISOString()),
  status: payload.status === "ready" || payload.status === "incomplete" ? payload.status : "pending",
  unrecordedResourceIds: Array.isArray(payload.unrecordedResourceIds) ? payload.unrecordedResourceIds.filter((item): item is string => typeof item === "string") : [],
  userEntryId: String(payload.userEntryId),
  workerId: String(payload.workerId),
  workspaceId: String(payload.workspaceId),
} as unknown as WorkspaceRecoveryTurnBinding);

const withContext = async <T>(adapter: KernelStorageAdapter, workspaceId: string, purpose: string, fn: (context: RecordContext) => Promise<T>): Promise<T> => fn(await adapter.context(workspaceId, purpose));

export const createKernelRecoveryRecordFacade = (base: WorkspaceRecoveryEngine, adapter: KernelStorageAdapter): WorkspaceRecoveryEngine => {
  const facade = { ...base } as WorkspaceRecoveryEngine;
  facade.createCheckpoint = async (input: WorkspaceRecoveryCheckpointInput) => withContext(adapter, input.workspaceId, "recovery-checkpoint", async (context) => {
    const existing = await context.records.list({ recordType: "recovery.checkpoint" });
    const id = `recovery-checkpoint:${input.workspaceId}:${input.name}`;
    const payload = { id, workspaceId: input.workspaceId, label: input.name, sequence: existing.length + 1, source: "named", state: "ready", createdAt: new Date().toISOString(), changedPathCount: 0, byteLength: 0 };
    await context.records.put({ operationId: `checkpoint:${id}`, recordId: id, recordType: "recovery.checkpoint", state: "ready", payloadJson: JSON.stringify(payload) });
    return { status: "ready", checkpoint: toSummary(payload) } as never;
  });
  facade.listCheckpoints = async (input: WorkspaceRecoveryCheckpointQuery) => withContext(adapter, input.workspaceId, "recovery-checkpoint-list", async (context) => {
    const rows = await context.records.list({ recordType: "recovery.checkpoint" });
    const cursor = input.cursor ?? 0; const limit = input.limit ?? rows.length; const page = rows.slice(cursor, cursor + limit).map((row) => toSummary(JSON.parse(row.payloadJson) as Record<string, unknown>));
    return { status: "ready", page: { checkpoints: page, nextCursor: cursor + page.length < rows.length ? cursor + page.length : null } } as never;
  });
  facade.recordTurnStart = async (input: WorkspaceRecoveryTurnStartInput) => withContext(adapter, input.workspaceId, "recovery-turn-start", async (context) => {
    const checkpointId = checkpointIdFor(input.executionId); const startedAt = new Date().toISOString();
    const payload = { ...input, checkpointId, runtimeKey: `${input.workerId}@${input.runtimeGeneration}`, status: input.failure ? "incomplete" : "pending", startedAt, unrecordedResourceIds: [], userEntryId: input.userEntryId };
    await context.records.put({ operationId: `turn-start:${input.executionId}`, recordId: turnRecordId(input.executionId), recordType: "recovery.turn", state: String(payload.status), sessionId: input.sessionId, payloadJson: JSON.stringify(payload) });
    return { status: "ready", binding: turnBinding(payload) } as never;
  });
  facade.recordTurnSettled = async (input: WorkspaceRecoveryTurnSettledInput) => withContext(adapter, input.workspaceId, "recovery-turn-settle", async (context) => {
    const record = await context.records.get(turnRecordId(input.executionId)); if (!record) return { status: "failed", failure: { code: "checkpoint-missing", message: "Turn binding is missing", retryable: true } } as never;
    const payload = { ...(JSON.parse(record.payloadJson) as Record<string, unknown>), ...input, status: input.failure || !input.observationComplete ? "incomplete" : "ready", settledAt: new Date().toISOString(), unrecordedResourceIds: input.observedResourceIds };
    await context.records.put({ operationId: `turn-settle:${input.executionId}`, recordId: record.recordId, recordType: "recovery.turn", state: String(payload.status), sessionId: String((payload as Record<string, unknown>).sessionId), payloadJson: JSON.stringify(payload) });
    return { status: "ready", binding: turnBinding(payload) } as never;
  });
  facade.recordMutationBefore = async (input: WorkspaceRecoveryMutationBeforeInput) => withContext(adapter, input.workspaceId, "recovery-mutation-before", async (context) => { await context.records.put({ operationId: `mutation-before:${input.executionId}:${input.mutationId}:${input.path}`, recordId: `recovery-change:${input.executionId}:${input.mutationId}:${input.path}`, recordType: "recovery.change", state: "before", payloadJson: JSON.stringify(input) }); return { status: "ready", recorded: true } as never; });
  facade.recordMutationAfter = async (input: WorkspaceRecoveryMutationAfterInput) => withContext(adapter, input.workspaceId, "recovery-mutation-after", async (context) => { await context.records.put({ operationId: `mutation-after:${input.executionId}:${input.mutationId}:${input.path}`, recordId: `recovery-change:${input.executionId}:${input.mutationId}:${input.path}`, recordType: "recovery.change", state: input.succeeded ? "after" : "failed", payloadJson: JSON.stringify(input) }); return { status: "ready", recorded: true } as never; });
  return facade;
};
