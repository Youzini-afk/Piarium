import type { GitStatusEvent } from "./observers.js";
import { projectGitStatusObservation } from "./git-status.js";

export interface GitStatusObserverOptions {
  resolveWorkspaceId(scope: string): Promise<string | null>;
  observe(event: GitStatusEvent): void;
  onError?(error: unknown): void;
}

/** Adapts successful Git status route results to the workspace knowledge sink. */
export function createGitStatusObserver(options: GitStatusObserverOptions) {
  return (scope: string, status: unknown): void => {
    const observation = projectGitStatusObservation(status);
    if (!observation) return;
    void options.resolveWorkspaceId(scope).then((workspaceId) => {
      if (workspaceId) options.observe({ workspaceId, ...observation });
    }).catch((error) => options.onError?.(error));
  };
}
