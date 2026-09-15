import type { ThreadWorktree } from "@piarium/protocol";
import { canonicalizePathIdentity, isPathWithinRoot, normalizePathIdentity } from "../workspace/path-safety.js";
import type { KernelFileRootResolver } from "./storage-adapter.js";

/** Managed admission is a retained Thread ownership fact, not a guessed data
 * directory prefix or a new Documents workspace rooted at the target itself. */
export function createManagedRootAdmission(options: {
  listWorktrees(workspaceId: string): Promise<ThreadWorktree[]>;
  assertOwnership(worktree: ThreadWorktree, operation: string, candidates: readonly string[]): Promise<void>;
}): { materialization: KernelFileRootResolver; container: KernelFileRootResolver } {
  const resolve = async (directory: string, owningWorkspaceId: string, kind: "target" | "container") => {
    const requested = normalizePathIdentity(await canonicalizePathIdentity(directory, { allowMissing: true }));
    const worktrees = await options.listWorktrees(owningWorkspaceId);
    let recorded: ThreadWorktree | undefined;
    for (const worktree of worktrees) {
      const candidate = kind === "target" ? worktree.path : worktree.managedRoot;
      if (!candidate) continue;
      const canonicalCandidate = await canonicalizePathIdentity(candidate, { allowMissing: true });
      if (normalizePathIdentity(canonicalCandidate) === requested) {
        recorded = worktree;
        break;
      }
    }
    if (!recorded?.managedRoot) {
      throw new Error(`Managed path has no retained Thread ownership: ${directory}`);
    }
    await options.assertOwnership(recorded, "kernel managed-root admission", kind === "target" ? [directory] : []);
    const canonicalRoot = await canonicalizePathIdentity(recorded.managedRoot);
    const target = await canonicalizePathIdentity(directory, { allowMissing: kind === "target" });
    if (!isPathWithinRoot(target, canonicalRoot)
      || (kind === "target" && normalizePathIdentity(target) === normalizePathIdentity(canonicalRoot))) {
      throw new Error(`Managed path escaped its retained root: ${directory}`);
    }
    return { workspaceId: owningWorkspaceId, canonicalRoot };
  };
  return {
    materialization: (directory, workspaceId) => resolve(directory, workspaceId, "target"),
    container: (directory, workspaceId) => resolve(directory, workspaceId, "container"),
  };
}
