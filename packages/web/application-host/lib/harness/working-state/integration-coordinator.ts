import { createHash, randomUUID } from "node:crypto";
import type {
  IntegrationApplyPhase,
  ThreadConflictResolution,
  ThreadIntegrationPreview,
} from "@piarium/protocol";
import type {
  DocumentSurfaceOperationRequest,
  DocumentSurfaceOperationResult,
} from "../../documents/authority.js";
import type { IntegrationApplyResult, RecoveryState, ThreeWayMergePlan, ThreeWayPathPlan } from "./types.js";
import { buildThreeWayMergePlan } from "./three-way-merge.js";
import type { WorkspaceWorkingStateAccess, WorkingStateStore } from "./working-state-store.js";
import type { WorkspaceRecoveryStorageContext } from "../../recovery/journal-engine.js";
import {
  classifyIntegrationTarget,
  dirtyResourceMap,
  parentRevisionOf,
  selectDirtyResource,
  type DirtyBufferInspectResource,
  type DirtyBufferInspectPublication,
} from "./integration-parents.js";
import {
  applyDurableFileOperation,
  finalizeDurableExternalOperation,
  findReusableCompleteIntegration,
  findReusableIntegrationConflict,
  inspectDurableIntegrationOperation,
  markDurableExternalUndoDispatched,
  markDurableIntegrationNeedsAttention,
  markDurableExternalDispatched,
  reconcileInterruptedBranchIntegrations,
  reconcileInterruptedIntegrationOperations,
  undoDurableIntegrationOperation,
  type DurableExternalBinding,
  type DurableFileOperationContext,
  type DurableFileTarget,
  type HostResourceOperationGate,
} from "../../recovery/durable-file-operation.js";
import { sameState } from "../../recovery/journal-files.js";
import { assertIntegrationTurnBinding } from "../../recovery/integration-turn-binding.js";
import { writeOperationRow, type SqliteDatabase } from "../../recovery/journal-catalog.js";
import { inspectDocumentBytes } from "../../documents/inspect.js";

export class DirectoryApplyUnresolvedError extends Error {
  readonly directory: string;

  constructor(directory: string, options?: { cause?: unknown }) {
    super(`Execution workspace could not be resolved for directory apply: ${directory}`, options);
    this.name = "DirectoryApplyUnresolvedError";
    this.directory = directory;
  }
}

interface PlannedSurfaceTextEdit {
  resourceId: string;
  expectedLocalEditRevision: number;
  expectedBaseRevision: string | null;
  newText: string;
}

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
  beginDirtyStateBarrier?: (workspaceId: string, paths: string[]) => Promise<{
    release(): Promise<void>;
  }>;
  requestSurfaceOperation?: (
    request: DocumentSurfaceOperationRequest,
    options?: { signal?: AbortSignal },
  ) => Promise<DocumentSurfaceOperationResult[]>;
  commitParentVirtualWrites?: (input: {
    workspaceId: string;
    branchId: string;
    files: Record<string, RecoveryState>;
    expectedWriteRevision: number;
    store: WorkingStateStore;
    sessionId?: string;
  }) => Promise<{ status: "committed"; writeRevision: number } | { status: "conflict"; writeRevision: number }>;
  holdParentVirtualWrite?: (
    sessionId: string,
    signal?: AbortSignal,
  ) => Promise<{ status: "disk" } | { status: "virtual"; release(): void }>;
  resolveParentSessionId?: (workspaceId: string, branchId: string) => string | undefined;
  resolveDirectoryApplyContext?: (directory: string) => Promise<{
    workspaceId: string;
    resourceOperationGate: HostResourceOperationGate;
  }>;
}

export interface IntegrationPlanInput {
  workspaceId: string;
  threadId: string;
  branchId: string;
  resultRevision: number;
  executionId?: string;
  requireTurnBinding?: boolean;
  sourceOwner?: { ownerId: string; generation: number };
  expectedBindingFingerprint?: string;
  signal?: AbortSignal;
  resolutions?: ThreadConflictResolution[];
  /** Where the parent writable view lives when this Thread is nested. */
  parentAuthority?:
    | { kind: "workspace" }
    | { kind: "branch"; branchId: string; sessionId?: string }
    | { kind: "directory"; directory: string; workspaceId?: string };
}

const mergeTarget = async (
  store: WorkingStateStore,
  pathPlan: ThreeWayPathPlan,
): Promise<RecoveryState | null> => {
  if (pathPlan.decision === "apply-child") {
    const child = pathPlan.childState;
    if (
      child.kind === "regular-file"
      && child.mode === undefined
      && pathPlan.parentState.kind === "regular-file"
      && pathPlan.parentState.mode !== undefined
    ) {
      return { ...child, mode: pathPlan.parentState.mode };
    }
    return child;
  }
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

const decodeUtf8 = (bytes: Buffer | null): string | undefined => {
  if (bytes === null) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
};

const contentHash = (content: string): string => `sha256-${createHash("sha256").update(content, "utf8").digest("hex")}`;
const normalizeEditorText = (content: string): string => content.replace(/\r\n|\r/gu, "\n");

const editorStateFrom = async (
  store: WorkingStateStore,
  state: RecoveryState,
): Promise<RecoveryState> => {
  if (state.kind !== "regular-file") return state;
  const bytes = await store.getObject(state.objectHash);
  if (bytes === null) return state;
  const inspected = inspectDocumentBytes(bytes);
  if (inspected.kind !== "text") return state;
  const object = await store.putObject(Buffer.from(normalizeEditorText(inspected.content), "utf8"));
  return {
    kind: "regular-file",
    objectHash: object.hash,
    byteLength: object.byteLength,
    ...(state.mode === undefined ? {} : { mode: state.mode }),
  };
};

const readableText = async (store: WorkingStateStore, state: RecoveryState): Promise<string | undefined> => {
  if (state.kind !== "regular-file") return undefined;
  const bytes = await store.getObject(state.objectHash);
  if (bytes === null) return undefined;
  const inspected = inspectDocumentBytes(bytes);
  return inspected.kind === "text" ? inspected.content : undefined;
};

const surfaceBinding = (resource: DirtyBufferInspectResource): ThreadIntegrationPreview["binding"][string] => ({
  target: "surface",
  revision: parentRevisionOf({ kind: "missing" }, resource),
  localEditRevision: resource.localEditRevision,
  baseRevision: resource.baseRevision,
  ownerId: resource.ownerId,
  ownerGeneration: resource.generation,
  ownerRegistrationId: resource.registrationId,
  documentInstanceId: resource.documentInstanceId,
  bufferHash: resource.bufferHash,
  encoding: resource.encoding,
  bom: resource.bom,
  lineEnding: resource.lineEnding,
});

const applyResolutions = (
  plan: ThreeWayMergePlan,
  resolutions: readonly ThreadConflictResolution[] | undefined,
  bindings: ThreadIntegrationPreview["binding"],
  expectedBindingFingerprint: string | undefined,
): ThreeWayMergePlan => {
  if (!resolutions?.length) return plan;
  const actualFingerprint = previewFingerprint(bindings, Number(plan.resultRevision));
  if (!expectedBindingFingerprint || expectedBindingFingerprint !== actualFingerprint) {
    throw new Error("Integration conflict resolutions are stale because the parent binding changed");
  }
  const byPath = new Map(resolutions.map((resolution) => [resolution.path, resolution]));
  const paths = plan.paths.map((pathPlan) => {
    const resolution = byPath.get(pathPlan.path);
    if (!resolution || pathPlan.decision !== "conflict") return pathPlan;
    const binding = bindings[pathPlan.path];
    if (!binding || resolution.expectedParentRevision !== binding.revision
      || (binding.target === "surface" && resolution.expectedLocalEditRevision !== binding.localEditRevision)) {
      throw new Error(`Integration resolution for ${pathPlan.path} is stale`);
    }
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
    targets[pathPlan.path] === "surface" && readTexts[pathPlan.path]?.parent === undefined
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
        phase: phases[pathPlan.path]
          ?? (pathPlan.decision === "identical" || pathPlan.decision === "keep-parent" ? "skipped-identical" : "pending"),
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
  private readonly beginDirtyStateBarrier?: IntegrationCoordinatorOptions["beginDirtyStateBarrier"];
  private readonly requestSurfaceOperation?: IntegrationCoordinatorOptions["requestSurfaceOperation"];
  private readonly commitParentVirtualWrites?: IntegrationCoordinatorOptions["commitParentVirtualWrites"];
  private readonly holdParentVirtualWrite?: IntegrationCoordinatorOptions["holdParentVirtualWrite"];
  private readonly resolveParentSessionId?: IntegrationCoordinatorOptions["resolveParentSessionId"];
  private readonly resolveDirectoryApplyContext?: IntegrationCoordinatorOptions["resolveDirectoryApplyContext"];
  private readonly previewByThread = new Map<string, { workspaceId: string; preview: ThreadIntegrationPreview }>();

  constructor(options: IntegrationCoordinatorOptions) {
    this.workingStates = options.workingStates;
    this.inspectDirtyBuffers = options.inspectDirtyBuffers;
    this.beginDirtyStateBarrier = options.beginDirtyStateBarrier;
    this.requestSurfaceOperation = options.requestSurfaceOperation;
    this.commitParentVirtualWrites = options.commitParentVirtualWrites;
    this.holdParentVirtualWrite = options.holdParentVirtualWrite;
    this.resolveParentSessionId = options.resolveParentSessionId;
    this.resolveDirectoryApplyContext = options.resolveDirectoryApplyContext;
  }

  invalidateThread(workspaceId: string, threadId: string): void {
    this.previewByThread.delete(this.previewKey(workspaceId, threadId));
  }

  private async directoryApplyContext(
    context: DurableFileOperationContext,
    parentAuthority: { kind: "directory"; directory: string; workspaceId?: string },
  ): Promise<{ context: DurableFileOperationContext; executionWorkspaceId: string }> {
    if (!this.resolveDirectoryApplyContext) {
      throw new DirectoryApplyUnresolvedError(parentAuthority.directory);
    }
    try {
      const resolved = await this.resolveDirectoryApplyContext(parentAuthority.directory);
      return {
        executionWorkspaceId: resolved.workspaceId,
        context: {
          ...context,
          identity: {
            ...context.identity,
            canonicalRoot: parentAuthority.directory,
          },
          resourceOperationGate: resolved.resourceOperationGate,
        },
      };
    } catch (error) {
      if (error instanceof DirectoryApplyUnresolvedError) throw error;
      throw new DirectoryApplyUnresolvedError(parentAuthority.directory, { cause: error });
    }
  }

  private persistBranchIntegration(
    context: DurableFileOperationContext,
    input: {
      operationId: string;
      workspaceId: string;
      threadId: string;
      branchId: string;
      resultRevision: number;
      parentBranchId: string;
      beforeWriteRevision: number;
      afterWriteRevision: number;
      beforeStates: Record<string, RecoveryState>;
      afterStates: Record<string, RecoveryState>;
      childStates: Record<string, RecoveryState>;
      appliedPaths: string[];
      conflictPaths: string[];
      diffStats: { files: number; insertions: number; deletions: number };
      state: "applying" | "complete" | "conflict";
      createdAt: string;
    },
  ): void {
    const targets = Object.fromEntries(Object.keys(input.beforeStates).map((file) => [
      file,
      {
        expected: input.beforeStates[file]!,
        target: input.afterStates[file] ?? input.beforeStates[file]!,
      },
    ]));
    writeOperationRow(context.database, {
      id: input.operationId,
      workspaceId: input.workspaceId,
      kind: "integration",
      state: input.state,
      createdAt: input.createdAt,
      updatedAt: new Date().toISOString(),
      data: {
        operationId: input.operationId,
        threadId: input.threadId,
        resultRevision: input.resultRevision,
        targets,
        targetKinds: Object.fromEntries(Object.keys(targets).map((file) => [file, "branch"])),
        externalBindings: {},
        safety: structuredClone(input.beforeStates),
        conflictPaths: [...input.conflictPaths],
        appliedPaths: [...input.appliedPaths],
        compensatedPaths: [],
        needsAttentionPaths: [],
        diffStats: input.diffStats,
        parentBranchId: input.parentBranchId,
        beforeWriteRevision: input.beforeWriteRevision,
        afterWriteRevision: input.afterWriteRevision,
        retryBinding: {
          branchId: input.branchId,
          parentStates: structuredClone(input.beforeStates),
          childStates: structuredClone(input.childStates),
          resultingParentStates: structuredClone(input.afterStates),
        },
      },
    });
  }

  private sameParentSlice(
    current: Record<string, RecoveryState>,
    expected: Record<string, RecoveryState>,
  ): boolean {
    return Object.keys(expected).every((file) => sameState(current[file] ?? { kind: "missing" }, expected[file]!));
  }

  private previewKey(workspaceId: string, threadId: string): string {
    return `${workspaceId}\0${threadId}`;
  }

  latestPreview(workspaceId: string, threadId: string): ThreadIntegrationPreview | undefined {
    return this.previewByThread.get(this.previewKey(workspaceId, threadId))?.preview;
  }

  invalidateWorkspace(workspaceId: string, resourceIds?: readonly string[]): ThreadIntegrationPreview[] {
    const resources = resourceIds ? new Set(resourceIds) : null;
    const invalidated: ThreadIntegrationPreview[] = [];
    for (const [key, entry] of this.previewByThread) {
      if (!entry.preview.valid
        || entry.workspaceId !== workspaceId
        || (resources && !Object.keys(entry.preview.binding).some((path) => resources.has(path)))) continue;
      const preview = {
        ...entry.preview,
        valid: false,
        mergeReady: false,
        invalidReason: "Parent document state changed after this preview",
      };
      this.previewByThread.set(key, { workspaceId, preview });
      invalidated.push(preview);
    }
    return invalidated;
  }

  previewMatches(workspaceId: string, threadId: string, resultRevision: number, binding: ThreadIntegrationPreview["binding"]): boolean {
    const current = this.previewByThread.get(this.previewKey(workspaceId, threadId))?.preview;
    if (!current) return false;
    return current.valid
      && current.resultRevision === resultRevision
      && previewFingerprint(current.binding, current.resultRevision) === previewFingerprint(binding, resultRevision);
  }

  async previewResult(input: IntegrationPlanInput): Promise<ThreadIntegrationPreview> {
    const planned = await this.plan(input);
    this.previewByThread.set(this.previewKey(input.workspaceId, input.threadId), { workspaceId: input.workspaceId, preview: planned.preview });
    return planned.preview;
  }

  private async holdParentBranchWrite(
    parentAuthority: IntegrationPlanInput["parentAuthority"],
    signal?: AbortSignal,
  ): Promise<() => void> {
    if (parentAuthority?.kind !== "branch" || !parentAuthority.sessionId || !this.holdParentVirtualWrite) {
      return () => undefined;
    }
    const held = await this.holdParentVirtualWrite(parentAuthority.sessionId, signal);
    if (held.status === "disk") {
      throw new Error("Parent working branch is no longer virtual");
    }
    return () => held.release();
  }

  async mergeResult(input: IntegrationPlanInput): Promise<IntegrationApplyResult & { changedFiles: string[] }> {
    const releaseParentWrite = await this.holdParentBranchWrite(input.parentAuthority, input.signal);
    try {
    return await this.workingStates.withStore(input.workspaceId, "thread-result-integration", async (store, context) => {
      if (input.requireTurnBinding && !input.executionId) {
        throw new Error("Parent turn recovery binding is required for integration");
      }
      if (input.executionId) {
        assertIntegrationTurnBinding(context.database, input.workspaceId, input.executionId);
      }
      await reconcileInterruptedIntegrationOperations(context);
      await reconcileInterruptedBranchIntegrations(context, store);
      const blocking = context.database.prepare(`
        SELECT id, state FROM operations WHERE workspace_id = ? AND kind = 'integration'
        AND state NOT IN ('complete', 'conflict', 'compensated', 'aborted', 'undone') LIMIT 1
      `).get(input.workspaceId) as { id: string; state: string } | undefined;
      if (blocking) throw new Error(`Integration ${blocking.id} requires recovery before planning (${blocking.state})`);
      const planned = await this.planFrom(store, context, input);
      if (input.expectedBindingFingerprint
        && input.expectedBindingFingerprint !== planned.preview.bindingFingerprint) {
        throw new Error("Integration preview is stale because the parent binding changed");
      }
      const operationId = `integration-${randomUUID()}`;
      planned.plan = { ...planned.plan, operationId };
      planned.preview = { ...planned.preview, operationId };
      this.previewByThread.set(this.previewKey(input.workspaceId, input.threadId), { workspaceId: input.workspaceId, preview: planned.preview });
      const reusable = input.resolutions?.length ? null : findReusableIntegrationConflict(context, {
        workspaceId: input.workspaceId,
        threadId: input.threadId,
        branchId: input.branchId,
        resultRevision: input.resultRevision,
        childStates: planned.childStates,
        currentParentStates: planned.diskParentStates,
      }) ?? findReusableCompleteIntegration(context, {
        workspaceId: input.workspaceId,
        threadId: input.threadId,
        branchId: input.branchId,
        resultRevision: input.resultRevision,
        childStates: planned.childStates,
        currentParentStates: planned.diskParentStates,
      });
      if (reusable) {
        const preview = { ...planned.preview, operationId: reusable.operationId };
        this.previewByThread.set(this.previewKey(input.workspaceId, input.threadId), { workspaceId: input.workspaceId, preview });
        return {
          ...reusable,
          status: reusable.status as IntegrationApplyResult["status"],
          changedFiles: planned.changedPaths,
          ...(planned.preview.surfaceTargetPaths.length > 0 ? { surfaceTargetPaths: planned.preview.surfaceTargetPaths } : {}),
          preview,
        };
      }
      const pendingSurface = planned.preview.surfaceTargetPaths.filter((path) => (
        planned.plan.paths.some((pathPlan) => (
          pathPlan.path === path
          && (pathPlan.decision === "apply-child" || pathPlan.decision === "merge-clean")
        ))
        && !planned.surfaceEdits.some((edit) => edit.resourceId === path)
      ));
      const conflictPaths = [...new Set([
        ...planned.plan.conflictPaths,
        ...pendingSurface,
        ...planned.preview.unavailablePaths,
      ])].sort();
      const externalTargets: Record<string, DurableFileTarget> = {};
      const externalBindings: Record<string, DurableExternalBinding> = {};
      for (const edit of planned.surfaceEdits) {
        const pathPlan = planned.plan.paths.find((entry) => entry.path === edit.resourceId);
        if (!pathPlan) continue;
        const target = await mergeTarget(store, pathPlan);
        if (target) {
          externalTargets[edit.resourceId] = { expected: pathPlan.parentState, target };
          const binding = planned.preview.binding[edit.resourceId]!;
          externalBindings[edit.resourceId] = {
            ownerId: binding.ownerId!,
            ownerGeneration: binding.ownerGeneration!,
            ownerRegistrationId: binding.ownerRegistrationId!,
            documentInstanceId: binding.documentInstanceId!,
            baseRevision: binding.baseRevision!,
            beforeLocalEditRevision: binding.localEditRevision!,
            beforeHash: binding.bufferHash!,
            encoding: binding.encoding!,
            bom: binding.bom!,
            lineEnding: binding.lineEnding!,
          };
        }
      }
      input.signal?.throwIfAborted();
      const parentAuthority = input.parentAuthority ?? { kind: "workspace" as const };
      if (parentAuthority.kind === "branch") {
        const writes: Record<string, RecoveryState> = {};
        for (const pathPlan of planned.plan.paths) {
          if (pathPlan.decision === "keep-parent" || pathPlan.decision === "identical") continue;
          const target = await mergeTarget(store, pathPlan);
          if (target) writes[pathPlan.path] = target;
          else if (pathPlan.decision === "apply-child" && pathPlan.childState.kind === "missing") {
            writes[pathPlan.path] = { kind: "missing" };
          }
        }
        const parentBranch = store.getBranch(parentAuthority.branchId);
        if (!parentBranch) throw new Error(`Parent working branch not found: ${parentAuthority.branchId}`);
        const expectedWriteRevision = parentBranch.writeRevision ?? 0;
        const failed = planned.plan.conflictPaths.length > 0 || planned.preview.unavailablePaths.length > 0;
        const appliedPaths = failed ? [] : Object.keys(writes).sort();
        const afterStates = { ...planned.diskParentStates, ...(failed ? {} : writes) };
        const createdAt = new Date().toISOString();
        let afterWriteRevision = expectedWriteRevision;
        if (!failed) {
          afterWriteRevision = expectedWriteRevision + 1;
          this.persistBranchIntegration(context, {
            operationId: planned.plan.operationId,
            workspaceId: input.workspaceId,
            threadId: input.threadId,
            branchId: input.branchId,
            resultRevision: input.resultRevision,
            parentBranchId: parentAuthority.branchId,
            beforeWriteRevision: expectedWriteRevision,
            afterWriteRevision,
            beforeStates: planned.diskParentStates,
            afterStates,
            childStates: planned.childStates,
            appliedPaths,
            conflictPaths: [],
            diffStats: planned.plan.diffStats,
            state: "applying",
            createdAt,
          });
          const committed = this.commitParentVirtualWrites
            ? await this.commitParentVirtualWrites({
              workspaceId: input.workspaceId,
              branchId: parentAuthority.branchId,
              files: writes,
              expectedWriteRevision,
              store,
              ...(parentAuthority.sessionId ? { sessionId: parentAuthority.sessionId } : {}),
            })
            : await store.commitVirtualWrites(parentAuthority.branchId, expectedWriteRevision, writes);
          if (committed.status === "conflict") {
            throw new Error("Parent branch revision changed during nested merge");
          }
          afterWriteRevision = committed.writeRevision;
        }
        this.persistBranchIntegration(context, {
          operationId: planned.plan.operationId,
          workspaceId: input.workspaceId,
          threadId: input.threadId,
          branchId: input.branchId,
          resultRevision: input.resultRevision,
          parentBranchId: parentAuthority.branchId,
          beforeWriteRevision: expectedWriteRevision,
          afterWriteRevision,
          beforeStates: planned.diskParentStates,
          afterStates,
          childStates: planned.childStates,
          appliedPaths,
          conflictPaths: [...planned.plan.conflictPaths, ...planned.preview.unavailablePaths].sort(),
          diffStats: planned.plan.diffStats,
          state: failed ? "conflict" : "complete",
          createdAt,
        });
        const preview = { ...planned.preview, operationId: planned.plan.operationId };
        this.previewByThread.set(this.previewKey(input.workspaceId, input.threadId), { workspaceId: input.workspaceId, preview });
        return {
          status: failed ? "conflict" : "applied",
          appliedPaths,
          conflictPaths: [...planned.plan.conflictPaths, ...planned.preview.unavailablePaths].sort(),
          changedFiles: planned.changedPaths,
          diffStats: planned.plan.diffStats,
          operationId: planned.plan.operationId,
          text: failed
            ? "Nested merge could not apply cleanly to the parent branch"
            : `Merged ${appliedPaths.length} files into the parent branch`,
          preview,
        };
      }
      let applyContext = context;
      let applyExecutionWorkspaceId: string | undefined;
      if (parentAuthority.kind === "directory") {
        try {
          const resolved = await this.directoryApplyContext(context, parentAuthority);
          applyContext = resolved.context;
          applyExecutionWorkspaceId = resolved.executionWorkspaceId;
        } catch (error) {
          if (!(error instanceof DirectoryApplyUnresolvedError)) throw error;
          return {
            operationId: planned.plan.operationId,
            status: "needs-attention",
            appliedPaths: [],
            conflictPaths: [...planned.plan.conflictPaths, ...planned.preview.unavailablePaths].sort(),
            changedFiles: planned.changedPaths,
            needsAttentionPaths: planned.changedPaths,
            diffStats: planned.plan.diffStats,
            text: error.message,
            preview: planned.preview,
          };
        }
      }
      let applied = await applyDurableFileOperation(applyContext, {
        id: planned.plan.operationId,
        workspaceId: input.workspaceId,
        threadId: input.threadId,
        resultRevision: input.resultRevision,
        targets: planned.diskTargets,
        ...(Object.keys(externalTargets).length > 0 ? { externalTargets } : {}),
        ...(Object.keys(externalBindings).length > 0 ? { externalBindings } : {}),
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
        ...(parentAuthority.kind === "directory" ? { applyCanonicalRoot: parentAuthority.directory } : {}),
        ...(applyExecutionWorkspaceId ? { applyExecutionWorkspaceId } : {}),
      });
      const phases: Record<string, IntegrationApplyPhase> = {};
      for (const path of applied.appliedPaths) phases[path] = "disk-applied";
      if (applied.status === "pending") {
        const editsByPath = new Map(planned.surfaceEdits.map((edit) => [edit.resourceId, edit]));
        const grouped = new Map<string, {
          binding: ThreadIntegrationPreview["binding"][string];
          paths: string[];
        }>();
        for (const path of Object.keys(externalTargets)) {
          const binding = planned.preview.binding[path]!;
          const key = `${binding.ownerId}\0${binding.ownerGeneration}\0${binding.ownerRegistrationId}`;
          const group = grouped.get(key) ?? { binding, paths: [] };
          group.paths.push(path);
          grouped.set(key, group);
          phases[path] = "surface-intent";
        }
        markDurableExternalDispatched(context, applied.operationId, Object.keys(externalTargets));
        for (const path of Object.keys(externalTargets)) phases[path] = "surface-dispatched";
        const observed = new Map<string, DocumentSurfaceOperationResult>();
        const uncertain = new Set<string>();
        for (const group of grouped.values()) {
          const binding = group.binding;
          if (!this.requestSurfaceOperation || !binding.ownerId || binding.ownerGeneration === undefined
            || !binding.ownerRegistrationId || !binding.documentInstanceId || !binding.bufferHash
            || !binding.encoding || binding.bom === undefined || !binding.lineEnding
            || binding.localEditRevision === undefined || binding.baseRevision === undefined) {
            for (const file of group.paths) uncertain.add(file);
            continue;
          }
          try {
            const results = await this.requestSurfaceOperation({
              action: "apply",
              generation: binding.ownerGeneration,
              operationId: applied.operationId,
              ownerId: binding.ownerId,
              registrationId: binding.ownerRegistrationId,
              targets: group.paths.map((file) => {
                const current = planned.preview.binding[file]!;
                return {
                  baseRevision: current.baseRevision!,
                  bufferHash: current.bufferHash!,
                  documentInstanceId: current.documentInstanceId!,
                  encoding: current.encoding!,
                  bom: current.bom!,
                  lineEnding: current.lineEnding!,
                  localEditRevision: current.localEditRevision!,
                  resource: { workspaceId: input.workspaceId, resourceId: file },
                  newText: editsByPath.get(file)!.newText,
                };
              }),
              workspaceId: input.workspaceId,
            }, input.signal ? { signal: input.signal } : {});
            for (const result of results) observed.set(result.resource.resourceId, result);
          } catch {
            for (const file of group.paths) uncertain.add(file);
          }
        }
        const durableResults: Record<string, "applied" | "unchanged" | "needs-attention"> = {};
        const appliedSurface = new Set<string>();
        for (const file of Object.keys(externalTargets)) {
          const result = observed.get(file);
          const binding = planned.preview.binding[file]!;
          const edit = editsByPath.get(file)!;
          if (uncertain.has(file)) {
            durableResults[file] = "needs-attention";
          } else if (result?.status === "applied"
            && result.documentInstanceId === binding.documentInstanceId
            && result.beforeLocalEditRevision === binding.localEditRevision
            && result.beforeHash === binding.bufferHash
            && result.afterLocalEditRevision === binding.localEditRevision! + 1
            && result.afterHash === contentHash(edit.newText)) {
            durableResults[file] = "applied";
            appliedSurface.add(file);
          } else if (result?.status === "failed"
            && result.documentInstanceId === binding.documentInstanceId
            && result.afterLocalEditRevision === binding.localEditRevision
            && result.afterHash === binding.bufferHash) {
            durableResults[file] = "unchanged";
          } else {
            durableResults[file] = "needs-attention";
          }
        }
        const allApplied = Object.values(durableResults).every((status) => status === "applied");
        if (!allApplied && appliedSurface.size > 0) {
          for (const group of grouped.values()) {
            const paths = group.paths.filter((file) => appliedSurface.has(file));
            if (paths.length === 0) continue;
            const binding = group.binding;
            try {
              const undone = await this.requestSurfaceOperation!({
                action: "undo",
                generation: binding.ownerGeneration!,
                operationId: applied.operationId,
                ownerId: binding.ownerId!,
                registrationId: binding.ownerRegistrationId!,
                targets: paths.map((file) => {
                  const current = planned.preview.binding[file]!;
                  const edit = editsByPath.get(file)!;
                  return {
                    baseRevision: current.baseRevision!,
                    bufferHash: current.bufferHash!,
                    documentInstanceId: current.documentInstanceId!,
                    encoding: current.encoding!,
                    bom: current.bom!,
                    lineEnding: current.lineEnding!,
                    localEditRevision: current.localEditRevision!,
                    resource: { workspaceId: input.workspaceId, resourceId: file },
                    newText: edit.newText,
                    expectedAppliedRevision: current.localEditRevision! + 1,
                    expectedAppliedHash: contentHash(edit.newText),
                  };
                }),
                workspaceId: input.workspaceId,
              });
              const undoneByPath = new Map(undone.map((entry) => [entry.resource.resourceId, entry]));
              for (const file of paths) {
                durableResults[file] = undoneByPath.get(file)?.status === "undone" ? "unchanged" : "needs-attention";
              }
            } catch {
              for (const file of paths) durableResults[file] = "needs-attention";
            }
          }
        }
        applied = await finalizeDurableExternalOperation(context, {
          operationId: applied.operationId,
          results: durableResults,
          receipts: Object.fromEntries([...observed].flatMap(([file, result]) => (
            result.status === "applied" && result.afterLocalEditRevision !== undefined && result.afterHash
              ? [[file, { afterLocalEditRevision: result.afterLocalEditRevision, afterHash: result.afterHash }]]
              : []
          ))),
          ...(!allApplied ? { failure: "One or more editor buffers could not be applied atomically" } : {}),
        });
        for (const [file, status] of Object.entries(durableResults)) {
          phases[file] = status === "applied" ? "surface-applied"
            : status === "unchanged" ? "compensated" : "unavailable";
        }
      }
      if (applied.status === "pending") throw new Error(`Integration ${applied.operationId} did not finish its surface operation`);
      for (const path of applied.conflictPaths) {
        phases[path] = planned.targets[path] === "unavailable" ? "unavailable" : "conflict";
      }
      for (const path of applied.compensatedPaths ?? []) phases[path] = "compensated";
      for (const path of applied.needsAttentionPaths ?? []) phases[path] = "unavailable";
      persistSurfacePhases(context.database, applied.operationId, phases);
      const preview = projectPreview(planned.plan, planned.targets, planned.preview.binding, phases, planned.texts);
      this.previewByThread.set(this.previewKey(input.workspaceId, input.threadId), { workspaceId: input.workspaceId, preview });
      const status: IntegrationApplyResult["status"] = preview.unavailablePaths.length > 0 && applied.status === "applied"
        ? "needs-attention" as const
        : applied.status as IntegrationApplyResult["status"];
      return {
        ...applied,
        status,
        changedFiles: planned.changedPaths,
        ...(planned.preview.surfaceTargetPaths.length > 0 ? { surfaceTargetPaths: planned.preview.surfaceTargetPaths } : {}),
        preview,
      };
    });
    } finally {
      releaseParentWrite();
    }
  }

  async undoIntegration(input: {
    workspaceId: string;
    threadId: string;
    operationId: string;
    sourceOwner?: { ownerId: string; generation: number };
    signal?: AbortSignal;
  }): Promise<IntegrationApplyResult> {
    const inspection = await this.workingStates.withStore(
      input.workspaceId,
      "thread-result-integration-undo-inspect",
      (_store, context) => inspectDurableIntegrationOperation(context, input.operationId),
      "shared",
    );
    if (inspection.threadId !== input.threadId) throw new Error(`Integration operation does not belong to thread ${input.threadId}`);
    let releaseParentWrite = (): void => undefined;
    if (inspection.parentBranchId) {
      const sessionId = this.resolveParentSessionId?.(input.workspaceId, inspection.parentBranchId);
      if (sessionId && this.holdParentVirtualWrite) {
        const held = await this.holdParentVirtualWrite(sessionId, input.signal);
        if (held.status === "virtual") releaseParentWrite = () => held.release();
      }
    }
    try {
    return await this.workingStates.withStore(input.workspaceId, "thread-result-integration-undo", async (store, context) => {
      await reconcileInterruptedIntegrationOperations(context);
      await reconcileInterruptedBranchIntegrations(context, store);
      const operation = inspectDurableIntegrationOperation(context, input.operationId);
      if (operation.threadId !== input.threadId) throw new Error(`Integration operation does not belong to thread ${input.threadId}`);
      if (operation.parentBranchId) {
        const parentBranch = store.getBranch(operation.parentBranchId);
        if (!parentBranch) throw new Error(`Parent working branch not found: ${operation.parentBranchId}`);
        const before = operation.retryBinding?.parentStates ?? operation.safety;
        const after = operation.retryBinding?.resultingParentStates ?? Object.fromEntries(
          Object.entries(operation.targets).map(([file, states]) => [file, states.target]),
        );
        const currentView = store.effectiveState(operation.parentBranchId) ?? {};
        if (this.sameParentSlice(currentView, before)) {
          this.previewByThread.delete(this.previewKey(input.workspaceId, input.threadId));
          return {
            operationId: input.operationId,
            status: "compensated",
            appliedPaths: [],
            conflictPaths: [],
            compensatedPaths: [...operation.appliedPaths],
            diffStats: { files: operation.appliedPaths.length, insertions: 0, deletions: 0 },
            text: "Integration was undone.",
          };
        }
        if (!this.sameParentSlice(currentView, after)) {
          return {
            ...markDurableIntegrationNeedsAttention(
              context,
              input.operationId,
              Object.keys(after),
              "Parent branch changed before the nested integration could be undone",
            ),
            status: "needs-attention" as const,
          };
        }
        const parentSessionId = this.resolveParentSessionId?.(input.workspaceId, operation.parentBranchId);
        const committed = this.commitParentVirtualWrites
          ? await this.commitParentVirtualWrites({
            workspaceId: input.workspaceId,
            branchId: operation.parentBranchId,
            files: before,
            expectedWriteRevision: parentBranch.writeRevision ?? 0,
            store,
            ...(parentSessionId ? { sessionId: parentSessionId } : {}),
          })
          : await store.commitVirtualWrites(operation.parentBranchId, parentBranch.writeRevision ?? 0, before);
        if (committed.status === "conflict") {
          return {
            ...markDurableIntegrationNeedsAttention(
              context,
              input.operationId,
              Object.keys(after),
              "Parent branch revision changed during nested undo",
            ),
            status: "needs-attention" as const,
          };
        }
        writeOperationRow(context.database, {
          id: input.operationId,
          workspaceId: input.workspaceId,
          kind: "integration",
          state: "undone",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          data: {
            operationId: input.operationId,
            threadId: operation.threadId,
            resultRevision: operation.resultRevision,
            targets: operation.targets,
            targetKinds: operation.targetKinds,
            externalBindings: operation.externalBindings,
            safety: operation.safety,
            conflictPaths: [],
            appliedPaths: operation.appliedPaths,
            compensatedPaths: [...operation.appliedPaths],
            needsAttentionPaths: [],
            diffStats: { files: operation.appliedPaths.length, insertions: 0, deletions: 0 },
            parentBranchId: operation.parentBranchId,
            ...(operation.beforeWriteRevision === undefined ? {} : { beforeWriteRevision: operation.beforeWriteRevision }),
            ...(operation.afterWriteRevision === undefined ? {} : { afterWriteRevision: operation.afterWriteRevision }),
            ...(operation.retryBinding ? { retryBinding: operation.retryBinding } : {}),
          },
        });
        this.previewByThread.delete(this.previewKey(input.workspaceId, input.threadId));
        return {
          operationId: input.operationId,
          status: "compensated",
          appliedPaths: [],
          conflictPaths: [],
          compensatedPaths: [...operation.appliedPaths],
          diffStats: { files: operation.appliedPaths.length, insertions: 0, deletions: 0 },
          text: "Integration was undone.",
        };
      }
      let applyContext = context;
      if (operation.applyCanonicalRoot) {
        try {
          applyContext = (await this.directoryApplyContext(context, {
            kind: "directory",
            directory: operation.applyCanonicalRoot,
          })).context;
        } catch (error) {
          if (!(error instanceof DirectoryApplyUnresolvedError)) throw error;
          return {
            ...markDurableIntegrationNeedsAttention(
              context,
              input.operationId,
              operation.appliedPaths,
              error.message,
            ),
            status: "needs-attention" as const,
          };
        }
      }
      const surfacePaths = Object.entries(operation.targetKinds)
        .filter(([, kind]) => kind === "surface")
        .map(([file]) => file)
        .sort();
      const barrier = surfacePaths.length > 0 && this.beginDirtyStateBarrier
        ? await this.beginDirtyStateBarrier(input.workspaceId, surfacePaths)
        : null;
      // The barrier forces every connected owner to publish a fresh revision.
      // Release it before asking the registry to undo: registry edits are
      // deliberately fenced while a recovery barrier is held. The subsequent
      // owner/registration/instance/revision/hash checks provide the CAS.
      await barrier?.release();
      const undonePaths: string[] = [];
        if (surfacePaths.length > 0) {
          if (!this.requestSurfaceOperation) throw new Error("Document surface operation channel is unavailable");
          const grouped = new Map<string, { binding: DurableExternalBinding; paths: string[] }>();
          for (const file of surfacePaths) {
            const binding = operation.externalBindings[file];
            if (!binding || binding.afterLocalEditRevision === undefined || !binding.afterHash) {
              throw new Error(`Integration surface receipt is unavailable: ${file}`);
            }
            if (input.sourceOwner && (binding.ownerId !== input.sourceOwner.ownerId
              || binding.ownerGeneration !== input.sourceOwner.generation)) {
              throw new Error(`Integration was applied by another document surface: ${file}`);
            }
            const key = `${binding.ownerId}\0${binding.ownerGeneration}\0${binding.ownerRegistrationId}`;
            const group = grouped.get(key) ?? { binding, paths: [] };
            group.paths.push(file);
            grouped.set(key, group);
          }
          markDurableExternalUndoDispatched(context, input.operationId, surfacePaths);
          const failed: string[] = [];
          for (const group of grouped.values()) {
            try {
              const results = await this.requestSurfaceOperation({
                action: "undo",
                generation: group.binding.ownerGeneration,
                operationId: input.operationId,
                ownerId: group.binding.ownerId,
                registrationId: group.binding.ownerRegistrationId,
                targets: group.paths.map((file) => {
                  const binding = operation.externalBindings[file]!;
                  return {
                    baseRevision: binding.baseRevision,
                    bufferHash: binding.beforeHash,
                    documentInstanceId: binding.documentInstanceId,
                    encoding: binding.encoding,
                    bom: binding.bom,
                    lineEnding: binding.lineEnding,
                    localEditRevision: binding.beforeLocalEditRevision,
                    expectedAppliedRevision: binding.afterLocalEditRevision!,
                    expectedAppliedHash: binding.afterHash!,
                    resource: { workspaceId: input.workspaceId, resourceId: file },
                  };
                }),
                workspaceId: input.workspaceId,
              }, input.signal ? { signal: input.signal } : {});
              const byPath = new Map(results.map((result) => [result.resource.resourceId, result]));
              for (const file of group.paths) {
                const result = byPath.get(file);
                const binding = operation.externalBindings[file]!;
                if (result?.status === "undone" && result.documentInstanceId === binding.documentInstanceId
                  && result.afterHash === binding.beforeHash) undonePaths.push(file);
                else failed.push(file);
              }
            } catch {
              failed.push(...group.paths);
            }
          }
          if (failed.length > 0) {
            const attention = markDurableIntegrationNeedsAttention(
              context,
              input.operationId,
              failed,
              "One or more editor buffers changed before the integration could be undone",
            );
            return { ...attention, status: "needs-attention" as const };
          }
        }
        const undone = await undoDurableIntegrationOperation(applyContext, {
          operationId: input.operationId,
          surfaceUndonePaths: undonePaths,
        });
        this.previewByThread.delete(this.previewKey(input.workspaceId, input.threadId));
        if (undone.status === "pending") throw new Error(`Integration ${input.operationId} undo did not settle`);
      return { ...undone, status: undone.status as IntegrationApplyResult["status"] };
    });
    } finally {
      releaseParentWrite();
    }
  }

  private async plan(input: IntegrationPlanInput): Promise<{
    plan: ThreeWayMergePlan;
    preview: ThreadIntegrationPreview;
    targets: Record<string, ReturnType<typeof classifyIntegrationTarget>>;
    diskTargets: Record<string, DurableFileTarget>;
    diskParentStates: Record<string, RecoveryState>;
    childStates: Record<string, RecoveryState>;
    changedPaths: string[];
    surfaceEdits: PlannedSurfaceTextEdit[];
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
    surfaceEdits: PlannedSurfaceTextEdit[];
    texts: Record<string, { parent?: string; child?: string; baseline?: string }>;
  }> {
    const result = store.getResult(input.branchId, input.resultRevision);
    if (!result) throw new Error(`Working result not found: ${input.branchId}@${input.resultRevision}`);
    const branch = store.getBranch(input.branchId);
    if (!branch) throw new Error(`Working branch not found: ${input.branchId}`);
    const parentAuthority = input.parentAuthority ?? { kind: "workspace" as const };
    const barrier = parentAuthority.kind !== "branch" && this.beginDirtyStateBarrier
      ? await this.beginDirtyStateBarrier(input.workspaceId, result.changedPaths)
      : null;
    try {
      const publications = parentAuthority.kind !== "branch" && this.inspectDirtyBuffers
        ? await this.inspectDirtyBuffers(input.workspaceId)
        : [];
      const dirty = dirtyResourceMap(publications);
      const sourceOwner = input.sourceOwner;
      const sourceOwnerConnected = !sourceOwner || publications.some((publication) => (
        publication.ownerId === sourceOwner.ownerId
        && publication.generation === sourceOwner.generation
        && Boolean(publication.registrationId)
      ));
      const diskParentStates: Record<string, RecoveryState> = {};
      const parentState: Record<string, RecoveryState> = {};
      const targets: Record<string, ReturnType<typeof classifyIntegrationTarget>> = {};
      const bindings: ThreadIntegrationPreview["binding"] = {};
      const selectedSurfaces = new Map<string, DirtyBufferInspectResource>();
      const texts: Record<string, { parent?: string; child?: string; baseline?: string }> = {};
      const parentIdentity = parentAuthority.kind === "directory"
        ? { ...context.identity, canonicalRoot: parentAuthority.directory }
        : context.identity;
      const parentBranchView = parentAuthority.kind === "branch"
        ? store.effectiveState(parentAuthority.branchId) ?? {}
        : null;

      for (const file of result.changedPaths) {
        const disk = parentBranchView
          ? parentBranchView[file] ?? { kind: "missing" as const }
          : (await context.fileStore.captureState(parentIdentity, context.root, file, { store: true })).state;
        diskParentStates[file] = disk;
        if (parentAuthority.kind === "branch") {
          targets[file] = "disk";
          parentState[file] = disk;
          bindings[file] = { target: "disk", revision: parentRevisionOf(disk) };
          continue;
        }
        const selected = selectDirtyResource(dirty.get(file), input.sourceOwner);
        if (selected.status === "ambiguous"
          || (input.sourceOwner && !sourceOwnerConnected && branch.draftBasePaths.includes(file))) {
          targets[file] = "unavailable";
          parentState[file] = disk;
          bindings[file] = { target: "unavailable", revision: `ambiguous:${parentRevisionOf(disk)}` };
        } else {
          const live = selected.status === "selected" ? selected.resource : undefined;
          const target = classifyIntegrationTarget({
            draftBasePath: branch.draftBasePaths.includes(file),
            ...(live ? { dirty: live } : {}),
            inspectDirtyBuffers: Boolean(this.inspectDirtyBuffers),
            parentState: disk,
            baseState: result.baseStates[file]!,
            childState: result.pathStates[file]!,
          });
          targets[file] = target;
          if (target === "surface" && live) {
            selectedSurfaces.set(file, live);
            bindings[file] = surfaceBinding(live);
          } else {
            parentState[file] = disk;
            bindings[file] = {
              target,
              revision: target === "unavailable" ? `unavailable:${parentRevisionOf(disk)}` : parentRevisionOf(disk),
            };
          }
        }
      }

      const groups = new Map<string, { owner: DirtyBufferInspectResource; paths: string[] }>();
      for (const [file, owner] of selectedSurfaces) {
        const key = `${owner.ownerId}\0${owner.generation}\0${owner.registrationId}`;
        const group = groups.get(key) ?? { owner, paths: [] };
        group.paths.push(file);
        groups.set(key, group);
      }
      for (const group of groups.values()) {
        if (!this.requestSurfaceOperation) {
          for (const file of group.paths) {
            targets[file] = "unavailable";
            parentState[file] = diskParentStates[file]!;
            bindings[file] = { ...bindings[file]!, target: "unavailable" };
          }
          continue;
        }
        let captured: DocumentSurfaceOperationResult[];
        try {
          captured = await this.requestSurfaceOperation({
            action: "capture",
            generation: group.owner.generation,
            operationId: `preview-capture-${randomUUID()}`,
            ownerId: group.owner.ownerId,
            registrationId: group.owner.registrationId,
            targets: group.paths.map((file) => ({
              ...group.owner,
              ...selectedSurfaces.get(file)!,
              resource: { workspaceId: input.workspaceId, resourceId: file },
            })),
            workspaceId: input.workspaceId,
          }, input.signal ? { signal: input.signal } : {});
        } catch {
          input.signal?.throwIfAborted();
          captured = [];
        }
        const byPath = new Map(captured.map((entry) => [entry.resource.resourceId, entry]));
        for (const file of group.paths) {
          const live = selectedSurfaces.get(file)!;
          const entry = byPath.get(file);
          if (entry?.status !== "captured" || typeof entry.content !== "string"
            || entry.documentInstanceId !== live.documentInstanceId
            || entry.beforeLocalEditRevision !== live.localEditRevision
            || entry.beforeHash !== live.bufferHash
            || contentHash(entry.content) !== live.bufferHash) {
            targets[file] = "unavailable";
            parentState[file] = diskParentStates[file]!;
            bindings[file] = { ...bindings[file]!, target: "unavailable" };
            continue;
          }
          const object = await store.putObject(Buffer.from(entry.content, "utf8"));
          const disk = diskParentStates[file]!;
          const base = result.baseStates[file]!;
          const mode = disk.kind === "regular-file" ? disk.mode : base.kind === "regular-file" ? base.mode : undefined;
          parentState[file] = {
            kind: "regular-file",
            objectHash: object.hash,
            byteLength: object.byteLength,
            ...(mode === undefined ? {} : { mode }),
          };
          texts[file] = { ...texts[file], parent: entry.content };
        }
      }

      const mergeBaseStates = { ...result.baseStates };
      const mergeChildStates = { ...result.pathStates };
      for (const file of result.changedPaths) {
        if (targets[file] === "surface") {
          mergeBaseStates[file] = await editorStateFrom(store, result.baseStates[file]!);
          mergeChildStates[file] = await editorStateFrom(store, result.pathStates[file]!);
        }
        const childText = await readableText(store, mergeChildStates[file]!);
        const baselineText = await readableText(store, mergeBaseStates[file]!);
        if (childText !== undefined) texts[file] = { ...texts[file], child: childText };
        if (baselineText !== undefined) texts[file] = { ...texts[file], baseline: baselineText };
      }

      const preliminary = await buildThreeWayMergePlan({
        operationId: "preview-pending-binding",
        workspaceId: input.workspaceId,
        threadId: input.threadId,
        resultRevision: input.resultRevision,
        allPaths: result.changedPaths,
        baseState: mergeBaseStates,
        parentState,
        childState: mergeChildStates,
        readContent: async (state) => state.kind === "regular-file" ? store.getObject(state.objectHash) : null,
      });
      const bindingFingerprint = previewFingerprint(bindings, input.resultRevision);
      let plan = applyResolutions(
        { ...preliminary, operationId: `preview-${bindingFingerprint.slice(0, 24)}` },
        input.resolutions,
        bindings,
        input.expectedBindingFingerprint,
      );
      const unrepresentable = new Set<string>();
      plan = {
        ...plan,
        paths: plan.paths.map((pathPlan) => {
          if (targets[pathPlan.path] !== "surface"
            || pathPlan.decision === "identical" || pathPlan.decision === "keep-parent" || pathPlan.decision === "conflict") return pathPlan;
          const target = pathPlan.decision === "apply-child" ? pathPlan.childState : null;
          const targetText = target?.kind === "regular-file"
            ? texts[pathPlan.path]?.child
            : pathPlan.mergedText;
          const parentMode = pathPlan.parentState.kind === "regular-file" ? pathPlan.parentState.mode : undefined;
          const targetMode = target?.kind === "regular-file" ? target.mode : pathPlan.mergedMode;
          if (targetText !== undefined && targetMode === parentMode) return pathPlan;
          unrepresentable.add(pathPlan.path);
          return {
            ...pathPlan,
            decision: "conflict" as const,
            conflictReason: "The editor buffer cannot represent this deletion, binary/type change, or file-mode change",
            isText: false,
          };
        }),
      };
      if (unrepresentable.size > 0) {
        plan.conflictPaths = [...new Set([...plan.conflictPaths, ...unrepresentable])].sort();
        plan.appliedPaths = plan.appliedPaths.filter((file) => !unrepresentable.has(file));
        plan.clean = false;
      }
      const diskTargets: Record<string, DurableFileTarget> = {};
      const surfaceEdits: PlannedSurfaceTextEdit[] = [];
      for (const pathPlan of plan.paths) {
        const target = await mergeTarget(store, pathPlan);
        if (targets[pathPlan.path] === "disk") {
          if (target) diskTargets[pathPlan.path] = { expected: pathPlan.parentState, target };
          continue;
        }
        if (targets[pathPlan.path] !== "surface" || !target || target.kind !== "regular-file") continue;
        const newText = decodeUtf8(await store.getObject(target.objectHash));
        const live = selectedSurfaces.get(pathPlan.path);
        if (newText === undefined || !live) continue;
        surfaceEdits.push({
          resourceId: pathPlan.path,
          expectedLocalEditRevision: live.localEditRevision,
          expectedBaseRevision: live.baseRevision,
          newText,
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
    } finally {
      await barrier?.release();
    }
  }
}
