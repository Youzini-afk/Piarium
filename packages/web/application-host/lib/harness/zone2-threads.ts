import type {
  Thread,
  ThreadParent,
  ThreadRun,
} from "@piarium/protocol";
import type { ObservationCursorEntry, ObservationCursorStore, PendingObservation } from "./observation-cursors.js";
import type { ThreadRegistry } from "./thread-registry.js";
import type { Zone2Thread, Zone2Threads } from "./zone2.js";

interface Zone2ThreadCursor {
  eventSeqByThread: Record<string, number>;
}

export interface Zone2ThreadProjectionOptions {
  cursors: ObservationCursorStore;
  registry: ThreadRegistry;
}

const priority = (thread: Thread): number => {
  if (thread.attention === "user" || thread.attention === "permission") return 0;
  if (thread.attention === "stalled" || thread.attention === "looping") return 1;
  if (thread.lifecycle === "active" || thread.lifecycle === "queued") return 2;
  if (thread.integration === "conflict") return 3;
  return 4;
};

const projectThread = (thread: Thread, activeRun: ThreadRun | null): Zone2Thread => ({
  id: thread.id,
  brief: thread.brief,
  role: thread.role,
  lifecycle: thread.lifecycle,
  attention: thread.attention,
  integration: thread.integration,
  waitingFor: thread.waitingFor?.text ?? null,
  steps: activeRun?.steps ?? 0,
  workerState: activeRun?.workerState ?? null,
  outcome: activeRun?.outcome ?? null,
  lastActivityAt: activeRun?.lastActivityAt ?? thread.updatedAt,
  lastToolCall: activeRun?.lastToolCall?.name ?? null,
  diffStats: thread.diffStats,
  conclusion: thread.report?.conclusion ?? null,
  deviations: [...(thread.report?.deviations ?? [])],
});

/**
 * Builds the per-turn thread snapshot for one session. Active work is always
 * present; terminal work appears only when its event sequence changed for this
 * observer. The cursor is separate from the explicit `threads` tool cursor.
 */
const zone2ThreadTask = (
  options: Zone2ThreadProjectionOptions,
  input: { workspaceId: string },
  parent: ThreadParent,
) => async (previous: ObservationCursorEntry<Zone2ThreadCursor> | null): Promise<{ cursor: Zone2ThreadCursor; result: Zone2Threads }> => {
  const snapshots = await options.registry.listThreadSnapshots(input.workspaceId, parent);
  const eventSeqByThread = Object.fromEntries(snapshots.map(({ thread }) => [thread.id, thread.eventSeq]));
  const selected = snapshots
    .filter(({ thread }) => (
      thread.lifecycle === "active"
      || thread.lifecycle === "queued"
      || previous?.value.eventSeqByThread[thread.id] !== thread.eventSeq
    ))
    .toSorted((left, right) => (
      priority(left.thread) - priority(right.thread)
      || right.thread.updatedAt.localeCompare(left.thread.updatedAt)
      || left.thread.id.localeCompare(right.thread.id)
    ));
  return {
    cursor: { eventSeqByThread },
    result: { status: "ready", items: selected.map(({ thread, activeRun }) => projectThread(thread, activeRun)) },
  };
};

const zone2Scope = async (
  options: Zone2ThreadProjectionOptions,
  input: { sessionId: string; workspaceId: string },
): Promise<{ objectId: string; parent: ThreadParent }> => {
  const owner = await options.registry.getThreadForSession(input.workspaceId, input.sessionId);
  const parent: ThreadParent = owner
    ? { kind: "thread", id: owner.id }
    : { kind: "session", id: input.sessionId };
  return { objectId: `${input.workspaceId}\0${parent.kind}\0${parent.id}`, parent };
};

export async function projectZone2Threads(
  options: Zone2ThreadProjectionOptions,
  input: { sessionId: string; workspaceId: string },
): Promise<Zone2Threads> {
  const scope = await zone2Scope(options, input);
  return options.cursors.observe<Zone2ThreadCursor, Zone2Threads>(
    input.sessionId,
    "zone2-threads",
    scope.objectId,
    zone2ThreadTask(options, input, scope.parent),
  );
}

export async function prepareZone2Threads(
  options: Zone2ThreadProjectionOptions,
  input: { sessionId: string; workspaceId: string },
): Promise<PendingObservation<Zone2Threads>> {
  const scope = await zone2Scope(options, input);
  return options.cursors.prepare(
    input.sessionId,
    "zone2-threads",
    scope.objectId,
    zone2ThreadTask(options, input, scope.parent),
  );
}
