import { randomUUID } from "node:crypto";
import type { IntegrationApplyResult, RecoveryState, ThreeWayMergePlan } from "./types.js";
import { buildThreeWayMergePlan } from "./three-way-merge.js";
import type { WorkspaceWorkingStateAccess, WorkingStateStore } from "./working-state-store.js";
import {
  applyDurableFileOperation,
  findReusableIntegrationConflict,
  reconcileInterruptedIntegrationOperations,
  type DurableFileTarget,
} from "../../recovery/durable-file-operation.js";
import { assertIntegrationTurnBinding } from "../../recovery/integration-turn-binding.js";

export interface IntegrationCoordinatorOptions {
  workingStates: WorkspaceWorkingStateAccess;
}

const mergeTarget = async (
  store: WorkingStateStore,
  pathPlan: ThreeWayMergePlan["paths"][number],
): Promise<RecoveryState | null> => {
  if (pathPlan.decision === "apply-child") return pathPlan.childState;
  if (pathPlan.decision === "merge-clean" && pathPlan.mergedText !== undefined) {
    const bytes = Buffer.from(pathPlan.mergedText, "utf8");
    const object = await store.putObject(bytes);
    return {
      kind: "regular-file",
      objectHash: object.hash,
      byteLength: object.byteLength,
      ...(pathPlan.mergedMode !== undefined
        ? { mode: pathPlan.mergedMode }
        : {}),
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

export class IntegrationCoordinator {
  private readonly workingStates: WorkspaceWorkingStateAccess;

  constructor(options: IntegrationCoordinatorOptions) {
    this.workingStates = options.workingStates;
  }

  async mergeResult(input: {
    workspaceId: string;
    threadId: string;
    branchId: string;
    resultRevision: number;
    executionId?: string;
    requireTurnBinding?: boolean;
  }): Promise<IntegrationApplyResult & { changedFiles: string[] }> {
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
      const result = store.getResult(input.branchId, input.resultRevision);
      if (!result) throw new Error(`Working result not found: ${input.branchId}@${input.resultRevision}`);
      const parentState: Record<string, RecoveryState> = {};
      for (const file of result.changedPaths) {
        parentState[file] = (await context.fileStore.captureState(context.identity, context.root, file, { store: true })).state;
      }
      const reusable = findReusableIntegrationConflict(context, {
        workspaceId: input.workspaceId,
        threadId: input.threadId,
        branchId: input.branchId,
        resultRevision: input.resultRevision,
        childStates: result.pathStates,
        currentParentStates: parentState,
      });
      if (reusable) return { ...reusable, changedFiles: result.changedPaths };
      const plan = await buildThreeWayMergePlan({
        operationId: `integration-${randomUUID()}`,
        workspaceId: input.workspaceId,
        threadId: input.threadId,
        resultRevision: input.resultRevision,
        allPaths: result.changedPaths,
        baseState: result.baseStates,
        parentState,
        childState: result.pathStates,
        readContent: async (state) => state.kind === "regular-file" ? store.getObject(state.objectHash) : null,
      });
      const targets: Record<string, DurableFileTarget> = {};
      for (const pathPlan of plan.paths) {
        const target = await mergeTarget(store, pathPlan);
        if (target) targets[pathPlan.path] = { expected: pathPlan.parentState, target };
      }
      const applied = await applyDurableFileOperation(context, {
        id: plan.operationId,
        workspaceId: input.workspaceId,
        threadId: input.threadId,
        resultRevision: input.resultRevision,
        targets,
        conflictPaths: plan.conflictPaths,
        diffStats: plan.diffStats,
        ...(input.executionId ? { executionId: input.executionId } : {}),
        ...(input.requireTurnBinding ? { requireTurnBinding: true } : {}),
        retryBinding: {
          branchId: input.branchId,
          parentStates: parentState,
          childStates: result.pathStates,
          resultingParentStates: Object.fromEntries(result.changedPaths.map((file) => [
            file,
            targets[file]?.target ?? parentState[file]!,
          ])),
        },
      });
      return { ...applied, changedFiles: result.changedPaths };
    });
  }
}
