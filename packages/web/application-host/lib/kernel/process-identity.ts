import path from "node:path";
import type { DocumentAuthority } from "../documents/authority.js";
import type { ThreadRegistry } from "../harness/thread-registry.js";
import { canonicalizePathIdentity, isPathWithinRoot, normalizePathIdentity } from "../workspace/path-safety.js";
import type { KernelFileRootResolver } from "./storage-adapter.js";
import type { NativeProcessIdentity } from "./process-service.js";

/** Product admission, shared by actual Host assembly and native consumer tests.
 * A retained Thread is an explicit authority; an application-data prefix is not. */
export function createKernelProcessIdentityResolver(options: {
  documents: Pick<DocumentAuthority, "resolveScopeId" | "resolveWorkspace" | "inspectWorkspace">;
  registry: Pick<ThreadRegistry, "listWorkspaceIds" | "listWorkspaceThreads">;
  admitManaged: KernelFileRootResolver;
}): (cwd: string) => Promise<NativeProcessIdentity> {
  return async (cwd) => {
    if (!path.isAbsolute(cwd)) throw new Error("Native process cwd must be absolute");
    const requested = normalizePathIdentity(cwd);
    let retained: { workspaceId: string; directory: string } | undefined;
    // Keep owning and execution identities separate. This lookup also runs
    // before Documents has enrolled a newly materialized application-data view.
    for (const workspaceId of await options.registry.listWorkspaceIds()) {
      for (const thread of await options.registry.listWorkspaceThreads(workspaceId)) {
        const directory = thread.worktree?.path;
        if (!directory || !isPathWithinRoot(requested, directory)) continue;
        if (!retained || normalizePathIdentity(directory).length > normalizePathIdentity(retained.directory).length) {
          retained = { workspaceId, directory };
        }
      }
    }
    const executionWorkspaceId = await options.documents.resolveScopeId(cwd);
    const canonicalCwd = await canonicalizePathIdentity(cwd);
    if (retained) {
      // Revalidate both the retained worktree and the exact requested cwd. A
      // symlink under the Thread cannot authorize a different sibling tree.
      const admitted = await options.admitManaged(retained.directory, retained.workspaceId);
      const canonicalThread = await canonicalizePathIdentity(retained.directory);
      if (!isPathWithinRoot(canonicalCwd, canonicalThread)) throw new Error("Process cwd escaped its retained Thread");
      if (!executionWorkspaceId) {
        return { workspaceId: retained.workspaceId, executionWorkspaceId: admitted.workspaceId, canonicalRoot: admitted.canonicalRoot };
      }
    }
    if (!executionWorkspaceId) throw new Error("Process cwd has no admitted Documents workspace or retained Thread");
    const execution = await options.documents.inspectWorkspace(executionWorkspaceId);
    // Cached Documents registration does not replace current root admission.
    // Resolve the existing root, not cwd, to avoid inventing a nested identity.
    await options.documents.resolveWorkspace({ path: execution.root });
    if (!isPathWithinRoot(canonicalCwd, execution.root)) throw new Error("Process cwd escaped its Documents workspace");
    return { workspaceId: retained?.workspaceId ?? executionWorkspaceId, executionWorkspaceId, canonicalRoot: execution.root };
  };
}
