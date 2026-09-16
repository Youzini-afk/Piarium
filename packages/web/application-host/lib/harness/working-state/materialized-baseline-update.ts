import { randomUUID } from "node:crypto";
import type { ThreadBaselineUpdate, ThreadWorktree } from "@piarium/protocol";
import { sameState } from "../../recovery/journal-files.js";
import {
  applyDurableFileOperation,
  inspectDurableIntegrationOperation,
  reconcileInterruptedIntegrationOperations,
  type DurableFileOperationContext,
  type DurableFileTarget,
  type ResolveDirectoryApplyContext,
} from "../../recovery/durable-file-operation.js";
import { rebaseBranchOntoParentRevision } from "./baseline-rebase.js";
import type { RecoveryState, WorkingStateRootStore, WorkingStateTreeEntry, WorkspaceWorkingStateRootAccess } from "./types.js";

const missing = (): RecoveryState => ({ kind: "missing" });
const stateMap = (entries: { path: string; state: RecoveryState }[]): Record<string, RecoveryState> =>
  Object.fromEntries(entries.map((entry) => [entry.path, entry.state]));
const deltaBetween = (base: Record<string, RecoveryState>, head: Record<string, RecoveryState>): Record<string, RecoveryState> =>
  Object.fromEntries([...new Set([...Object.keys(base), ...Object.keys(head)])]
    .filter((file) => !sameState(base[file] ?? missing(), head[file] ?? missing()))
    .map((file) => [file, head[file] ?? missing()]));

/**
 * Directory authority is not a virtual branch: capture its actual delta before
 * rebasing. A private native branch retains the planned base/root, the existing
 * Recovery operation owns conditional disk apply, and a Registry receipt ties
 * that apply to the final branch CAS. Neither a full-directory overwrite nor a
 * TypeScript filesystem/storage writer is introduced.
 */
export async function updateMaterializedBaseline(options: {
  workingStates: WorkspaceWorkingStateRootAccess;
  workspaceId: string;
  threadId: string;
  branchId: string;
  parentBranchId: string;
  parentRevision: number;
  worktree: ThreadWorktree;
  resolveDirectoryApplyContext: ResolveDirectoryApplyContext;
  /** Caller holds the Thread lifecycle and execution-directory maintenance gates. */
  persist(worktree: ThreadWorktree): Promise<void>;
  signal?: AbortSignal;
}) {
  let worktree = structuredClone(options.worktree);
  const baseRef = `${options.parentBranchId}@${options.parentRevision}`;
  const resolved = await options.resolveDirectoryApplyContext(worktree.path, options.workspaceId);
  return options.workingStates.withBranchStore(options.workspaceId, "thread-baseline-directory-update", async (store, sourceContext) => {
    if (!sourceContext?.durableRecoveryStore) throw new Error("Baseline update needs the native recovery operation authority");
    const context: DurableFileOperationContext = {
      ...sourceContext,
      durableRecoveryStore: sourceContext.durableRecoveryStore,
      identity: { ...sourceContext.identity, canonicalRoot: worktree.path },
      resourceOperationGate: resolved.resourceOperationGate,
      resolveDirectoryApplyContext: options.resolveDirectoryApplyContext,
    };
    const persist = async (next: ThreadWorktree): Promise<void> => {
      await options.persist(next);
      worktree = structuredClone(next);
    };
    const finish = async (intent: ThreadBaselineUpdate) => {
      // Persist the committed outcome before releasing its native staging root.
      // An interrupted cleanup can repeat safely without another file apply.
      await persist({ ...worktree, base: baseRef, baselineUpdate: { ...intent, phase: "committed" } });
      if (await store.getBranchRoot(intent.stageBranchId)) await store.deleteBranch(intent.stageBranchId);
      const { baselineUpdate: _intent, ...ready } = worktree;
      await persist(ready);
      return {
        status: "applied" as const, threadId: options.threadId, resultRevision: options.parentRevision,
        baseRef, operationId: intent.operationId, updatedFromParent: intent.updatedFromParent,
        keptPaths: intent.keptChildPaths, mergedPaths: intent.mergedPaths, conflicts: intent.conflicts,
      };
    };
    const abandon = async (intent: ThreadBaselineUpdate): Promise<void> => {
      // Only used when the durable operation proves no apply, or full compensation.
      // Keep the receipt until native cleanup succeeds, making retry re-entrant.
      if (await store.getBranchRoot(intent.stageBranchId)) await store.deleteBranch(intent.stageBranchId);
      const { baselineUpdate: _intent, ...ready } = worktree;
      await persist(ready);
    };
    const commitBaseline = async (intent: ThreadBaselineUpdate) => {
      const stage = await store.getBranchRoot(intent.stageBranchId);
      const current = await store.getBranchRoot(options.branchId);
      if (!stage || !current || stage.root !== intent.plannedRoot) throw new Error("Baseline update lost its fixed native root");
      const alreadyCommitted = current.root === stage.root && current.baseRoot === stage.baseRoot;
      if (!alreadyCommitted && (current.writeRevision !== intent.expectedWriteRevision || current.root !== intent.originalRoot
        || current.baseRoot !== intent.originalBaseRoot)) {
        throw new Error(`Baseline update ${intent.operationId} needs reconciliation: the child branch changed`);
      }
      const [base, head] = await Promise.all([
        store.listPaths(intent.stageBranchId, [""], { revision: 0 }),
        store.listPaths(intent.stageBranchId, [""]),
      ]);
      if (!base || !head || head.root !== intent.plannedRoot) throw new Error("Baseline update staging view is unavailable");
      // The journal protects written paths. Also check paths left unchanged by
      // that apply before claiming that the branch mirrors the execution view.
      // External writes during a retry must remain visible, not be overwritten
      // or certified as the planned revision.
      const observed = await store.captureDirectory(worktree.path, undefined, { store: false });
      if (Object.keys(deltaBetween(stateMap(head.entries), observed)).length > 0) {
        throw new Error(`Baseline update ${intent.operationId} requires recovery: execution directory differs from the fixed plan`);
      }
      if (alreadyCommitted) return finish(intent);
      const changes = deltaBetween(stateMap(base.entries), stateMap(head.entries));
      // Import through authorized native object owners, not a hash-only read of
      // another branch. The stage remains retained until the target CAS succeeds.
      await ownChangedObjects(store, changes, head.entries);
      const committed = await store.rebaseBranch(options.branchId, intent.expectedWriteRevision, {
        baseRef: stage.baseRoot, parentRef: baseRef, baseState: stateMap(base.entries), changes,
      });
      if (committed.status !== "committed" || (committed.root !== undefined && committed.root !== intent.plannedRoot)) {
        throw new Error(`Baseline update ${intent.operationId} needs reconciliation: branch CAS did not commit the planned root`);
      }
      return finish(intent);
    };

    let intent = worktree.baselineUpdate;
    if (intent) {
      if (intent.parentBranchId !== options.parentBranchId || intent.parentResultRevision !== options.parentRevision) {
        throw new Error(`Finish baseline update ${intent.operationId} before selecting another parent revision`);
      }
      if (intent.phase === "committed") return finish(intent);
      const operation = await context.durableRecoveryStore.getOperation(options.workspaceId, intent.operationId);
      if (operation) {
        await reconcileInterruptedIntegrationOperations(context, { operationId: intent.operationId });
        const inspected = await inspectDurableIntegrationOperation(context, intent.operationId);
        if (inspected.state === "complete") return commitBaseline(intent);
        if (!["aborted", "compensated"].includes(inspected.state)) {
          throw new Error(`Baseline update ${intent.operationId} requires recovery (${inspected.state})`);
        }
      }
      // No journal means no filesystem effect: the existing primitive writes
      // intent first. A compensated operation is equally safe to re-plan.
      await abandon(intent);
      intent = undefined;
    }

    options.signal?.throwIfAborted();
    const original = await store.getBranchRoot(options.branchId);
    if (!original) throw new Error(`Working branch not found: ${options.branchId}`);
    const captured = await store.captureDirectory(worktree.path, undefined, { ...(options.signal ? { signal: options.signal } : {}) });
    const stageBranchId = `baseline-update-${randomUUID()}`;
    const sourcePin = await store.pinBranch(options.branchId, { revision: 0, ...(options.signal ? { signal: options.signal } : {}) });
    try {
      await store.createBranchFromPin(options.workspaceId, stageBranchId, sourcePin,
        `${options.branchId}@0`, null, original.captureScopes);
    } finally { await sourcePin.release(); }
    let receiptPersisted = false;
    try {
      const base = await store.listPaths(stageBranchId, [""]);
      if (!base) throw new Error("Baseline staging branch was not created");
      const imported = await store.commitVirtualWrites(stageBranchId, base.branch.writeRevision, deltaBetween(stateMap(base.entries), captured));
      if (imported.status !== "committed") throw new Error("Baseline staging capture changed unexpectedly");
      const planned = await rebaseBranchOntoParentRevision(store, stageBranchId, options.parentBranchId, options.parentRevision, options.signal ? { signal: options.signal } : undefined);
      if (planned.status !== "committed" || !planned.root) throw new Error("Baseline staging plan did not commit");
      const target = await store.listPaths(stageBranchId, [""]);
      if (!target || target.root !== planned.root) throw new Error("Baseline staging root changed during planning");
      const desired = stateMap(target.entries);
      const targets: Record<string, DurableFileTarget> = Object.fromEntries(Object.entries(deltaBetween(captured, desired))
        .map(([file, state]) => [file, { expected: captured[file] ?? missing(), target: state }]));
      options.signal?.throwIfAborted();
      intent = {
        operationId: `baseline-apply-${randomUUID()}`, stageBranchId,
        parentBranchId: options.parentBranchId, parentResultRevision: options.parentRevision,
        expectedWriteRevision: original.writeRevision, originalRoot: original.root, originalBaseRoot: original.baseRoot,
        plannedRoot: planned.root, phase: "prepared", updatedFromParent: planned.updatedFromParent,
        keptChildPaths: planned.keptChildPaths, mergedPaths: planned.mergedPaths, conflicts: planned.conflicts,
      };
      receiptPersisted = true;
      await persist({ ...worktree, baselineUpdate: intent });
      // From this point we finish or retain the handoff even if the requester
      // disconnects. Do not interrupt a durable apply and falsely clear intent.
      const applied = await applyDurableFileOperation(context, {
        id: intent.operationId, workspaceId: options.workspaceId, threadId: options.threadId,
        resultRevision: baseRef, targets, conflictPaths: [],
        diffStats: { files: Object.keys(targets).length, insertions: 0, deletions: 0 },
        applyCanonicalRoot: worktree.path, applyExecutionWorkspaceId: resolved.workspaceId,
      });
      if (applied.status !== "applied") {
        if (applied.status === "conflict" && applied.appliedPaths.length === 0 || applied.status === "compensated") {
          await abandon(intent);
        }
        throw new Error(`Baseline update ${intent.operationId} was not applied (${applied.status}): ${applied.text}`);
      }
      return await commitBaseline(intent);
    } catch (error) {
      if (!receiptPersisted && await store.getBranchRoot(stageBranchId)) await store.deleteBranch(stageBranchId);
      throw error;
    }
  }, "exclusive", { threadId: options.threadId, executionWorkspace: resolved.workspaceId });
}

async function ownChangedObjects(store: WorkingStateRootStore, changes: Record<string, RecoveryState>, entries: WorkingStateTreeEntry[]): Promise<void> {
  const seen = new Set<string>();
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  for (const [path, state] of Object.entries(changes)) {
    if (state.kind !== "regular-file" || seen.has(state.objectHash)) continue;
    const entry = byPath.get(path);
    if (!entry || !sameState(entry.state, state)) throw new Error("A staged baseline source changed");
    const bytes = await store.readContent(entry);
    if (!bytes) throw new Error("A staged baseline object is unavailable");
    await store.putObject(bytes);
    seen.add(state.objectHash);
  }
}
