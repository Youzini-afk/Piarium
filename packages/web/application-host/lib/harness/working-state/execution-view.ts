export type ThreadExecutionViewMode = "virtual" | "materialized";

export interface ThreadExecutionView {
  sessionId: string;
  workspaceId: string;
  threadId: string;
  runId: string;
  branchId: string;
  revision: number;
  writeRevision: number;
  mode: ThreadExecutionViewMode;
  draftBasePaths: readonly string[];
}

export class ThreadExecutionViewRegistry {
  readonly #bySession = new Map<string, ThreadExecutionView>();

  bind(view: ThreadExecutionView): void {
    this.#bySession.set(view.sessionId, {
      ...view,
      writeRevision: view.writeRevision,
      draftBasePaths: [...view.draftBasePaths],
    });
  }

  get(sessionId: string): ThreadExecutionView | undefined {
    const view = this.#bySession.get(sessionId);
    return view ? { ...view, writeRevision: view.writeRevision, draftBasePaths: [...view.draftBasePaths] } : undefined;
  }

  unbind(sessionId: string): void {
    this.#bySession.delete(sessionId);
  }
}
