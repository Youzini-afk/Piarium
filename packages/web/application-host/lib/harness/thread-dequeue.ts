import type { Thread, ThreadParent } from "@piarium/protocol";
import type { ThreadRegistry, ThreadRegistryOptions } from "./thread-registry.js";
import type { ThreadRuntime } from "./thread-runtime.js";

export const createOnThreadDequeued = (options: {
  getRegistry: () => ThreadRegistry;
  getRuntime: () => ThreadRuntime | null | undefined;
  formatError?: (error: unknown) => string;
  onEndRunFailure?: (spawnError: unknown, endError: unknown) => void;
}): NonNullable<ThreadRegistryOptions["onThreadDequeued"]> => {
  const formatError = options.formatError ?? ((error: unknown) => (
    error instanceof Error ? error.message : String(error)
  ));
  return async (workspaceId: string, parent: ThreadParent, thread: Thread): Promise<void> => {
    const runtime = options.getRuntime();
    if (!runtime) throw new Error("Thread runtime is not ready");
    const registry = options.getRegistry();
    const run = await registry.startRun(workspaceId, thread.id);
    void runtime.spawn({
      workspaceId,
      parent,
      threadId: thread.id,
      runId: run.id,
      brief: thread.brief,
      ...(thread.role ? { role: thread.role } : {}),
      kind: thread.kind,
      createdBy: thread.createdBy,
      carryBlocks: thread.manifest.carryBlocks,
      concurrency: thread.manifest.concurrency,
      ...(thread.manifest.draftBaselineId ? { draftBaselineId: thread.manifest.draftBaselineId } : {}),
      autoRun: true,
      worktree: thread.manifest.worktree,
      ...(thread.model ? { model: thread.model } : {}),
      tools: [...thread.manifest.tools],
      permissions: thread.manifest.permissions,
      ...(thread.manifest.scope.length > 0 ? { scope: [...thread.manifest.scope] } : {}),
      ...(thread.manifest.systemPromptFragment
        ? { systemPromptFragment: thread.manifest.systemPromptFragment }
        : {}),
    }).catch(async (error: unknown) => {
      try {
        await registry.endRun(workspaceId, thread.id, run.id, "failure", formatError(error));
      } catch (endError) {
        options.onEndRunFailure?.(error, endError);
      }
    });
  };
};
