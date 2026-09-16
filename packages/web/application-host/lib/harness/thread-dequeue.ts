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
    // A parked continuation promotes through the same admission gate as a
    // queued Thread: the request already passed admission in tryDequeue.
    if (thread.pendingContinuation) {
      const continuation = thread.pendingContinuation;
      await registry.setPendingContinuation(workspaceId, thread.id, null);
      await runtime.continueRun({
        workspaceId,
        parent,
        threadId: thread.id,
        mode: continuation.mode,
        task: continuation.task,
        ...(continuation.requestId !== undefined ? { requestId: continuation.requestId } : {}),
        admitted: true,
      }).then(({ runId }) => (
        continuation.requestId !== undefined && runId !== undefined
          ? registry.patchThreadMessage(workspaceId, thread.id, continuation.requestId, { status: "delivered", runId })
          : undefined
      ));
      return;
    }
    const run = await registry.startRun(workspaceId, thread.id);
    void runtime.spawn({
      workspaceId,
      parent,
      threadId: thread.id,
      runId: run.id,
      brief: thread.brief,
      ...(thread.preset ? { preset: thread.preset } : {}),
      kind: thread.kind,
      createdBy: thread.createdBy,
      carryBlocks: thread.manifest.carryBlocks,
      concurrency: thread.manifest.concurrency,
      ...(thread.manifest.draftBaselineId ? { draftBaselineId: thread.manifest.draftBaselineId } : {}),
      ...(thread.manifest.inputOrigin !== undefined ? { inputOrigin: thread.manifest.inputOrigin } : {}),
      ...(thread.manifest.inheritedContext ? { inheritedContext: thread.manifest.inheritedContext } : {}),
      autoRun: true,
      worktree: thread.manifest.worktree,
      ...(thread.model ? { model: thread.model } : {}),
      tools: [...thread.manifest.tools],
      permissions: thread.manifest.permissions,
      ...(thread.manifest.scope.length > 0 ? { scope: [...thread.manifest.scope] } : {}),
      ...(thread.manifest.systemPromptFragment
        ? { systemPromptFragment: thread.manifest.systemPromptFragment }
        : {}),
      ...(thread.manifest.promptText ? { promptText: thread.manifest.promptText } : {}),
    }).catch(async (error: unknown) => {
      try {
        await registry.endRun(workspaceId, thread.id, run.id, "failure", formatError(error));
      } catch (endError) {
        options.onEndRunFailure?.(error, endError);
      }
    });
  };
};
