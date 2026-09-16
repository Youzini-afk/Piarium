import type { RecoveryState } from "../../recovery/journal-files.js";
import { planThreeWayPath } from "./three-way-merge.js";
import type { WorkingStateRootStore } from "./types.js";

export interface BaselineRebaseResult {
  status: "committed" | "conflict";
  writeRevision: number;
  root?: string;
  /** Paths where the parent revision's content was adopted (parent moved, child did not). */
  updatedFromParent: string[];
  /** Paths where the child's effective change was preserved over the new base. */
  keptChildPaths: string[];
  /** Paths merged textually clean. */
  mergedPaths: string[];
  /** Paths where both sides diverged; the child's bytes were kept and reported. */
  conflicts: { path: string; reason?: string }[];
}

const missing = (): RecoveryState => ({ kind: "missing" });

/**
 * Rebase a working branch onto a new immutable parent state (3.18D): the
 * branch baseline becomes the selected parent revision while every effective
 * child change is preserved through the same three-way rules used by result
 * integration. Paths where the child did not diverge adopt the parent bytes;
 * divergent paths keep the child's bytes and are reported as conflicts.
 * `changes` committed to the store are the complete new delta set.
 */
export async function rebaseBranchOntoParentRevision(
  store: WorkingStateRootStore,
  branchId: string,
  parentBranchId: string,
  parentRevision: number,
  options?: { signal?: AbortSignal },
): Promise<BaselineRebaseResult> {
  options?.signal?.throwIfAborted();
  const branch = await store.getBranchRoot(branchId, options?.signal ? { signal: options.signal } : undefined);
  if (!branch) throw new Error(`Working branch not found: ${branchId}`);
  const result = await store.getResult(parentBranchId, parentRevision, options);
  if (!result) throw new Error(`Parent result not found: ${parentBranchId}@${parentRevision}`);

  const [oldBaseRead, headRead, newBaseRead] = await Promise.all([
    store.listPaths(branchId, [""], { revision: 0, ...(options?.signal ? { signal: options.signal } : {}) }),
    store.listPaths(branchId, [""], options?.signal ? { signal: options.signal } : {}),
    store.listPaths(parentBranchId, [""], { revision: parentRevision, ...(options?.signal ? { signal: options.signal } : {}) }),
  ]);
  if (!oldBaseRead || !headRead) throw new Error(`Working branch is unavailable: ${branchId}`);
  if (!newBaseRead) throw new Error(`Parent revision view is unavailable: ${parentBranchId}@${parentRevision}`);
  if (result.root && newBaseRead.root !== result.root) {
    throw new Error(`Parent revision ${parentBranchId}@${parentRevision} changed identity while rebasing`);
  }
  if (headRead.branch.writeRevision !== branch.writeRevision) {
    return { status: "conflict", writeRevision: headRead.branch.writeRevision, updatedFromParent: [], keptChildPaths: [], mergedPaths: [], conflicts: [] };
  }

  const stateOf = (entries: { path: string; state: RecoveryState }[]): Record<string, RecoveryState> =>
    Object.fromEntries(entries.map((entry) => [entry.path, entry.state]));
  const oldBase = stateOf(oldBaseRead.entries);
  const head = stateOf(headRead.entries);
  const newBase = stateOf(newBaseRead.entries);

  const paths = [...new Set([...Object.keys(oldBase), ...Object.keys(head), ...Object.keys(newBase)])].sort();
  const changes: Record<string, RecoveryState> = {};
  const updatedFromParent: string[] = [];
  const keptChildPaths: string[] = [];
  const mergedPaths: string[] = [];
  const conflicts: { path: string; reason?: string }[] = [];

  for (const file of paths) {
    options?.signal?.throwIfAborted();
    const base = oldBase[file] ?? missing();
    const parent = newBase[file] ?? missing();
    const child = head[file] ?? missing();
    const plan = await planThreeWayPath({
      path: file,
      baseState: base,
      parentState: parent,
      childState: child,
      readContent: async (state) => state.kind === "regular-file" ? store.getObject(state.objectHash) : null,
    });
    switch (plan.decision) {
      case "identical":
      case "keep-parent":
        updatedFromParent.push(file);
        break;
      case "apply-child":
        changes[file] = child;
        keptChildPaths.push(file);
        break;
      case "merge-clean": {
        const bytes = await store.putObject(Buffer.from(plan.mergedText!, "utf8"));
        changes[file] = {
          kind: "regular-file",
          objectHash: bytes.hash,
          byteLength: bytes.byteLength,
          ...(plan.mergedMode === undefined ? {} : { mode: plan.mergedMode }),
        };
        mergedPaths.push(file);
        break;
      }
      case "conflict":
        changes[file] = child;
        conflicts.push({ path: file, ...(plan.conflictReason ? { reason: plan.conflictReason } : {}) });
        break;
    }
  }

  // Structural closure for directories the child created that the new base lacks.
  for (const file of Object.keys(changes)) {
    if (changes[file]!.kind === "missing") continue;
    let parent = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "";
    while (parent) {
      if (!changes[parent] && !newBase[parent]) changes[parent] = { kind: "directory" };
      parent = parent.includes("/") ? parent.slice(0, parent.lastIndexOf("/")) : "";
    }
  }

  const baseRef = `${parentBranchId}@${parentRevision}`;
  const committed = await store.rebaseBranch(branchId, branch.writeRevision, {
    baseRef: result.root ?? baseRef,
    parentRef: baseRef,
    baseState: newBase,
    changes,
  });
  return {
    status: committed.status,
    writeRevision: committed.writeRevision,
    ...(committed.root ? { root: committed.root } : {}),
    updatedFromParent,
    keptChildPaths,
    mergedPaths,
    conflicts,
  };
}
