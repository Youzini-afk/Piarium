import type { DocumentSurfaceWritePathResult } from "@piarium/protocol";
import {
  initOperationFiles,
  operationFileRows,
  updateOperationFilePhase,
  writeOperationRow,
  type OperationFileRow,
  type OperationRow,
  type SqliteDatabase,
} from "../recovery/journal-catalog.js";
import type { DurableFileOperationContext } from "../recovery/durable-file-operation.js";
import {
  parseRecoveryState,
  sameState,
  type RecoveryState,
} from "../recovery/journal-files.js";

export const AGENT_MUTATION_KIND = "agent-mutation";

export interface AgentMutationSurfaceBinding {
  ownerId: string;
  ownerGeneration: number;
  ownerRegistrationId: string;
  documentInstanceId: string;
  baseRevision: string | null;
  beforeLocalEditRevision: number;
  beforeHash: string;
  encoding: string;
  bom: boolean;
  lineEnding: "lf" | "crlf" | "cr";
  afterLocalEditRevision?: number;
  afterHash?: string;
}

export interface AgentMutationDiskIdentity {
  encoding: string;
  bom: boolean;
  revision: string | null;
  existed: boolean;
}

export interface PersistedAgentMutationData extends Record<string, unknown> {
  operationId: string;
  sessionId: string;
  workspaceId: string;
  intent: "agent-surface-write";
  targetKinds: Record<string, "surface" | "disk">;
  surfaceBindings: Record<string, AgentMutationSurfaceBinding>;
  diskIdentities: Record<string, AgentMutationDiskIdentity>;
  targets: Record<string, { expected: RecoveryState; target: RecoveryState }>;
  safety: Record<string, RecoveryState>;
  appliedPaths: string[];
  compensatedPaths: string[];
  needsAttentionPaths: string[];
  results: DocumentSurfaceWritePathResult[];
  failure?: string;
  durableRevision?: number;
  durablePhases?: Record<string, string>;
}

export interface AgentMutationBeginSpec {
  operationId: string;
  sessionId: string;
  workspaceId: string;
  targetKinds: Record<string, "surface" | "disk">;
  surfaceBindings?: Record<string, AgentMutationSurfaceBinding>;
  diskIdentities?: Record<string, AgentMutationDiskIdentity>;
  targets: Record<string, { expected: RecoveryState; target: RecoveryState }>;
  safety: Record<string, RecoveryState>;
}

const writeRecord = (
  database: SqliteDatabase,
  workspaceId: string,
  state: string,
  data: PersistedAgentMutationData,
  createdAt: string,
): void => writeOperationRow(database, {
  id: data.operationId,
  workspaceId,
  kind: AGENT_MUTATION_KIND,
  state,
  data,
  createdAt,
  updatedAt: new Date().toISOString(),
});

const durableState = (
  data: Pick<PersistedAgentMutationData, "needsAttentionPaths">,
  requested: string,
): string => data.needsAttentionPaths.length > 0 ? "needs-attention" : requested;

const parsePersisted = (row: Pick<OperationRow, "data_json">): PersistedAgentMutationData => {
  const raw = JSON.parse(row.data_json) as PersistedAgentMutationData;
  return raw;
};

const stateFromJson = (value: string | null, label: string): RecoveryState => {
  if (!value) throw new Error(`Agent mutation ${label} state is missing`);
  return parseRecoveryState(JSON.parse(value) as unknown);
};

const kernelPhase = async (
  context: DurableFileOperationContext,
  data: PersistedAgentMutationData,
  path: string,
  phase: string,
  fields: { expected?: RecoveryState; target?: RecoveryState; safety?: RecoveryState } = {},
): Promise<void> => {
  const durable = context.durableRecoveryStore;
  if (!durable) return;
  const operation = await durable.getOperation(data.workspaceId, data.operationId, data.sessionId);
  if (!operation) throw new Error(`Agent mutation ${data.operationId} has no durable operation`);
  const files = Array.isArray(operation.files) ? operation.files : [];
  const file = files.find((entry) => entry && typeof entry === "object" && (entry as Record<string, unknown>).path === path) as Record<string, unknown> | undefined;
  if (!file) throw new Error(`Agent mutation path is not durable: ${path}`);
  await durable.updateOperationFile({ operationId: data.operationId, workspaceId: data.workspaceId, path, expectedRevision: Number(file.revision ?? 1), expectedPhase: String(file.phase ?? "pending"), phase, ...fields, sessionId: data.sessionId });
  data.durableRevision = Number(operation.revision ?? data.durableRevision ?? 1);
  data.durablePhases = { ...(data.durablePhases ?? {}), [path]: phase };
};

const kernelComplete = async (context: DurableFileOperationContext, data: PersistedAgentMutationData, state: string, resultData: Record<string, unknown>): Promise<void> => {
  const durable = context.durableRecoveryStore;
  if (!durable) return;
  const operation = await durable.getOperation(data.workspaceId, data.operationId, data.sessionId);
  if (!operation) throw new Error(`Agent mutation ${data.operationId} has no durable operation`);
  const result = await durable.completeOperation({ operationId: data.operationId, workspaceId: data.workspaceId, expectedRevision: Number(operation.revision ?? 1), state, result: resultData, sessionId: data.sessionId });
  data.durableRevision = Number(result.revision ?? operation.revision ?? 1);
};

export const beginAgentMutationOperationAsync = async (
  context: DurableFileOperationContext,
  spec: AgentMutationBeginSpec,
): Promise<PersistedAgentMutationData> => {
  const data: PersistedAgentMutationData = {
    operationId: spec.operationId,
    sessionId: spec.sessionId,
    workspaceId: spec.workspaceId,
    intent: "agent-surface-write",
    targetKinds: { ...spec.targetKinds },
    surfaceBindings: structuredClone(spec.surfaceBindings ?? {}),
    diskIdentities: structuredClone(spec.diskIdentities ?? {}),
    targets: structuredClone(spec.targets),
    safety: structuredClone(spec.safety),
    appliedPaths: [],
    compensatedPaths: [],
    needsAttentionPaths: [],
    results: [],
  };
  if (!context.durableRecoveryStore) return beginAgentMutationOperation(context, spec);
  const created = await context.durableRecoveryStore.createOperation({
    operationId: spec.operationId,
    workspaceId: spec.workspaceId,
    kind: AGENT_MUTATION_KIND,
    state: "applying",
    data,
    targets: spec.targets,
    sessionId: spec.sessionId,
  });
  data.durableRevision = Number(created.revision ?? 1);
  data.durablePhases = Object.fromEntries(Object.keys(spec.targets).map((path) => [path, "pending"]));
  for (const [path, safety] of Object.entries(spec.safety)) {
    const phase = spec.targetKinds[path] === "surface" ? "external-intent" : "apply-intent";
    await kernelPhase(context, data, path, phase, { safety });
  }
  return data;
};

export const beginAgentMutationOperation = (
  context: DurableFileOperationContext,
  spec: AgentMutationBeginSpec,
): PersistedAgentMutationData => {
  const createdAt = new Date().toISOString();
  const data: PersistedAgentMutationData = {
    operationId: spec.operationId,
    sessionId: spec.sessionId,
    workspaceId: spec.workspaceId,
    intent: "agent-surface-write",
    targetKinds: { ...spec.targetKinds },
    surfaceBindings: structuredClone(spec.surfaceBindings ?? {}),
    diskIdentities: structuredClone(spec.diskIdentities ?? {}),
    targets: structuredClone(spec.targets),
    safety: structuredClone(spec.safety),
    appliedPaths: [],
    compensatedPaths: [],
    needsAttentionPaths: [],
    results: [],
  };
  context.database!.transaction(() => {
    writeRecord(context.database!, spec.workspaceId, "applying", data, createdAt);
    initOperationFiles(context.database!, spec.operationId, spec.targets);
    for (const [file, state] of Object.entries(spec.safety)) {
      updateOperationFilePhase(
        context.database!,
        spec.operationId,
        file,
        spec.targetKinds[file] === "surface" ? "external-intent" : "apply-intent",
        { safetyJson: JSON.stringify(state) },
      );
    }
  }).immediate();
  return data;
};

export const markAgentMutationPathApplied = async (
  context: DurableFileOperationContext,
  data: PersistedAgentMutationData,
  path: string,
  extras?: {
    afterLocalEditRevision?: number;
    afterHash?: string;
    target?: RecoveryState;
  },
): Promise<void> => {
  if (!data.appliedPaths.includes(path)) data.appliedPaths.push(path);
  const binding = data.surfaceBindings[path];
  if (binding && extras?.afterLocalEditRevision !== undefined && extras.afterHash) {
    data.surfaceBindings[path] = {
      ...binding,
      afterLocalEditRevision: extras.afterLocalEditRevision,
      afterHash: extras.afterHash,
    };
  }
  if (extras?.target) {
    const current = data.targets[path];
    data.targets[path] = {
      expected: current?.expected ?? data.safety[path] ?? { kind: "missing" },
      target: extras.target,
    };
  }
  if (context.durableRecoveryStore) {
    await kernelPhase(context, data, path, data.targetKinds[path] === "surface" ? "external-target-observed" : "target-observed", extras?.target ? { target: extras.target } : {});
    return;
  }
  updateOperationFilePhase(
    context.database!,
    data.operationId,
    path,
    data.targetKinds[path] === "surface" ? "external-target-observed" : "target-observed",
    extras?.target ? { targetJson: JSON.stringify(extras.target) } : {},
  );
  writeRecord(context.database!, data.workspaceId, durableState(data, "applying"), data, new Date().toISOString());
};

export const markAgentMutationSurfaceDispatched = async (
  context: DurableFileOperationContext,
  data: PersistedAgentMutationData,
  path: string,
): Promise<void> => {
  if (context.durableRecoveryStore) { await kernelPhase(context, data, path, "external-dispatched"); return; }
  updateOperationFilePhase(context.database!, data.operationId, path, "external-dispatched");
  writeRecord(context.database!, data.workspaceId, durableState(data, "applying"), data, new Date().toISOString());
};

export const markAgentMutationSurfaceCompensateIntent = async (
  context: DurableFileOperationContext,
  data: PersistedAgentMutationData,
  path: string,
): Promise<void> => {
  if (context.durableRecoveryStore) { await kernelPhase(context, data, path, "external-compensate-intent"); return; }
  updateOperationFilePhase(context.database!, data.operationId, path, "external-compensate-intent");
  writeRecord(context.database!, data.workspaceId, durableState(data, "applying"), data, new Date().toISOString());
};

/**
 * A surface response that explicitly says the forward request was rejected
 * proves that this path stayed at its safety identity. It is safe to close
 * the external phase without adding it to compensation or attention.
 */
export const markAgentMutationSurfaceNotApplied = async (
  context: DurableFileOperationContext,
  data: PersistedAgentMutationData,
  path: string,
): Promise<void> => {
  if (context.durableRecoveryStore) { await kernelPhase(context, data, path, "external-safety-observed"); return; }
  updateOperationFilePhase(context.database!, data.operationId, path, "external-safety-observed");
  writeRecord(context.database!, data.workspaceId, durableState(data, "applying"), data, new Date().toISOString());
};

export const markAgentMutationPathNeedsAttention = async (
  context: DurableFileOperationContext,
  data: PersistedAgentMutationData,
  path: string,
  failure?: string,
): Promise<void> => {
  if (!data.needsAttentionPaths.includes(path)) data.needsAttentionPaths.push(path);
  if (failure) data.failure = failure;
  if (context.durableRecoveryStore) { await kernelPhase(context, data, path, "needs-attention"); return; }
  try {
    updateOperationFilePhase(context.database!, data.operationId, path, "needs-attention");
  } catch {
    /* The operation row still records needs-attention. */
  }
  writeRecord(context.database!, data.workspaceId, "needs-attention", data, new Date().toISOString());
};

export const compensateAgentMutationDiskPath = async (
  context: DurableFileOperationContext,
  data: PersistedAgentMutationData,
  path: string,
  options: { gateHeld?: boolean } = {},
): Promise<"compensated" | "needs-attention"> => {
  const safety = data.safety[path];
  const target = data.targets[path]?.target;
  if (!safety || !target) {
    await markAgentMutationPathNeedsAttention(context, data, path, `${path} has no durable before/after identity`);
    return "needs-attention";
  }
  const run = async (): Promise<"compensated" | "needs-attention"> => {
    if (context.durableRecoveryStore) await kernelPhase(context, data, path, "compensate-intent");
    else updateOperationFilePhase(context.database!, data.operationId, path, "compensate-intent");
    try {
      const current = (await context.fileStore.captureState(context.identity, context.root, path, { store: false })).state;
      if (sameState(current, safety)) {
        if (context.durableRecoveryStore) await kernelPhase(context, data, path, "safety-observed");
        else updateOperationFilePhase(context.database!, data.operationId, path, "safety-observed");
        if (!data.compensatedPaths.includes(path)) data.compensatedPaths.push(path);
        writeRecord(context.database!, data.workspaceId, durableState(data, "applying"), data, new Date().toISOString());
        return "compensated";
      }
      if (!sameState(current, target)) {
        await markAgentMutationPathNeedsAttention(context, data, path, `${path} drifted away from the applied identity`);
        return "needs-attention";
      }
      await context.fileStore.applyState(context.identity, context.root, path, safety);
      const restored = (await context.fileStore.captureState(context.identity, context.root, path, { store: false })).state;
      if (!sameState(restored, safety)) throw new Error(`Compensation did not restore ${path}`);
      if (context.durableRecoveryStore) await kernelPhase(context, data, path, "safety-observed");
      else updateOperationFilePhase(context.database!, data.operationId, path, "safety-observed");
      if (!data.compensatedPaths.includes(path)) data.compensatedPaths.push(path);
      writeRecord(context.database!, data.workspaceId, durableState(data, "applying"), data, new Date().toISOString());
      return "compensated";
    } catch (error) {
      await markAgentMutationPathNeedsAttention(
        context,
        data,
        path,
        error instanceof Error ? error.message : String(error),
      );
      return "needs-attention";
    }
  };
  return options.gateHeld
    ? run()
    : context.resourceOperationGate.run([{ resourceId: path, scope: "exact" }], run);
};

export const markAgentMutationSurfaceCompensated = async (
  context: DurableFileOperationContext,
  data: PersistedAgentMutationData,
  path: string,
): Promise<void> => {
  if (!data.compensatedPaths.includes(path)) data.compensatedPaths.push(path);
  if (context.durableRecoveryStore) { await kernelPhase(context, data, path, "external-safety-observed"); return; }
  updateOperationFilePhase(context.database!, data.operationId, path, "external-safety-observed");
  writeRecord(context.database!, data.workspaceId, durableState(data, "applying"), data, new Date().toISOString());
};

export const finalizeAgentMutationOperation = async (
  context: DurableFileOperationContext,
  data: PersistedAgentMutationData,
  results: DocumentSurfaceWritePathResult[],
): Promise<void> => {
  data.results = results;
  const state = data.needsAttentionPaths.length > 0
    ? "needs-attention"
    : data.compensatedPaths.length > 0
      ? "compensated"
      : data.appliedPaths.length > 0
        ? "complete"
        : "aborted";
  if (context.durableRecoveryStore) { await kernelComplete(context, data, state, data); return; }
  writeRecord(context.database!, data.workspaceId, state, data, new Date().toISOString());
};

export const inspectAgentMutationOperation = (
  database: SqliteDatabase,
  operationId: string,
): { state: string; data: PersistedAgentMutationData } | null => {
  const row = database.prepare("SELECT * FROM operations WHERE id = ? AND kind = ?")
    .get(operationId, AGENT_MUTATION_KIND) as (OperationRow & { created_at: string }) | undefined;
  if (!row) return null;
  return { state: row.state, data: parsePersisted(row) };
};

const observeDisk = async (
  context: DurableFileOperationContext,
  path: string,
): Promise<RecoveryState> => (
  (await context.fileStore.captureState(context.identity, context.root, path, { store: false })).state
);

export const reconcileInterruptedAgentMutations = async (
  context: DurableFileOperationContext,
  options: {
    surfaceOwnerAvailable?: (binding: AgentMutationSurfaceBinding) => boolean;
  } = {},
): Promise<{ compensated: string[]; needsAttention: string[]; aborted: string[] }> => {
  void options.surfaceOwnerAvailable;
  if (context.durableRecoveryStore) {
    const outcome = { compensated: [] as string[], needsAttention: [] as string[], aborted: [] as string[] };
    for (const summary of await context.durableRecoveryStore.listOperations(context.identity.workspaceId, AGENT_MUTATION_KIND)) {
      const operationId = typeof summary.operationId === "string" ? summary.operationId : "";
      if (!operationId || ["complete", "aborted", "compensated", "conflict"].includes(String(summary.state))) continue;
      const durableOperation: Record<string, unknown> | null = await context.durableRecoveryStore.getOperation(context.identity.workspaceId, operationId, typeof summary.sessionId === "string" ? summary.sessionId : undefined);
      if (!durableOperation) continue;
      const data = (durableOperation.data && typeof durableOperation.data === "object" ? durableOperation.data : {}) as PersistedAgentMutationData;
      const files: Array<Record<string, unknown>> = Array.isArray(durableOperation.files) ? durableOperation.files.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object") : [];
      let revision = Number(durableOperation.revision ?? 1);
      let unknown = false;
      let compensated = false;
      const update = async (file: Record<string, unknown>, phase: string, fields: { expected?: RecoveryState; target?: RecoveryState; safety?: RecoveryState } = {}) => {
        const result = await context.durableRecoveryStore!.updateOperationFile({
          operationId, workspaceId: context.identity.workspaceId, path: String(file.path), expectedRevision: revision,
          expectedPhase: String(file.phase ?? "pending"), phase, ...fields,
          ...(typeof summary.sessionId === "string" ? { sessionId: summary.sessionId } : {}),
        });
        revision = Number(result.revision ?? revision + 1);
        file.phase = phase;
      };
      for (const file of files) {
        const path = String(file.path ?? "");
        const phase = String(file.phase ?? "pending");
        const parse = (key: string): RecoveryState | undefined => typeof file[key] === "string" ? parseRecoveryState(JSON.parse(String(file[key]))) : undefined;
        const target = parse("targetJson");
        const safety = parse("safetyJson");
        if (String(data.targetKinds?.[path]) === "surface") {
          if (phase !== "external-safety-observed") { await update(file, "needs-attention"); unknown = true; }
          continue;
        }
        if (!target || !safety) { await update(file, "needs-attention"); unknown = true; continue; }
        const current = await observeDisk(context, path);
        if (phase === "apply-intent" && sameState(current, target)) await update(file, "target-observed", { target });
        else if ((phase === "target-observed" || phase === "compensate-intent") && sameState(current, safety)) {
          await update(file, "safety-observed", { safety });
          compensated = true;
        }
        else if (!sameState(current, safety) && !sameState(current, target)) { await update(file, "needs-attention"); unknown = true; }
      }
      const state = unknown ? "needs-attention" : compensated || files.some((file: Record<string, unknown>) => String(file.phase).includes("target-observed")) ? "compensated" : "aborted";
      await context.durableRecoveryStore.completeOperation({ operationId, workspaceId: context.identity.workspaceId, expectedRevision: revision, state, result: data });
      (state === "needs-attention" ? outcome.needsAttention : state === "compensated" ? outcome.compensated : outcome.aborted).push(operationId);
    }
    return outcome;
  }
  const rows = context.database!.prepare(`
    SELECT * FROM operations WHERE kind = ?
    AND workspace_id = ?
    AND state NOT IN ('complete', 'aborted', 'compensated', 'conflict')
  `).all(AGENT_MUTATION_KIND, context.identity.workspaceId) as Array<OperationRow & { created_at: string }>;
  const result = { compensated: [] as string[], needsAttention: [] as string[], aborted: [] as string[] };
  for (const row of rows) {
    const data = parsePersisted(row);
    let unknown = false;
    const fileRows = operationFileRows(context.database!, row.id);
    for (const fileRow of fileRows) {
      const kind = data.targetKinds[fileRow.path];
      if (kind === "surface") {
        if (fileRow.phase === "external-intent") {
          updateOperationFilePhase(context.database!, row.id, fileRow.path, "external-safety-observed");
          continue;
        }
        // Once an external request was dispatched, a Host restart cannot prove
        // whether the Registry applied it or whether the receipt was lost.
        // Keep that uncertainty visible even when the owner is still online;
        // a boolean owner probe is not an application receipt.
        if (fileRow.phase !== "external-safety-observed") {
          updateOperationFilePhase(context.database!, row.id, fileRow.path, "needs-attention");
          if (!data.needsAttentionPaths.includes(fileRow.path)) data.needsAttentionPaths.push(fileRow.path);
          unknown = true;
        }
        continue;
      }
      // operation_files is updated at the phase boundary before the larger
      // operation row. Prefer its state so a crash in that small window still
      // recognizes a just-deleted target as `missing`.
      const target = fileRow.target_json
        ? stateFromJson(fileRow.target_json, `${fileRow.path} target`)
        : data.targets[fileRow.path]?.target
          ?? stateFromJson(fileRow.target_json, `${fileRow.path} target`);
      const safety = fileRow.safety_json
        ? stateFromJson(fileRow.safety_json, `${fileRow.path} safety`)
        : data.safety[fileRow.path]
          ?? stateFromJson(fileRow.safety_json, `${fileRow.path} safety`);
      const current = await observeDisk(context, fileRow.path);
      if (fileRow.phase === "apply-intent") {
        if (sameState(current, target)) {
          updateOperationFilePhase(context.database!, row.id, fileRow.path, "target-observed");
          if (!data.appliedPaths.includes(fileRow.path)) data.appliedPaths.push(fileRow.path);
        }
        else if (!sameState(current, safety)) {
          updateOperationFilePhase(context.database!, row.id, fileRow.path, "needs-attention");
          if (!data.needsAttentionPaths.includes(fileRow.path)) data.needsAttentionPaths.push(fileRow.path);
          unknown = true;
        }
      } else if (fileRow.phase === "target-observed") {
        if (sameState(current, safety)) {
          updateOperationFilePhase(context.database!, row.id, fileRow.path, "safety-observed");
          if (!data.compensatedPaths.includes(fileRow.path)) data.compensatedPaths.push(fileRow.path);
        } else if (!sameState(current, target)) {
          updateOperationFilePhase(context.database!, row.id, fileRow.path, "needs-attention");
          if (!data.needsAttentionPaths.includes(fileRow.path)) data.needsAttentionPaths.push(fileRow.path);
          unknown = true;
        }
      } else if (fileRow.phase === "compensate-intent") {
        if (sameState(current, safety)) {
          updateOperationFilePhase(context.database!, row.id, fileRow.path, "safety-observed");
          if (!data.compensatedPaths.includes(fileRow.path)) data.compensatedPaths.push(fileRow.path);
        }
        else if (!sameState(current, target)) {
          updateOperationFilePhase(context.database!, row.id, fileRow.path, "needs-attention");
          if (!data.needsAttentionPaths.includes(fileRow.path)) data.needsAttentionPaths.push(fileRow.path);
          unknown = true;
        }
      }
    }
    const currentRows = operationFileRows(context.database!, row.id);
    const needsDiskCompensate = currentRows.some((entry) => (
      data.targetKinds[entry.path] === "disk"
      && (entry.phase === "target-observed" || entry.phase === "compensate-intent")
    ));
    if (needsDiskCompensate) {
      for (const entry of currentRows) {
        if (data.targetKinds[entry.path] !== "disk") continue;
        if (entry.phase !== "target-observed" && entry.phase !== "compensate-intent") continue;
        await compensateAgentMutationDiskPath(context, data, entry.path);
      }
      const state = data.needsAttentionPaths.length > 0 || unknown || row.state === "needs-attention"
        ? "needs-attention"
        : "compensated";
      writeRecord(context.database!, row.workspace_id, state, data, row.created_at);
      (state === "compensated" ? result.compensated : result.needsAttention).push(row.id);
    } else {
      if (data.needsAttentionPaths.length > 0 || unknown || row.state === "needs-attention") {
        writeRecord(context.database!, row.workspace_id, "needs-attention", data, row.created_at);
        result.needsAttention.push(row.id);
      } else if (data.compensatedPaths.length > 0) {
        writeRecord(context.database!, row.workspace_id, "compensated", data, row.created_at);
        result.compensated.push(row.id);
      } else {
        writeRecord(context.database!, row.workspace_id, "aborted", data, row.created_at);
        result.aborted.push(row.id);
      }
    }
  }
  return result;
};

export const listAgentMutationFileRows = (
  database: SqliteDatabase,
  operationId: string,
): OperationFileRow[] => operationFileRows(database, operationId);
