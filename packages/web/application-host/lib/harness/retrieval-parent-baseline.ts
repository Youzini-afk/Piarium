import type { Thread, ThreadParent, ThreadWorktree } from "@piarium/protocol";
import type { ThreadRegistry } from "./thread-registry.js";
import type { WorkspaceWorkingStateAccess } from "./working-state/working-state-store.js";

export interface RetrievalParentBaseline {
  branchId: string;
  baseRef: string;
  worktree: ThreadWorktree;
}

const isVirtualWorktree = (worktree: Thread["worktree"] | undefined): boolean => (
  worktree?.viewMode === "virtual"
);

const usesWorkingBranchAuthority = (thread: Thread | null | undefined): boolean => Boolean(
  thread?.workBranchId
  && (isVirtualWorktree(thread.worktree) || thread.worktree?.materialized === false)
);

export async function pinRetrievalParentBaseline(input: {
  workspaceId: string;
  parent: ThreadParent;
  childThreadId: string;
  cwd: string;
  registry: ThreadRegistry;
  workingStates: WorkspaceWorkingStateAccess;
}): Promise<RetrievalParentBaseline | null> {
  if (input.parent.kind !== "thread") return null;
  const owner = await input.registry.getThreadById(input.workspaceId, input.parent.id);
  if (!owner) throw new Error(`Parent thread not found: ${input.parent.id}`);
  const branchId = `thread-${input.childThreadId}`;
  if (usesWorkingBranchAuthority(owner)) {
    return input.workingStates.withStore(input.workspaceId, "retrieval-parent-virtual-baseline", async (store) => {
      const parentBranch = store.getBranch(owner.workBranchId!);
      const parentView = store.effectiveState(owner.workBranchId!);
      if (!parentBranch || !parentView) {
        throw new Error(`Parent working branch is unavailable: ${owner.workBranchId}`);
      }
      const beforeRevision = parentBranch.writeRevision ?? 0;
      const baseRef = `thread-${input.parent.id}@${beforeRevision}`;
      await store.createBranch(
        input.workspaceId,
        branchId,
        parentView,
        baseRef,
        [],
        parentBranch.captureScopes,
      );
      const afterRevision = store.getBranch(owner.workBranchId!)?.writeRevision ?? 0;
      if (afterRevision !== beforeRevision) {
        throw new Error(`Parent working branch changed during retrieval baseline capture: ${String(beforeRevision)} -> ${String(afterRevision)}`);
      }
      return {
        branchId,
        baseRef,
        worktree: {
          path: input.cwd,
          base: baseRef,
          viewMode: "virtual",
          materialized: false,
          preparationStage: "ready",
        },
      };
    });
  }
  if (owner.worktree?.path && owner.worktree.materialized !== false && !isVirtualWorktree(owner.worktree)) {
    return input.workingStates.withStore(input.workspaceId, "retrieval-parent-materialized-baseline", async (store) => {
      const captured = await store.captureDirectory(owner.worktree!.path);
      const baseRef = `thread-${input.parent.id}@materialized`;
      await store.createBranch(input.workspaceId, branchId, captured, baseRef);
      return {
        branchId,
        baseRef,
        worktree: {
          path: input.cwd,
          base: baseRef,
          viewMode: "virtual",
          materialized: false,
          preparationStage: "ready",
        },
      };
    });
  }
  return null;
}
