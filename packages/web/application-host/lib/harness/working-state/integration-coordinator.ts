import { createHash, randomUUID } from "node:crypto";
import type {
  IntegrationApplyPhase,
  ThreadConflictResolution,
  ThreadIntegrationPreview,
  ThreadSurfaceEdit,
  ThreadSurfaceParent,
} from "@piarium/protocol";
import type { IntegrationApplyResult, RecoveryState, ThreeWayMergePlan, ThreeWayPathPlan } from "./types.js";
import { buildThreeWayMergePlan } from "./three-way-merge.js";
import type { WorkspaceWorkingStateAccess, WorkingStateStore } from "./working-state-store.js";
import type { WorkspaceRecoveryStorageContext } from "../../recovery/journal-engine.js";
import {
  classifyIntegrationTarget,
  dirtyResourceMap,
  parentRevisionOf,
  surfaceParentContent,
  type DirtyBufferInspectPublication,
} from "./integration-parents.js";
import {
  applyDurableFileOperation,
  findReusableIntegrationConflict,
  reconcileInterruptedIntegrationOperations,
  type DurableFileTarget,
} from "../../recovery/durable-file-operation.js";
import { assertIntegrationTurnBinding } from "../../recovery/integration-turn-binding.js";
import { writeOperationRow, type SqliteDatabase } from "../../recovery/journal-catalog.js";

const persistSurfacePhases = (
  database: SqliteDatabase,
  operationId: string,
  phases: Record<string, IntegrationApplyPhase>,
): void => {
  const row = database.prepare(`
    SELECT data_json, workspace_id, kind, state, created_at FROM operations WHERE id = ?
  `).get(operationId) as {
    data_json: string;
    workspace_id: string;
    kind: string;
    state: string;
    created_at: string;
  } | undefined;
  if (!row) return;
  const data = JSON.parse(row.data_json) as Record<string, unknown>;
  writeOperationRow(database, {
    id: operationId,
    workspaceId: row.workspace_id,
    kind: row.kind,
    state: row.state,
    data: { ...data, surfacePhases: phases },
    createdAt: row.created_at,
    updatedAt: new Date().toISOString(),
  });
};

export interface IntegrationCoordinatorOptions {
  workingStates: WorkspaceWorkingStateAccess;
  inspectDirtyBuffers?: (workspaceId: string) => Promise<DirtyBufferInspectPublication[]>;
}

export interface IntegrationPlanInput {
  workspaceId: string;
  threadId: string;
  branchId: string;
  resultRevision: number;
  executionId?: string;
  requireTurnBinding?: boolean;
  surfaceParents?: ThreadSurfaceParent[];
  resolutions?: ThreadConflictResolution[];
}

const mergeTarget = async (
  store: WorkingStateStore,
  pathPlan: ThreeWayPathPlan,
): Promise<RecoveryState | null> => {
  if (pathPlan.decision === "apply-child") return pathPlan.childState;
  if (pathPlan.decision === "merge-clean" && pathPlan.mergedText !== undefined) {
    const bytes = Buffer.from(pathPlan.mergedText, "utf8");
    const object = await store.putObject(bytes);
    return {
      kind: "regular-file",
      objectHash: object.hash,
      byteLength: object.byteLength,
      ...(pathPlan.mergedMode !== undefined ? { mode: pathPlan.mergedMode } : {}),
    };
  }
  if (pathPlan.decision === "conflict" && pathPlan.conflictMarkers !== undefined) {
    const bytes = Buffer.from(pathPlan.conflictMarkers, "utf8");
    const object = await store.putObject(bytes);
    return {
      kind: "regular-file",
      objectHash: object.hash,
      byteLength: object.byteLength,
      ...(pathPlan.parentState.kind === "regular-file" && pathPlan.parentState.mode !== undefined
        ? { mode: pathPlan.parentState.mode }
        : {}),
    };
  }
  return null;
};

const previewFingerprint = (binding: ThreadIntegrationPreview["binding"], resultRevision: number): string => {
  const material = JSON.stringify({ resultRevision, binding });
  return createHash("sha256").update(material).digest("hex");
};

const applyResolutions = (
  plan: ThreeWayMergePlan,
  resolutions: readonly ThreadConflictResolution[] | undefined,
): ThreeWayMergePlan => {
  if (!resolutions?.length) return plan;
  const byPath = new Map(resolutions.map((resolution) => [resolution.path, resolution]));
  const paths = plan.paths.map((pathPlan) => {
    const resolution = byPath.get(pathPlan.path);
    if (!resolution || pathPlan.decision !== "conflict") return pathPlan;
    if (resolution.choice === "parent") return { ...pathPlan, decision: "keep-parent" as const };
    if (resolution.choice === "child") return { ...pathPlan, decision: "apply-child" as const };
    if (resolution.choice === "base") return { ...pathPlan, decision: "apply-child" as const, childState: pathPlan.baseState };
    if (resolution.choice === "text" && resolution.text !== undefined) {
      const { conflictMarkers: _conflictMarkers, ...rest } = pathPlan;
      return { ...rest, decision: "merge-clean" as const, mergedText: resolution.text };
    }
    return pathPlan;
  });
  const conflictPaths = paths.filter((pathPlan) => pathPlan.decision === "conflict").map((pathPlan) => pathPlan.path);
  const appliedPaths = paths
    .filter((pathPlan) => pathPlan.decision === "apply-child" || pathPlan.decision === "merge-clean")
    .map((pathPlan) => pathPlan.path);
  return { ...plan, paths, conflictPaths, appliedPaths, clean: conflictPaths.length === 0 };
};

const projectPreview = (
  plan: ThreeWayMergePlan,
  targets: Record<string, ReturnType<typeof classifyIntegrationTarget>>,
  bindings: ThreadIntegrationPreview["binding"],
  phases: Record<string, IntegrationApplyPhase>,
  readTexts: Record<string, { parent?: string; child?: string; baseline?: string }>,
): ThreadIntegrationPreview => {
  const unavailablePaths = plan.paths
    .filter((pathPlan) => targets[pathPlan.path] === "unavailable")
    .map((pathPlan) => pathPlan.path);
  const surfaceTargetPaths = plan.paths
    .filter((pathPlan) => targets[pathPlan.path] === "surface")
    .map((pathPlan) => pathPlan.path);
  const incompleteSurface = plan.paths.some((pathPlan) => (
    targets[pathPlan.path] === "surface" && !readTexts[pathPlan.path]?.parent
  ));
  const valid = unavailablePaths.length === 0;
  return {
    operationId: plan.operationId,
    threadId: plan.threadId,
    resultRevision: Number(plan.resultRevision),
    bindingFingerprint: previewFingerprint(bindings, Number(plan.resultRevision)),
    valid,
    mergeReady: valid && plan.clean && !incompleteSurface && unavailablePaths.length === 0,
    binding: bindings,
    paths: plan.paths.map((pathPlan) => {
      const texts = readTexts[pathPlan.path];
      return {
        path: pathPlan.path,
        target: targets[pathPlan.path] ?? "disk",
        decision: targets[pathPlan.path] === "unavailable" ? "unavailable" : pathPlan.decision,
        phase: phases[pathPlan.path] ?? "pending",
        isText: pathPlan.isText,
        ...(pathPlan.conflictReason ? { conflictReason: pathPlan.conflictReason } : {}),
        ...(texts?.parent !== undefined ? { parentText: texts.parent } : {}),
        ...(texts?.child !== undefined ? { childText: texts.child } : {}),
        ...(texts?.baseline !== undefined ? { baselineText: texts.baseline } : {}),
      };
    }),
    conflictPaths: plan.conflictPaths,
    surfaceTargetPaths,
    unavailablePaths,
    appliedPaths: plan.appliedPaths,
    ...(valid ? {} : { invalidReason: "Parent buffer or child result binding is incomplete" }),
  };
};

export class IntegrationCoordinator {
  private readonly workingStates: WorkspaceWorkingStateAccess;
  private readonly inspectDirtyBuffers?: IntegrationCoordinatorOptions["inspectDirtyBuffers"];
  private readonly previewByThread = new Map<string, ThreadIntegrationPreview>();

  constructor(options: IntegrationCoordinatorOptions) {
    this.workingStates = options.workingStates;
    this.inspectDirtyBuffers = options.inspectDirtyBuffers;
  }

  latestPreview(threadId: string): ThreadIntegrationPreview | undefined {
    return this.previewByThread.get(threadId);
  }

  previewMatches(threadId: string, resultRevision: number, binding: ThreadIntegrationPreview["binding"]): boolean {
    const current = this.previewByThread.get(threadId);
    if (!current) return false;
    return current.valid
      && current.resultRevision === resultRevision
      && previewFingerprint(current.binding, current.resultRevision) === previewFingerprint(binding, resultRevision);
  }

  async previewResult(input: IntegrationPlanInput): Promise<ThreadIntegrationPreview> {
    const planned = await this.plan(input);
    this.previewByThread.set(input.threadId, planned.preview);
    return planned.preview;
  }

  async mergeResult(input: IntegrationPlanInput): Promise<IntegrationApplyResult & { changedFiles: string[] }> {
    return this.workingStates.withStore(input.workspaceId, "thread-result-integration", async (store, context) => {
      if (input.requireTurnBinding && !input.executionId) {
        throw new Error("Parent turn recovery binding is required for integration");
      }
      if (input.executionId) {
        assertIntegrationTurnBinding(context.database, input.workspaceId, input.executionId);
      }
      await reconcileInterruptedIntegrationOperations(context);
      const blocking = context.database.prepare(`
        SELECT id, state FROM operations WHERE workspace_id = ? AND kind = 'integration'
        AND state NOT IN ('complete', 'conflict', 'compensated', 'aborted') LIMIT 1
      `).get(input.workspaceId) as { id: string; state: string } | undefined;
      if (blocking) throw new Error(`Integration ${blocking.id} requires recovery before planning (${blocking.state})`);
      const planned = await this.planFrom(store, context, input);
      this.previewByThread.set(input.threadId, planned.preview);
      const reusable = findReusableIntegrationConflict(context, {
        workspaceId: input.workspaceId,
        threadId: input.threadId,
        branchId: input.branchId,
        resultRevision: input.resultRevision,
        childStates: planned.childStates,
        currentParentStates: planned.diskParentStates,
      });
      if (reusable) {
        const preview = { ...planned.preview, operationId: reusable.operationId };
        this.previewByThread.set(input.threadId, preview);
        return {
          ...reusable,
          changedFiles: planned.changedPaths,
          ...(planned.preview.surfaceTargetPaths.length > 0 ? { surfaceTargetPaths: planned.preview.surfaceTargetPaths } : {}),
          ...(planned.surfaceEdits.length > 0 ? { surfaceEdits: planned.surfaceEdits } : {}),
          preview,
        };
      }
      const pendingSurface = planned.preview.surfaceTargetPaths.filter((path) => (
        !planned.surfaceEdits.some((edit) => edit.resourceId === path)
      ));
      const conflictPaths = [...new Set([
        ...planned.plan.conflictPaths,
        ...pendingSurface,
        ...planned.preview.unavailablePaths,
      ])].sort();
      const applied = await applyDurableFileOperation(context, {
        id: planned.plan.operationId,
        workspaceId: input.workspaceId,
        threadId: input.threadId,
        resultRevision: input.resultRevision,
        targets: planned.diskTargets,
        conflictPaths,
        diffStats: planned.plan.diffStats,
        ...(input.executionId ? { executionId: input.executionId } : {}),
        ...(input.requireTurnBinding ? { requireTurnBinding: true } : {}),
        retryBinding: {
          branchId: input.branchId,
          parentStates: planned.diskParentStates,
          childStates: planned.childStates,
          resultingParentStates: Object.fromEntries(planned.changedPaths.map((file) => [
            file,
            planned.diskTargets[file]?.target ?? planned.diskParentStates[file]!,
          ])),
        },
      });
      const phases: Record<string, IntegrationApplyPhase> = {};
      for (const path of applied.appliedPaths) phases[path] = "disk-applied";
      for (const path of applied.conflictPaths) {
        phases[path] = planned.targets[path] === "unavailable" ? "unavailable" : "conflict";
      }
      for (const path of applied.compensatedPaths ?? []) phases[path] = "compensated";
      for (const path of applied.needsAttentionPaths ?? []) phases[path] = "unavailable";
      persistSurfacePhases(context.database, applied.operationId, phases);
      const preview = projectPreview(planned.plan, planned.targets, planned.preview.binding, phases, planned.texts);
      this.previewByThread.set(input.threadId, preview);
      const status = preview.unavailablePaths.length > 0 && applied.status === "applied"
        ? "needs-attention" as const
        : applied.status;
      return {
        ...applied,
        status,
        changedFiles: planned.changedPaths,
        ...(planned.preview.surfaceTargetPaths.length > 0 ? { surfaceTargetPaths: planned.preview.surfaceTargetPaths } : {}),
        ...(planned.surfaceEdits.length > 0 ? { surfaceEdits: planned.surfaceEdits } : {}),
        preview,
      };
    });
  }

  async acknowledgeSurface(input: {
    workspaceId: string;
    threadId: string;
    operationId: string;
    applied: string[];
    failed: string[];
  }): Promise<ThreadIntegrationPreview | undefined> {
    const current = this.previewByThread.get(input.threadId);
    if (!current || current.operationId !== input.operationId) return current;
    const applied = new Set(input.applied);
    const failed = new Set(input.failed);
    const preview: ThreadIntegrationPreview = {
      ...current,
      paths: current.paths.map((path) => (
        applied.has(path.path)
          ? { ...path, phase: "surface-applied" as const }
          : failed.has(path.path)
            ? { ...path, phase: "unavailable" as const }
            : path
      )),
    };
    this.previewByThread.set(input.threadId, preview);
    await this.workingStates.withStore(input.workspaceId, "thread-surface-ack", (_store, context) => {
      const phases = Object.fromEntries(preview.paths.map((path) => [path.path, path.phase]));
      persistSurfacePhases(context.database, input.operationId, phases);
    });
    return preview;
  }

  private async plan(input: IntegrationPlanInput): Promise<{
    plan: ThreeWayMergePlan;
    preview: ThreadIntegrationPreview;
    targets: Record<string, ReturnType<typeof classifyIntegrationTarget>>;
    diskTargets: Record<string, DurableFileTarget>;
    diskParentStates: Record<string, RecoveryState>;
    childStates: Record<string, RecoveryState>;
    changedPaths: string[];
    surfaceEdits: ThreadSurfaceEdit[];
    texts: Record<string, { parent?: string; child?: string; baseline?: string }>;
  }> {
    return this.workingStates.withStore(input.workspaceId, "thread-result-preview", (store, context) => (
      this.planFrom(store, context, input)
    ));
  }

  private async planFrom(
    store: WorkingStateStore,
    context: WorkspaceRecoveryStorageContext,
    input: IntegrationPlanInput,
  ): Promise<{
    plan: ThreeWayMergePlan;
    preview: ThreadIntegrationPreview;
    targets: Record<string, ReturnType<typeof classifyIntegrationTarget>>;
    diskTargets: Record<string, DurableFileTarget>;
    diskParentStates: Record<string, RecoveryState>;
    childStates: Record<string, RecoveryState>;
    changedPaths: string[];
    surfaceEdits: ThreadSurfaceEdit[];
    texts: Record<string, { parent?: string; child?: string; baseline?: string }>;
  }> {
      const result = store.getResult(input.branchId, input.resultRevision);
      if (!result) throw new Error(`Working result not found: ${input.branchId}@${input.resultRevision}`);
      const branch = store.getBranch(input.branchId);
      if (!branch) throw new Error(`Working branch not found: ${input.branchId}`);
      const publications = this.inspectDirtyBuffers ? await this.inspectDirtyBuffers(input.workspaceId) : [];
      const dirty = dirtyResourceMap(publications);
      const diskParentStates: Record<string, RecoveryState> = {};
      const parentState: Record<string, RecoveryState> = {};
      const targets: Record<string, ReturnType<typeof classifyIntegrationTarget>> = {};
      const bindings: ThreadIntegrationPreview["binding"] = {};
      const texts: Record<string, { parent?: string; child?: string; baseline?: string }> = {};
      for (const file of result.changedPaths) {
        const disk = (await context.fileStore.captureState(context.identity, context.root, file, { store: true })).state;
        diskParentStates[file] = disk;
        const live = dirty.get(file);
        const target = classifyIntegrationTarget({
          draftBasePath: branch.draftBasePaths.includes(file),
          ...(live ? { dirty: live } : {}),
          inspectDirtyBuffers: Boolean(this.inspectDirtyBuffers),
          parentState: disk,
          baseState: result.baseStates[file]!,
          childState: result.pathStates[file]!,
        });
        targets[file] = target;
        const supplied = surfaceParentContent(file, input.surfaceParents);
        if (target === "surface" && supplied) {
          if (live && supplied.localEditRevision !== live.localEditRevision) {
            targets[file] = "unavailable";
            parentState[file] = disk;
            bindings[file] = { target: "unavailable", revision: parentRevisionOf(disk, live), localEditRevision: live.localEditRevision };
            continue;
          }
          const object = await store.putObject(Buffer.from(supplied.content, "utf8"));
          parentState[file] = {
            kind: "regular-file",
            objectHash: object.hash,
            byteLength: object.byteLength,
          };
          bindings[file] = {
            target: "surface",
            revision: parentRevisionOf(parentState[file]!, live ?? {
              resourceId: file,
              baseRevision: supplied.baseRevision,
              localEditRevision: supplied.localEditRevision,
              ownerId: "supplied",
            }),
            localEditRevision: supplied.localEditRevision,
          };
          texts[file] = { ...(texts[file] ?? {}), parent: supplied.content };
        } else if (target === "surface") {
          parentState[file] = disk;
          bindings[file] = {
            target: "surface",
            revision: parentRevisionOf(disk, live),
            ...(live ? { localEditRevision: live.localEditRevision } : {}),
          };
        } else {
          parentState[file] = disk;
          bindings[file] = { target: "disk", revision: parentRevisionOf(disk) };
        }
        const child = result.pathStates[file];
        const base = result.baseStates[file];
        if (child?.kind === "regular-file") {
          const bytes = await store.getObject(child.objectHash);
          if (bytes) texts[file] = { ...texts[file], child: bytes.toString("utf8") };
        }
        if (base?.kind === "regular-file") {
          const bytes = await store.getObject(base.objectHash);
          if (bytes) texts[file] = { ...texts[file], baseline: bytes.toString("utf8") };
        }
      }
      const plan = applyResolutions(await buildThreeWayMergePlan({
        operationId: `integration-${randomUUID()}`,
        workspaceId: input.workspaceId,
        threadId: input.threadId,
        resultRevision: input.resultRevision,
        allPaths: result.changedPaths,
        baseState: result.baseStates,
        parentState,
        childState: result.pathStates,
        readContent: async (state) => state.kind === "regular-file" ? store.getObject(state.objectHash) : null,
      }), input.resolutions);
      const diskTargets: Record<string, DurableFileTarget> = {};
      const surfaceEdits: ThreadSurfaceEdit[] = [];
      for (const pathPlan of plan.paths) {
        if (targets[pathPlan.path] !== "disk") continue;
        const target = await mergeTarget(store, pathPlan);
        if (target) diskTargets[pathPlan.path] = { expected: pathPlan.parentState, target };
      }
      for (const pathPlan of plan.paths) {
        if (targets[pathPlan.path] !== "surface") continue;
        const supplied = surfaceParentContent(pathPlan.path, input.surfaceParents);
        if (!supplied) continue;
        const merged = pathPlan.decision === "apply-child" && pathPlan.childState.kind === "regular-file"
          ? texts[pathPlan.path]?.child
          : pathPlan.mergedText;
        if (merged === undefined) continue;
        if (pathPlan.decision === "conflict") continue;
        surfaceEdits.push({
          resourceId: pathPlan.path,
          expectedLocalEditRevision: supplied.localEditRevision,
          expectedBaseRevision: supplied.baseRevision,
          newText: merged,
        });
      }
      const preview = projectPreview(plan, targets, bindings, {}, texts);
      return {
        plan,
        preview,
        targets,
        diskTargets,
        diskParentStates,
        childStates: result.pathStates,
        changedPaths: result.changedPaths,
        surfaceEdits,
        texts,
      };
  }
}
