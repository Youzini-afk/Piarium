export type ThreadExecutionViewMode = "virtual" | "materialized";

export interface ThreadExecutionView {
  sessionId: string;
  workspaceId: string;
  threadId: string;
  runId: string;
  branchId: string;
  revision: number;
  mode: ThreadExecutionViewMode;
  draftBasePaths: readonly string[];
}

export class ThreadExecutionViewRegistry {
  readonly #bySession = new Map<string, ThreadExecutionView>();

  bind(view: ThreadExecutionView): void {
    this.#bySession.set(view.sessionId, { ...view, draftBasePaths: [...view.draftBasePaths] });
  }

  get(sessionId: string): ThreadExecutionView | undefined {
    const view = this.#bySession.get(sessionId);
    return view ? { ...view, draftBasePaths: [...view.draftBasePaths] } : undefined;
  }

  unbind(sessionId: string): void {
    this.#bySession.delete(sessionId);
  }
}
