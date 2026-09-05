import type { RecoveryFileStore, RecoveryIdentity, RecoveryState } from "./journal-files.js";
import { parseRecoveryState, sameState } from "./journal-files.js";
import type { OperationFileRow, OperationRow, SqliteDatabase } from "./journal-catalog.js";
import { initOperationFiles, operationFileRows, updateOperationFilePhase, writeOperationRow } from "./journal-catalog.js";
import { assertIntegrationTurnBinding, bindIntegrationOperationToTurn } from "./integration-turn-binding.js";

export interface DurableFileTarget {
  expected: RecoveryState;
  target: RecoveryState;
}

export interface DurableFileOperationSpec {
  id: string;
  workspaceId: string;
  threadId: string;
  resultRevision: number | string;
  targets: Record<string, DurableFileTarget>;
  conflictPaths: string[];
  diffStats: { files: number; insertions: number; deletions: number };
  executionId?: string;
  requireTurnBinding?: boolean;
  retryBinding?: DurableFileRetryBinding;
}

export interface DurableFileRetryBinding {
  branchId: string;
  parentStates: Record<string, RecoveryState>;
  childStates: Record<string, RecoveryState>;
  resultingParentStates: Record<string, RecoveryState>;
}

export interface DurableFileOperationResult {
  operationId: string;
  status: "applied" | "conflict" | "compensated" | "needs-attention";
  appliedPaths: string[];
  conflictPaths: string[];
  compensatedPaths?: string[];
  needsAttentionPaths?: string[];
  diffStats: DurableFileOperationSpec["diffStats"];
  text: string;
}

export interface HostResourceOperation {
  resourceId: string;
  scope: "exact" | "subtree";
}

export interface HostResourceOperationGate {
  run<Result>(resources: readonly HostResourceOperation[], operation: () => Promise<Result>): Promise<Result>;
}

export interface DurableFileOperationContext {
  database: SqliteDatabase;
  fileStore: RecoveryFileStore;
  identity: RecoveryIdentity;
  resourceOperationGate: HostResourceOperationGate;
  root: string;
}

interface PersistedIntegrationData extends Record<string, unknown> {
  operationId: string;
  threadId: string;
  resultRevision: number | string;
  targets: Record<string, DurableFileTarget>;
  safety: Record<string, RecoveryState>;
  conflictPaths: string[];
  appliedPaths: string[];
  compensatedPaths: string[];
  needsAttentionPaths: string[];
  diffStats: DurableFileOperationSpec["diffStats"];
  failure?: string;
  retryBinding?: DurableFileRetryBinding;
}

const stateFromJson = (value: string | null, label: string): RecoveryState => {
  if (!value) throw new Error(`Integration ${label} state is missing`);
  return parseRecoveryState(JSON.parse(value) as unknown);
};

const writeRecord = (
  database: SqliteDatabase,
  workspaceId: string,
  state: string,
  data: PersistedIntegrationData,
  createdAt: string,
): void => writeOperationRow(database, {
  id: data.operationId,
  workspaceId,
  kind: "integration",
  state,
  data,
  createdAt,
  updatedAt: new Date().toISOString(),
});

const capture = (
  context: DurableFileOperationContext,
  file: string,
  store: boolean,
) => context.fileStore.captureState(context.identity, context.root, file, { store });

const runPathOperation = <Result>(
  context: DurableFileOperationContext,
  file: string,
  scope: HostResourceOperation["scope"],
  operation: () => Promise<Result>,
): Promise<Result> => context.resourceOperationGate.run([{ resourceId: file, scope }], operation);

const pathDepth = (file: string): number => file.split(/[\\/]/).length;
const orderForStates = <T extends { path: string }>(
  values: T[],
  stateFor: (value: T) => RecoveryState,
): T[] => [...values].sort((left, right) => {
  const a = stateFor(left);
  const b = stateFor(right);
  const group = (state: RecoveryState) => state.kind === "missing" ? 0 : state.kind === "directory" ? 1 : 2;
  const groupDiff = group(a) - group(b);
  if (groupDiff !== 0) return groupDiff;
  const depthDiff = pathDepth(left.path) - pathDepth(right.path);
  return a.kind === "missing" ? -depthDiff : depthDiff;
});

const compensate = async (
  context: DurableFileOperationContext,
  data: PersistedIntegrationData,
  rows: OperationFileRow[],
): Promise<void> => {
  const compensatingRows = orderForStates(rows, (row) => (
    data.safety[row.path] ?? stateFromJson(row.safety_json, `${row.path} safety`)
  ));
  for (const row of compensatingRows) {
    if (row.phase !== "target-observed" && row.phase !== "compensate-intent") continue;
    const target = stateFromJson(row.target_json, `${row.path} target`);
    const safety = data.safety[row.path] ?? stateFromJson(row.safety_json, `${row.path} safety`);
    await runPathOperation(context, row.path, "subtree", async () => {
      const current = (await capture(context, row.path, false)).state;
      if (!sameState(current, target)) {
        updateOperationFilePhase(context.database, data.operationId, row.path, "needs-attention");
        data.needsAttentionPaths.push(row.path);
        return;
      }
      updateOperationFilePhase(context.database, data.operationId, row.path, "compensate-intent");
      try {
        await context.fileStore.applyState(context.identity, context.root, row.path, safety);
        const restored = (await capture(context, row.path, false)).state;
        if (!sameState(restored, safety)) throw new Error(`Compensation did not restore ${row.path}`);
      } catch {
        updateOperationFilePhase(context.database, data.operationId, row.path, "needs-attention");
        data.needsAttentionPaths.push(row.path);
        return;
      }
      updateOperationFilePhase(context.database, data.operationId, row.path, "safety-observed");
      data.compensatedPaths.push(row.path);
    });
  }
};

export const applyDurableFileOperation = async (
  context: DurableFileOperationContext,
  spec: DurableFileOperationSpec,
): Promise<DurableFileOperationResult> => {
  if (spec.requireTurnBinding && !spec.executionId) throw new Error("Parent turn recovery binding is required for integration");
  if (spec.executionId) assertIntegrationTurnBinding(context.database, spec.workspaceId, spec.executionId);
  await reconcileInterruptedIntegrationOperations(context);
  const blocking = context.database.prepare(`
    SELECT id, state FROM operations WHERE workspace_id = ? AND kind = 'integration'
    AND state NOT IN ('complete', 'conflict', 'compensated', 'aborted') LIMIT 1
  `).get(spec.workspaceId) as { id: string; state: string } | undefined;
  if (blocking) throw new Error(`Integration ${blocking.id} requires recovery before a new integration can start (${blocking.state})`);
  const createdAt = new Date().toISOString();
  const safety: Record<string, RecoveryState> = {};
  const drift: string[] = [];
  for (const [file, states] of Object.entries(spec.targets)) {
    const current = await capture(context, file, true);
    safety[file] = current.state;
    if (!sameState(current.state, states.expected)) drift.push(file);
  }
  if (drift.length > 0) {
    return {
      operationId: spec.id,
      status: "conflict",
      appliedPaths: [],
      conflictPaths: [...new Set([...spec.conflictPaths, ...drift])],
      diffStats: spec.diffStats,
      text: `Parent workspace changed before integration: ${drift.join(", ")}`,
    };
  }

  const data: PersistedIntegrationData = {
    operationId: spec.id,
    threadId: spec.threadId,
    resultRevision: spec.resultRevision,
    targets: spec.targets,
    safety,
    conflictPaths: [...spec.conflictPaths],
    appliedPaths: [],
    compensatedPaths: [],
    needsAttentionPaths: [],
    diffStats: spec.diffStats,
    ...(spec.retryBinding ? { retryBinding: structuredClone(spec.retryBinding) } : {}),
  };
  context.database.transaction(() => {
    writeRecord(context.database, spec.workspaceId, "applying", data, createdAt);
    initOperationFiles(context.database, spec.id, spec.targets);
    for (const [file, state] of Object.entries(safety)) {
      updateOperationFilePhase(context.database, spec.id, file, "apply-intent", { safetyJson: JSON.stringify(state) });
    }
  }).immediate();

  const compensateLiveTargets = async (): Promise<void> => {
    const ordered = orderForStates(
      Object.entries(spec.targets).map(([path, states]) => ({ path, states })),
      (entry) => safety[entry.path]!,
    );
    for (const { path: file, states } of ordered) {
      await runPathOperation(context, file, "subtree", async () => {
        const current = (await capture(context, file, false)).state;
        if (sameState(current, safety[file]!)) return;
        if (!sameState(current, states.target)) {
          data.needsAttentionPaths.push(file);
          try { updateOperationFilePhase(context.database, spec.id, file, "needs-attention"); } catch { /* The API still reports failure; disk remains untouched. */ }
          return;
        }
        try { updateOperationFilePhase(context.database, spec.id, file, "compensate-intent"); } catch { /* Continue with exact in-memory states. */ }
        try {
          await context.fileStore.applyState(context.identity, context.root, file, safety[file]!);
          const restored = (await capture(context, file, false)).state;
          if (!sameState(restored, safety[file]!)) throw new Error(`Compensation did not restore ${file}`);
          data.compensatedPaths.push(file);
          try { updateOperationFilePhase(context.database, spec.id, file, "safety-observed"); } catch { /* Final operation state records the compensation when possible. */ }
        } catch {
          data.needsAttentionPaths.push(file);
          try { updateOperationFilePhase(context.database, spec.id, file, "needs-attention"); } catch { /* Preserve the unknown disk state. */ }
        }
      });
    }
  };

  try {
    const orderedTargets = orderForStates(
      Object.entries(spec.targets).map(([path, states]) => ({ path, states })),
      (entry) => entry.states.target,
    );
    for (const { path: file, states } of orderedTargets) {
      await runPathOperation(context, file, "subtree", async () => {
        const current = (await capture(context, file, false)).state;
        if (!sameState(current, safety[file]!)) throw new Error(`Parent workspace changed during integration: ${file}`);
        await context.fileStore.applyState(context.identity, context.root, file, states.target);
        const observed = (await capture(context, file, false)).state;
        if (!sameState(observed, states.target)) throw new Error(`Integrated path did not match target: ${file}`);
        updateOperationFilePhase(context.database, spec.id, file, "target-observed");
        data.appliedPaths.push(file);
      });
    }
  } catch (error) {
    data.failure = error instanceof Error ? error.message : String(error);
    await compensateLiveTargets();
    const status = data.needsAttentionPaths.length > 0 ? "needs-attention" : "compensated";
    writeRecord(context.database, spec.workspaceId, status, data, createdAt);
    return {
      operationId: spec.id,
      status,
      appliedPaths: [],
      conflictPaths: spec.conflictPaths,
      compensatedPaths: data.compensatedPaths,
      needsAttentionPaths: data.needsAttentionPaths,
      diffStats: spec.diffStats,
      text: `Integration failed (${data.failure}); ${status}.`,
    };
  }

  const status = spec.conflictPaths.length > 0 ? "conflict" : "applied";
  try {
    context.database.transaction(() => {
      writeRecord(context.database, spec.workspaceId, status === "applied" ? "complete" : "conflict", data, createdAt);
      if (spec.executionId) {
        bindIntegrationOperationToTurn(context.database, {
          workspaceId: spec.workspaceId,
          executionId: spec.executionId,
          operationId: spec.id,
        });
      }
    }).immediate();
  } catch (error) {
    data.failure = `Unable to commit integration result: ${error instanceof Error ? error.message : String(error)}`;
    await compensateLiveTargets();
    const compensatedStatus = data.needsAttentionPaths.length > 0 ? "needs-attention" : "compensated";
    try {
      writeRecord(context.database, spec.workspaceId, compensatedStatus, data, createdAt);
    } catch (persistError) {
      throw new Error(`${data.failure}; compensation status could not be persisted: ${persistError instanceof Error ? persistError.message : String(persistError)}`);
    }
    return {
      operationId: spec.id,
      status: compensatedStatus,
      appliedPaths: [],
      conflictPaths: spec.conflictPaths,
      compensatedPaths: data.compensatedPaths,
      needsAttentionPaths: data.needsAttentionPaths,
      diffStats: spec.diffStats,
      text: `${data.failure}; ${compensatedStatus}.`,
    };
  }
  return {
    operationId: spec.id,
    status,
    appliedPaths: data.appliedPaths,
    conflictPaths: spec.conflictPaths,
    diffStats: spec.diffStats,
    text: status === "applied"
      ? `Integrated ${data.appliedPaths.length} path(s).`
      : `Integrated ${data.appliedPaths.length} path(s) with ${spec.conflictPaths.length} conflict(s).`,
  };
};

const parsePersistedData = (row: OperationRow): PersistedIntegrationData => {
  const raw = JSON.parse(row.data_json) as Record<string, unknown>;
  if (!raw || typeof raw !== "object" || raw.operationId !== row.id || !raw.targets || !raw.safety) {
    throw new Error(`Integration operation ${row.id} is malformed`);
  }
  const parseCollection = (value: unknown): Record<string, RecoveryState> => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Integration operation ${row.id} states are malformed`);
    return Object.fromEntries(Object.entries(value).map(([file, state]) => [file, parseRecoveryState(state)]));
  };
  const targets = Object.fromEntries(Object.entries(raw.targets as Record<string, unknown>).map(([file, value]) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Integration target ${file} is malformed`);
    const states = value as Record<string, unknown>;
    return [file, { expected: parseRecoveryState(states.expected), target: parseRecoveryState(states.target) }];
  }));
  const parseRetryBinding = (value: unknown): DurableFileRetryBinding | undefined => {
    if (value === undefined) return undefined;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`Integration operation ${row.id} retry binding is malformed`);
    }
    const binding = value as Record<string, unknown>;
    if (typeof binding.branchId !== "string" || !binding.branchId) {
      throw new Error(`Integration operation ${row.id} retry binding is malformed`);
    }
    return {
      branchId: binding.branchId,
      parentStates: parseCollection(binding.parentStates),
      childStates: parseCollection(binding.childStates),
      resultingParentStates: parseCollection(binding.resultingParentStates),
    };
  };
  return {
    operationId: row.id,
    threadId: String(raw.threadId ?? ""),
    resultRevision: typeof raw.resultRevision === "number" ? raw.resultRevision : String(raw.resultRevision ?? ""),
    targets,
    safety: parseCollection(raw.safety),
    conflictPaths: Array.isArray(raw.conflictPaths) ? raw.conflictPaths.filter((entry): entry is string => typeof entry === "string") : [],
    appliedPaths: Array.isArray(raw.appliedPaths) ? raw.appliedPaths.filter((entry): entry is string => typeof entry === "string") : [],
    compensatedPaths: Array.isArray(raw.compensatedPaths) ? raw.compensatedPaths.filter((entry): entry is string => typeof entry === "string") : [],
    needsAttentionPaths: Array.isArray(raw.needsAttentionPaths) ? raw.needsAttentionPaths.filter((entry): entry is string => typeof entry === "string") : [],
    diffStats: raw.diffStats as PersistedIntegrationData["diffStats"],
    ...(typeof raw.failure === "string" ? { failure: raw.failure } : {}),
    ...(raw.retryBinding === undefined ? {} : { retryBinding: parseRetryBinding(raw.retryBinding)! }),
  };
};

const sameStateCollection = (
  left: Record<string, RecoveryState>,
  right: Record<string, RecoveryState>,
): boolean => {
  const leftPaths = Object.keys(left).sort();
  const rightPaths = Object.keys(right).sort();
  return leftPaths.length === rightPaths.length
    && leftPaths.every((file, index) => file === rightPaths[index] && sameState(left[file]!, right[file]!));
};

export const findReusableIntegrationConflict = (
  context: DurableFileOperationContext,
  input: {
    workspaceId: string;
    threadId: string;
    branchId: string;
    resultRevision: number | string;
    childStates: Record<string, RecoveryState>;
    currentParentStates: Record<string, RecoveryState>;
  },
): DurableFileOperationResult | null => {
  const rows = context.database.prepare(`
    SELECT * FROM operations
    WHERE workspace_id = ? AND kind = 'integration' AND state = 'conflict'
    ORDER BY updated_at DESC
  `).all(input.workspaceId) as OperationRow[];
  for (const row of rows) {
    const data = parsePersistedData(row);
    const retry = data.retryBinding;
    if (!retry
      || data.threadId !== input.threadId
      || String(data.resultRevision) !== String(input.resultRevision)
      || retry.branchId !== input.branchId
      || !sameStateCollection(retry.childStates, input.childStates)
      || !sameStateCollection(retry.resultingParentStates, input.currentParentStates)) {
      continue;
    }
    return {
      operationId: data.operationId,
      status: "conflict",
      appliedPaths: [], // The prior operation remains inspectable; this request writes nothing.
      conflictPaths: [...data.conflictPaths],
      diffStats: data.diffStats,
      text: `Reused integration conflict ${data.operationId}.`,
    };
  }
  return null;
};

export const reconcileInterruptedIntegrationOperations = async (
  context: DurableFileOperationContext,
): Promise<{ compensated: string[]; needsAttention: string[]; aborted: string[] }> => {
  const rows = context.database.prepare(`
    SELECT * FROM operations WHERE kind = 'integration'
    AND workspace_id = ?
    AND state NOT IN ('complete', 'aborted', 'compensated', 'needs-attention', 'conflict')
  `).all(context.identity.workspaceId) as OperationRow[];
  const result = { compensated: [] as string[], needsAttention: [] as string[], aborted: [] as string[] };
  for (const row of rows) {
    const data = parsePersistedData(row);
    let unknown = false;
    for (const fileRow of operationFileRows(context.database, row.id)) {
      const target = stateFromJson(fileRow.target_json, `${fileRow.path} target`);
      const safety = data.safety[fileRow.path] ?? stateFromJson(fileRow.safety_json, `${fileRow.path} safety`);
      const current = (await capture(context, fileRow.path, false)).state;
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
      writeRecord(context.database, row.workspace_id, "needs-attention", data, new Date().toISOString());
      result.needsAttention.push(row.id);
      continue;
    }
    const currentRows = operationFileRows(context.database, row.id);
    if (currentRows.some((entry) => entry.phase === "target-observed" || entry.phase === "compensate-intent")) {
      await compensate(context, data, currentRows);
      const state = data.needsAttentionPaths.length > 0 ? "needs-attention" : "compensated";
      writeRecord(context.database, row.workspace_id, state, data, new Date().toISOString());
      (state === "compensated" ? result.compensated : result.needsAttention).push(row.id);
    } else {
      writeRecord(context.database, row.workspace_id, "aborted", data, new Date().toISOString());
      result.aborted.push(row.id);
    }
  }
  return result;
};
