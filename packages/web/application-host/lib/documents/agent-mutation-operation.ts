import type { DocumentSurfaceWritePathResult } from "@piarium/protocol";
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

const kernelPhase = async (
  context: DurableFileOperationContext,
  data: PersistedAgentMutationData,
  path: string,
  phase: string,
  fields: { expected?: RecoveryState; target?: RecoveryState; safety?: RecoveryState } = {},
): Promise<void> => {
  const durable = context.durableRecoveryStore;
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
    await kernelPhase(context, data, path, data.targetKinds[path] === "surface" ? "external-target-observed" : "target-observed", extras?.target ? { target: extras.target } : {});
};

export const markAgentMutationSurfaceDispatched = async (
  context: DurableFileOperationContext,
  data: PersistedAgentMutationData,
  path: string,
): Promise<void> => {
  await kernelPhase(context, data, path, "external-dispatched");
};

export const markAgentMutationSurfaceCompensateIntent = async (
  context: DurableFileOperationContext,
  data: PersistedAgentMutationData,
  path: string,
): Promise<void> => {
  await kernelPhase(context, data, path, "external-compensate-intent");
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
  await kernelPhase(context, data, path, "external-safety-observed");
};

export const markAgentMutationPathNeedsAttention = async (
  context: DurableFileOperationContext,
  data: PersistedAgentMutationData,
  path: string,
  failure?: string,
): Promise<void> => {
  if (!data.needsAttentionPaths.includes(path)) data.needsAttentionPaths.push(path);
  if (failure) data.failure = failure;
  await kernelPhase(context, data, path, "needs-attention");
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
    await kernelPhase(context, data, path, "compensate-intent");
    try {
      const current = (await context.fileStore.captureState(context.identity, context.root, path, { store: false })).state;
      if (sameState(current, safety)) {
        await kernelPhase(context, data, path, "safety-observed");
        if (!data.compensatedPaths.includes(path)) data.compensatedPaths.push(path);
        return "compensated";
      }
      if (!sameState(current, target)) {
        await markAgentMutationPathNeedsAttention(context, data, path, `${path} drifted away from the applied identity`);
        return "needs-attention";
      }
      await context.fileStore.applyState(context.identity, context.root, path, safety);
      const restored = (await context.fileStore.captureState(context.identity, context.root, path, { store: false })).state;
      if (!sameState(restored, safety)) throw new Error(`Compensation did not restore ${path}`);
      await kernelPhase(context, data, path, "safety-observed");
      if (!data.compensatedPaths.includes(path)) data.compensatedPaths.push(path);
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
  await kernelPhase(context, data, path, "external-safety-observed");
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
  await kernelComplete(context, data, state, data);
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
    const outcome = { compensated: [] as string[], needsAttention: [] as string[], aborted: [] as string[] };
    for (const summary of await context.durableRecoveryStore.listOperations(context.identity.workspaceId, AGENT_MUTATION_KIND)) {
      const operationId = typeof summary.operationId === "string" ? summary.operationId : "";
      if (!operationId || ["complete", "aborted", "compensated", "conflict"].includes(String(summary.state))) continue;
      const durableOperation: Record<string, unknown> | null = await context.durableRecoveryStore.getOperation(context.identity.workspaceId, operationId, typeof summary.sessionId === "string" ? summary.sessionId : undefined);
      if (!durableOperation) continue;
      const data = (durableOperation.data && typeof durableOperation.data === "object" ? durableOperation.data : {}) as PersistedAgentMutationData;
      data.appliedPaths ??= [];
      data.compensatedPaths ??= [];
      data.needsAttentionPaths ??= [];
      data.targets ??= {};
      data.safety ??= {};
      const files: Array<Record<string, unknown>> = Array.isArray(durableOperation.files) ? durableOperation.files.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object") : [];
      let unknown = false;
      let compensated = false;
      const update = async (file: Record<string, unknown>, phase: string, fields: { expected?: RecoveryState; target?: RecoveryState; safety?: RecoveryState } = {}) => {
        const result = await context.durableRecoveryStore.updateOperationFile({
          operationId, workspaceId: context.identity.workspaceId, path: String(file.path), expectedRevision: Number(file.revision ?? 1),
          expectedPhase: String(file.phase ?? "pending"), phase, ...fields,
          ...(typeof summary.sessionId === "string" ? { sessionId: summary.sessionId } : {}),
        });
        file.revision = Number(result.revision ?? Number(file.revision ?? 1) + 1);
        file.phase = phase;
      };
      for (const file of files) {
        const path = String(file.path ?? "");
        const phase = String(file.phase ?? "pending");
        const parse = (key: string): RecoveryState | undefined => typeof file[key] === "string" ? parseRecoveryState(JSON.parse(String(file[key]))) : undefined;
        const target = parse("targetJson") ?? data.targets?.[path]?.target;
        const safety = parse("safetyJson") ?? data.safety?.[path];
        if (String(data.targetKinds?.[path]) === "surface") {
          if (phase === "pending" || phase === "external-intent") await update(file, "external-safety-observed");
          else if (phase !== "external-safety-observed") {
            await update(file, "needs-attention");
            if (!data.needsAttentionPaths.includes(path)) data.needsAttentionPaths.push(path);
            unknown = true;
          }
          continue;
        }
        if (!target || !safety) { await update(file, "needs-attention"); unknown = true; continue; }
        data.targets[path] = { expected: data.targets[path]?.expected ?? safety, target };
        data.safety[path] = safety;
        const current = await observeDisk(context, path);
        if ((phase === "pending" || phase === "apply-intent") && sameState(current, target)) {
          await update(file, "target-observed", { target });
          if (!data.appliedPaths.includes(path)) data.appliedPaths.push(path);
          const outcome = await compensateAgentMutationDiskPath(context, data, path);
          compensated ||= outcome === "compensated";
          unknown ||= outcome === "needs-attention";
        }
        else if ((phase === "target-observed" || phase === "compensate-intent") && sameState(current, target)) {
          if (!data.appliedPaths.includes(path)) data.appliedPaths.push(path);
          const outcome = await compensateAgentMutationDiskPath(context, data, path);
          compensated ||= outcome === "compensated";
          unknown ||= outcome === "needs-attention";
        }
        else if (sameState(current, safety)) {
          if (phase !== "safety-observed") await update(file, "safety-observed", { safety });
          if (phase === "target-observed" || phase === "compensate-intent") {
            if (!data.compensatedPaths.includes(path)) data.compensatedPaths.push(path);
            compensated = true;
          }
        }
        else {
          await update(file, "needs-attention");
          if (!data.needsAttentionPaths.includes(path)) data.needsAttentionPaths.push(path);
          unknown = true;
        }
      }
      const state = unknown ? "needs-attention" : compensated ? "compensated" : "aborted";
      await context.durableRecoveryStore.completeOperation({ operationId, workspaceId: context.identity.workspaceId, expectedRevision: Number(durableOperation.revision ?? 1), state, result: data });
      (state === "needs-attention" ? outcome.needsAttention : state === "compensated" ? outcome.compensated : outcome.aborted).push(operationId);
    }
    return outcome;
};
