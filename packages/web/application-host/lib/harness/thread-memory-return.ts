import type {
  ThreadParent,
  ThreadReport,
  ThreadRun,
} from "@piarium/protocol";

export interface ThreadMemoryReturnMaterial {
  id: string;
  kind: "thread-return";
  text: string;
}

export interface ThreadMemoryReturnRegistry {
  getThreadSnapshot(workspaceId: string, threadId: string): Promise<{
    thread: { id: string; lifecycle: string };
    activeRun: { id: string; workerState: string; sessionId: string | null } | null;
  } | null>;
  getSessionBinding(sessionId: string): Promise<{
    owningWorkspaceId: string;
    threadId: string;
    runId: string;
  } | null>;
}

export interface ThreadMemoryReturnAdapterOptions {
  registry: ThreadMemoryReturnRegistry;
  hasLiveSession(sessionId: string): boolean;
  rootSessionWorkspaceId(sessionId: string): string | null;
  nudgeMemory(sessionId: string, material: ThreadMemoryReturnMaterial): Promise<void>;
}

/**
 * Build the one production adapter from a durable child Run return to its
 * owning parent Pi session. Registry facts are resolved at callback time so a
 * closed, retired, or replaced parent cannot be revived by an old callback.
 */
export function createThreadMemoryReturnAdapter(options: ThreadMemoryReturnAdapterOptions) {
  return async (
    workspaceId: string,
    parent: ThreadParent,
    threadId: string,
    run: ThreadRun,
    report: ThreadReport,
  ): Promise<void> => {
    if (run.outcome !== "success" && run.outcome !== "failure" && run.outcome !== "cancelled") return;

    let parentSessionId: string;
    if (parent.kind === "session") {
      parentSessionId = parent.id;
      if (!options.hasLiveSession(parentSessionId)
        || options.rootSessionWorkspaceId(parentSessionId) !== workspaceId) return;
    } else {
      const parentSnapshot = await options.registry.getThreadSnapshot(workspaceId, parent.id);
      const parentThread = parentSnapshot?.thread;
      const parentRun = parentSnapshot?.activeRun;
      if (
        !parentThread
        || parentThread.lifecycle !== "active"
        || !parentRun
        || parentRun.workerState !== "running"
        || parentRun.sessionId === null
      ) return;
      parentSessionId = parentRun.sessionId;
      const binding = await options.registry.getSessionBinding(parentSessionId).catch(() => null);
      if (
        !binding
        || binding.owningWorkspaceId !== workspaceId
        || binding.threadId !== parent.id
        || binding.runId !== parentRun.id
        || !options.hasLiveSession(parentSessionId)
      ) return;
    }

    const changedFiles = report.changedFiles.length > 0 ? report.changedFiles.join(", ") : "(none)";
    const unresolved = report.unresolved.length > 0 ? report.unresolved.join("; ") : "(none)";
    const deviations = report.deviations.length > 0 ? report.deviations.join("; ") : "(none)";
    const revision = report.resultRevision === undefined ? "" : `\nresult revision: ${report.resultRevision}`;
    const evidenceRun = report.evidenceRunId === undefined ? "" : `\nevidence run: ${report.evidenceRunId}`;
    await options.nudgeMemory(parentSessionId, {
      id: `thread-return:${workspaceId}:${threadId}:${run.id}`,
      kind: "thread-return",
      text: [
        `Child thread ${threadId} Run ${run.id} returned a persisted ${run.outcome} report.`,
        `Conclusion: ${report.conclusion}`,
        `Changed files: ${changedFiles}`,
        `Deviations from brief: ${deviations}`,
        `Unresolved: ${unresolved}`,
        `Confidence: ${report.confidence}${revision}${evidenceRun}`,
      ].join("\n"),
    });
  };
}
