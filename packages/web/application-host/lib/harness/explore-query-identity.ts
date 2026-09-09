import type { HarnessActorContext, HarnessActorIdentity } from "@piarium/protocol";

/** Actor fields a short-lived explore query is allowed to continue under. */
export interface ExploreQueryActor {
  authorityInstanceId: string;
  sessionId: string;
  workerId: string;
  workerGeneration: number;
  runId?: string;
  workspaceId: string | null;
  workspaceScope?: readonly string[];
}

export function actorFromHarness(actor: HarnessActorContext): ExploreQueryActor {
  return {
    authorityInstanceId: actor.authorityInstanceId,
    sessionId: actor.sessionId,
    workerId: actor.workerId,
    workerGeneration: actor.workerGeneration,
    workspaceId: actor.workspaceId,
    ...(actor.runId ? { runId: actor.runId } : {}),
    ...(actor.workspaceScope ? { workspaceScope: [...actor.workspaceScope] } : {}),
  };
}

export function exploreQueryActorsMatch(stored: ExploreQueryActor, current: ExploreQueryActor | HarnessActorIdentity & { workspaceId?: string | null }): boolean {
  if (stored.authorityInstanceId !== current.authorityInstanceId) return false;
  if (stored.sessionId !== current.sessionId) return false;
  if (stored.workerId !== current.workerId) return false;
  if (stored.workerGeneration !== current.workerGeneration) return false;
  if ((stored.runId ?? "") !== (current.runId ?? "")) return false;
  if ("workspaceId" in current && current.workspaceId !== undefined && stored.workspaceId !== current.workspaceId) {
    return false;
  }
  const left = stored.workspaceScope ?? [];
  const right = current.workspaceScope ?? [];
  if (left.length !== right.length) return false;
  return left.every((path, index) => path === right[index]);
}
