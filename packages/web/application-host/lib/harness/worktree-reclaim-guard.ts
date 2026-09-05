import type { DocumentAuthority } from "../documents/authority.js";

export interface WorktreeReclaimPermission {
  safe: boolean;
  reason?: string;
  release?: () => Promise<void>;
}

/** Keep controlled writers fenced until the caller finishes removing the directory. */
export const createWorktreeReclaimGuard = (documents: DocumentAuthority) => async (
  _workspaceId: string,
  _threadId: string,
  directory: string,
): Promise<WorktreeReclaimPermission> => {
  const { workspaceId } = await documents.resolveWorkspace({ path: directory });
  const state = await documents.inspectMutation(workspaceId);
  if (state.maintenance || state.activeWriters.length > 0) {
    return { safe: false, reason: state.maintenance ? "Worktree maintenance is active" : "Worktree has active writers" };
  }
  // The epoch check and writer check happen in the same authority transaction.
  await documents.mutationAuthority.advanceEpoch(workspaceId, { expectedEpoch: state.epoch, maintenance: true });
  let barrier: Awaited<ReturnType<DocumentAuthority["beginDirtyStateBarrier"]>> | undefined;
  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    try { await barrier?.release(); }
    finally { await documents.mutationAuthority.setMaintenance(workspaceId, false); }
  };
  try {
    barrier = await documents.beginDirtyStateBarrier(workspaceId, ["."]);
    const surfaces = await documents.inspectDirtyBuffers(workspaceId);
    // A visible worktree is in use even when its editor buffers are clean.
    if (surfaces.length > 0) {
      await release();
      return { safe: false, reason: "Worktree is in use by an editor surface" };
    }
    await barrier.settle();
    return { safe: true, release };
  } catch (error) {
    await release();
    throw error;
  }
};
