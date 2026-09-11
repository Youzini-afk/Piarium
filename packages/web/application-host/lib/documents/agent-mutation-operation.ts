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

const parsePersisted = (row: Pick<OperationRow, "data_json">): PersistedAgentMutationData => {
  const raw = JSON.parse(row.data_json) as PersistedAgentMutationData;
  return raw;
};

const stateFromJson = (value: string | null, label: string): RecoveryState => {
  if (!value) throw new Error(`Agent mutation ${label} state is missing`);
  return parseRecoveryState(JSON.parse(value) as unknown);
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
  context.database.transaction(() => {
    writeRecord(context.database, spec.workspaceId, "applying", data, createdAt);
    initOperationFiles(context.database, spec.operationId, spec.targets);
    for (const [file, state] of Object.entries(spec.safety)) {
      updateOperationFilePhase(
        context.database,
        spec.operationId,
        file,
        spec.targetKinds[file] === "surface" ? "external-intent" : "apply-intent",
        { safetyJson: JSON.stringify(state) },
      );
    }
  }).immediate();
  return data;
};

export const markAgentMutationPathApplied = (
  context: DurableFileOperationContext,
  data: PersistedAgentMutationData,
  path: string,
  extras?: {
    afterLocalEditRevision?: number;
    afterHash?: string;
  },
): void => {
  if (!data.appliedPaths.includes(path)) data.appliedPaths.push(path);
  const binding = data.surfaceBindings[path];
  if (binding && extras?.afterLocalEditRevision !== undefined && extras.afterHash) {
    data.surfaceBindings[path] = {
      ...binding,
      afterLocalEditRevision: extras.afterLocalEditRevision,
      afterHash: extras.afterHash,
    };
  }
  updateOperationFilePhase(
    context.database,
    data.operationId,
    path,
    data.targetKinds[path] === "surface" ? "external-target-observed" : "target-observed",
  );
  writeRecord(context.database, data.workspaceId, "applying", data, new Date().toISOString());
};

export const markAgentMutationPathNeedsAttention = (
  context: DurableFileOperationContext,
  data: PersistedAgentMutationData,
  path: string,
  failure?: string,
): void => {
  if (!data.needsAttentionPaths.includes(path)) data.needsAttentionPaths.push(path);
  if (failure) data.failure = failure;
  try {
    updateOperationFilePhase(context.database, data.operationId, path, "needs-attention");
  } catch {
    /* The operation row still records needs-attention. */
  }
  writeRecord(context.database, data.workspaceId, "needs-attention", data, new Date().toISOString());
};

export const compensateAgentMutationDiskPath = async (
  context: DurableFileOperationContext,
  data: PersistedAgentMutationData,
  path: string,
): Promise<"compensated" | "needs-attention"> => {
  const safety = data.safety[path];
  const target = data.targets[path]?.target;
  if (!safety || !target) {
    markAgentMutationPathNeedsAttention(context, data, path, `${path} has no durable before/after identity`);
    return "needs-attention";
  }
  updateOperationFilePhase(context.database, data.operationId, path, "compensate-intent");
  try {
    const current = (await context.fileStore.captureState(context.identity, context.root, path, { store: false })).state;
    if (sameState(current, safety)) {
      updateOperationFilePhase(context.database, data.operationId, path, "safety-observed");
      if (!data.compensatedPaths.includes(path)) data.compensatedPaths.push(path);
      writeRecord(context.database, data.workspaceId, "applying", data, new Date().toISOString());
      return "compensated";
    }
    if (!sameState(current, target)) {
      markAgentMutationPathNeedsAttention(context, data, path, `${path} drifted away from the applied identity`);
      return "needs-attention";
    }
    await context.fileStore.applyState(context.identity, context.root, path, safety);
    const restored = (await context.fileStore.captureState(context.identity, context.root, path, { store: false })).state;
    if (!sameState(restored, safety)) throw new Error(`Compensation did not restore ${path}`);
    updateOperationFilePhase(context.database, data.operationId, path, "safety-observed");
    if (!data.compensatedPaths.includes(path)) data.compensatedPaths.push(path);
    writeRecord(context.database, data.workspaceId, "applying", data, new Date().toISOString());
    return "compensated";
  } catch (error) {
    markAgentMutationPathNeedsAttention(
      context,
      data,
      path,
      error instanceof Error ? error.message : String(error),
    );
    return "needs-attention";
  }
};

export const markAgentMutationSurfaceCompensated = (
  context: DurableFileOperationContext,
  data: PersistedAgentMutationData,
  path: string,
): void => {
  if (!data.compensatedPaths.includes(path)) data.compensatedPaths.push(path);
  updateOperationFilePhase(context.database, data.operationId, path, "external-safety-observed");
  writeRecord(context.database, data.workspaceId, "applying", data, new Date().toISOString());
};

export const finalizeAgentMutationOperation = (
  context: DurableFileOperationContext,
  data: PersistedAgentMutationData,
  results: DocumentSurfaceWritePathResult[],
): void => {
  data.results = results;
  const state = data.needsAttentionPaths.length > 0
    ? "needs-attention"
    : data.compensatedPaths.length > 0
      ? "compensated"
      : "complete";
  writeRecord(context.database, data.workspaceId, state, data, new Date().toISOString());
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
  const rows = context.database.prepare(`
    SELECT * FROM operations WHERE kind = ?
    AND workspace_id = ?
    AND state NOT IN ('complete', 'aborted', 'compensated', 'needs-attention', 'conflict')
  `).all(AGENT_MUTATION_KIND, context.identity.workspaceId) as Array<OperationRow & { created_at: string }>;
  const result = { compensated: [] as string[], needsAttention: [] as string[], aborted: [] as string[] };
  for (const row of rows) {
    const data = parsePersisted(row);
    let unknown = false;
    const fileRows = operationFileRows(context.database, row.id);
    for (const fileRow of fileRows) {
      const kind = data.targetKinds[fileRow.path];
      if (kind === "surface") {
        const binding = data.surfaceBindings[fileRow.path];
        const ownerAvailable = binding
          ? options.surfaceOwnerAvailable?.(binding) === true
          : false;
        if (fileRow.phase === "external-intent") {
          updateOperationFilePhase(context.database, row.id, fileRow.path, "external-safety-observed");
          continue;
        }
        if (!ownerAvailable) {
          updateOperationFilePhase(context.database, row.id, fileRow.path, "needs-attention");
          if (!data.needsAttentionPaths.includes(fileRow.path)) data.needsAttentionPaths.push(fileRow.path);
          unknown = true;
          continue;
        }
        if (fileRow.phase !== "external-safety-observed") {
          updateOperationFilePhase(context.database, row.id, fileRow.path, "needs-attention");
          if (!data.needsAttentionPaths.includes(fileRow.path)) data.needsAttentionPaths.push(fileRow.path);
          unknown = true;
        }
        continue;
      }
      const target = data.targets[fileRow.path]?.target
        ?? stateFromJson(fileRow.target_json, `${fileRow.path} target`);
      const safety = data.safety[fileRow.path]
        ?? stateFromJson(fileRow.safety_json, `${fileRow.path} safety`);
      const current = await observeDisk(context, fileRow.path);
      if (fileRow.phase === "apply-intent") {
        if (sameState(current, target)) updateOperationFilePhase(context.database, row.id, fileRow.path, "target-observed");
        else if (!sameState(current, safety)) {
          updateOperationFilePhase(context.database, row.id, fileRow.path, "needs-attention");
          unknown = true;
        }
      } else if (fileRow.phase === "target-observed" && !sameState(current, target)) {
        updateOperationFilePhase(context.database, row.id, fileRow.path, "needs-attention");
        unknown = true;
      } else if (fileRow.phase === "compensate-intent") {
        if (sameState(current, safety)) updateOperationFilePhase(context.database, row.id, fileRow.path, "safety-observed");
        else if (!sameState(current, target)) {
          updateOperationFilePhase(context.database, row.id, fileRow.path, "needs-attention");
          unknown = true;
        }
      }
    }
    if (unknown) {
      writeRecord(context.database, row.workspace_id, "needs-attention", data, row.created_at);
      result.needsAttention.push(row.id);
      continue;
    }
    const currentRows = operationFileRows(context.database, row.id);
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
      const state = data.needsAttentionPaths.length > 0 ? "needs-attention" : "compensated";
      writeRecord(context.database, row.workspace_id, state, data, row.created_at);
      (state === "compensated" ? result.compensated : result.needsAttention).push(row.id);
    } else {
      writeRecord(context.database, row.workspace_id, "aborted", data, row.created_at);
      result.aborted.push(row.id);
    }
  }
  return result;
};

export const listAgentMutationFileRows = (
  database: SqliteDatabase,
  operationId: string,
): OperationFileRow[] => operationFileRows(database, operationId);
