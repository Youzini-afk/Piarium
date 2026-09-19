/**
 * Four-column team status projection (7E/D-300): thread / task / state /
 * progress. Progress is a deterministic excerpt of the thread's last
 * completed visible output — never hidden reasoning, never a summary model.
 * Every excerpt names its source (Thread/Run/entry/time) so read_thread can
 * expand the original passage even after the thread keeps writing.
 *
 * Consumers: the `threads` tool default view and the per-request Zone 2
 * status injection. Observers keep independent cursors; a cursor commits
 * only after the rows were actually delivered.
 */

import type {
  PiSessionEntry,
  SessionEntriesResult,
  Thread,
  ThreadMessagePeer,
  ThreadParent,
  ThreadRun,
} from "@piarium/protocol";
import type { ObservationCursorStore, PendingObservation } from "./observation-cursors.js";
import type { ThreadRegistry } from "./thread-registry.js";

/** ~20 visible characters is a preview budget, not a content limit. */
const PROGRESS_VISIBLE_CHARS = 20;

export interface ThreadStatusProgress {
  /** Whitespace-collapsed excerpt, ≤ PROGRESS_VISIBLE_CHARS plus an ellipsis. */
  text: string;
  /** The Run this output belongs to — an older Run is marked, not disguised. */
  runId: string;
  /** Session entry holding the original passage. */
  entryId: string;
  at: string;
  /** True when the current Run produced no visible output yet. */
  fromEarlierRun: boolean;
}

export interface ThreadStatusMarker {
  kind: "message" | "result";
  text: string;
  id?: string;
  at: string;
}

export interface ThreadStatusRow {
  threadId: string;
  preset: string | null;
  /** The thread's own brief, whitespace-collapsed. */
  task: string;
  state: string;
  progress: ThreadStatusProgress | null;
  /** Source-marked arrivals merged into the progress column. */
  markers: ThreadStatusMarker[];
}

export interface ThreadStatusCursor {
  /** threadId → rendered cell content that was actually presented. */
  cells: Record<string, string>;
  /** threadId → inbound message ids already surfaced as markers. */
  inboundSeen: Record<string, string[]>;
  /** threadId → result revision already surfaced as a marker. */
  resultSeen: Record<string, number>;
}

const collapse = (text: string): string => text.replace(/\s+/g, " ").trim();

const excerptText = (text: string): string => {
  const collapsed = collapse(text);
  const chars = [...collapsed];
  return chars.length <= PROGRESS_VISIBLE_CHARS ? collapsed : `${chars.slice(0, PROGRESS_VISIBLE_CHARS).join("")}…`;
};

/**
 * The last completed assistant text of a session branch. Streaming parts land
 * in the session file only once committed, so this never reads a half-written
 * message and never wakes the observed agent.
 */
export const lastVisibleOutput = (entries: readonly PiSessionEntry[]): { text: string; entryId: string; at: string } | null => {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    if (entry.message.stopReason === "pending") continue;
    const text = collapse(
      entry.message.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join(" "),
    );
    if (text) return { text: excerptText(text), entryId: entry.id, at: entry.timestamp };
  }
  return null;
};

export const statusPeerLabel = (peer: ThreadMessagePeer): string => (
  peer.kind === "thread" ? `thread ${peer.id}`
    : peer.kind === "session" ? `session ${peer.id}`
      : `user ${peer.id}`
);

export const threadStatusState = (thread: Thread, activeRun: ThreadRun | null): string => {
  if (thread.lifecycle === "archived") return "archived";
  if (thread.integration === "merged") return "merged";
  if (thread.integration === "conflict") return "conflict";
  if (thread.lifecycle === "queued") return "queued";
  if (thread.attention === "user" || thread.attention === "permission" || thread.attention === "thread" || thread.attention === "experiment") return "waiting";
  if (thread.attention === "stalled" || thread.attention === "looping") return thread.attention;
  if (thread.lifecycle === "settled") return activeRun?.outcome ?? "settled";
  if (activeRun?.workerState === "lost") return "lost";
  if (activeRun?.workerState === "starting" || activeRun?.workerState === "running") return "working";
  return "idle";
};

export interface ThreadStatusProjectorOptions {
  /** Resolved per build — the registry is not fixed at projector creation. */
  registry: () => ThreadRegistry | null;
  /** Read-only session entries access; never wakes the observed agent. */
  readEntries: ((sessionId: string) => Promise<SessionEntriesResult>) | null;
}

/**
 * Rebuildable projection over real Thread/Run/session facts. The excerpt
 * cache keys on the session's committed leaf so unchanged sessions cost no
 * re-read and a new completed output produces a fresh excerpt.
 */
export function createThreadStatusProjector(options: ThreadStatusProjectorOptions) {
  const excerptCache = new Map<string, { stamp: string; excerpt: { text: string; entryId: string; at: string } | null }>();

  const excerptFor = async (run: ThreadRun | null): Promise<{ text: string; entryId: string; at: string } | null> => {
    if (!run?.sessionId || !options.readEntries) return null;
    // lastActivityAt is the registry-maintained commit signal: unchanged runs
    // reuse the cached excerpt, new committed output invalidates it.
    const stamp = run.lastActivityAt;
    const cached = excerptCache.get(run.sessionId);
    if (cached?.stamp === stamp) return cached.excerpt;
    let excerpt: { text: string; entryId: string; at: string } | null = null;
    try {
      excerpt = lastVisibleOutput((await options.readEntries(run.sessionId)).entries);
    } catch {
      excerpt = null;
    }
    excerptCache.set(run.sessionId, { stamp, excerpt });
    return excerpt;
  };

  const progressFor = async (
    thread: Thread,
    activeRun: ThreadRun | null,
    runs: readonly ThreadRun[],
  ): Promise<ThreadStatusProgress | null> => {
    const candidate = activeRun ?? runs.findLast((run) => run.sessionId) ?? null;
    const excerpt = await excerptFor(candidate);
    if (excerpt && candidate) {
      return {
        ...excerpt,
        runId: candidate.id,
        fromEarlierRun: activeRun !== null && candidate.id !== activeRun.id,
      };
    }
    // No visible output on this Run — a settled Thread's report conclusion is
    // the recorded final answer, marked with its own revision/time.
    const report = thread.report;
    if (report?.conclusion) {
      return {
        text: excerptText(report.conclusion),
        runId: candidate?.id ?? "",
        entryId: `report-r${report.resultRevision ?? 0}`,
        at: thread.updatedAt,
        fromEarlierRun: activeRun !== null,
      };
    }
    return null;
  };

  const markersFor = (thread: Thread, seenInbound: readonly string[], seenResult: number | undefined): ThreadStatusMarker[] => {
    const seen = new Set(seenInbound);
    const markers: ThreadStatusMarker[] = [];
    for (const message of thread.messages ?? []) {
      if (message.direction !== "in" || seen.has(message.id)) continue;
      if (message.status !== "delivered" && message.status !== "resolved") continue;
      markers.push({
        kind: "message",
        id: message.id,
        at: message.at,
        text: `message ${message.id} from ${statusPeerLabel(message.from)}: "${excerptText(message.text)}"`,
      });
    }
    if (thread.resultRevision !== undefined && thread.resultRevision !== seenResult) {
      markers.push({ kind: "result", at: thread.updatedAt, text: `result r${thread.resultRevision}` });
    }
    return markers;
  };

  const renderCell = (progress: ThreadStatusProgress | null, markers: readonly ThreadStatusMarker[]): string => {
    // Every excerpt carries its locate reference: read_thread entry expands
    // the original passage even after the thread keeps writing.
    const base = progress
      ? `${progress.text} [${progress.runId}:${progress.entryId}]${progress.fromEarlierRun ? ` (earlier run · ${progress.at})` : ""}`
      : "—";
    const suffix = markers.map((marker) => marker.text).join(" · ");
    return suffix ? `${base} · ${suffix}` : base;
  };

  return {
    /**
     * Full table: every in-scope row. `cursor` supplies the inbound-message
     * baseline so markers reflect what this observer has not yet seen.
     */
    async build(
      workspaceId: string,
      parent: ThreadParent,
      cursor: ThreadStatusCursor | null,
    ): Promise<{ rows: ThreadStatusRow[]; cursor: ThreadStatusCursor; removed: string[] }> {
      const registry = options.registry();
      if (!registry) throw new Error("Thread registry not configured");
      const snapshots = await registry.listThreadSnapshots(workspaceId, parent);
      const next: ThreadStatusCursor = { cells: {}, inboundSeen: {}, resultSeen: {} };
      const rows: ThreadStatusRow[] = [];
      for (const { thread, activeRun } of snapshots) {
        const runs = await registry.listRuns(workspaceId, thread.id);
        const seenInbound = cursor?.inboundSeen[thread.id] ?? [];
        const seenResult = cursor?.resultSeen[thread.id];
        const progress = await progressFor(thread, activeRun, runs);
        const markers = markersFor(thread, seenInbound, seenResult);
        const row: ThreadStatusRow = {
          threadId: thread.id,
          preset: thread.preset,
          task: collapse(thread.brief),
          state: threadStatusState(thread, activeRun),
          progress,
          markers,
        };
        rows.push(row);
        // The cursor records the marker-free baseline: an inbound/result
        // marker is transient and its disappearance is not a change.
        next.cells[thread.id] = `${row.state}|${renderCell(progress, [])}`;
        next.inboundSeen[thread.id] = (thread.messages ?? [])
          .filter((message) => message.direction === "in" && (message.status === "delivered" || message.status === "resolved"))
          .map((message) => message.id);
        if (thread.resultRevision !== undefined) next.resultSeen[thread.id] = thread.resultRevision;
      }
      const removed = Object.keys(cursor?.cells ?? {}).filter((id) => next.cells[id] === undefined);
      return { rows, cursor: next, removed };
    },

    /** One row of the four-column table: thread · task · state · progress. */
    formatRow(row: ThreadStatusRow): string {
      return `${row.threadId}${row.preset ? ` [${row.preset}]` : ""} · ${row.task} · ${row.state} · ${renderCell(row.progress, row.markers)}`;
    },
  };
}

export type ThreadStatusProjector = ReturnType<typeof createThreadStatusProjector>;

export const THREAD_STATUS_OBJECT_KIND = "thread-status" as const;

/**
 * Per-request status delivery bookkeeping. `prepare` leaves the cursor
 * uncommitted; `confirm` advances it only after the request that carried the
 * rows was actually dispatched. A pending prepare is superseded by the next
 * one — a failed request never claims delivery.
 */
export function createThreadStatusDelivery(cursors: ObservationCursorStore) {
  const pending = new Map<string, PendingObservation<unknown>>();
  return {
    setPending(observerSessionId: string, observation: PendingObservation<unknown>): void {
      pending.get(observerSessionId)?.abort();
      pending.set(observerSessionId, observation);
    },
    confirm(observerSessionId: string, observationRef: string): boolean {
      const current = pending.get(observerSessionId);
      if (!current || current.observationRef !== observationRef) return false;
      pending.delete(observerSessionId);
      return current.commit();
    },
    drop(observerSessionId: string): void {
      pending.get(observerSessionId)?.abort();
      pending.delete(observerSessionId);
    },
  };
}
