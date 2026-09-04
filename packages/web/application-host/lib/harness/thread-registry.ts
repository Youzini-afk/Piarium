/**
 * Thread registry — host-persisted thread records for sub-agent threads.
 *
 * Design: agent-harness.md §9.3, agent-harness-plan.md §3.4
 *
 * The thread registry is the single source of truth for thread state.
 * It persists to `PIARIUM_DATA_DIR/threads/<hostId>/<parentSessionId>.json`
 * and emits protocol events on state changes.
 *
 * Thread lifecycle:
 *   queued → running → idle → waiting-for-input → done → merged → archived
 *                  ↘ failed      ↘ cancelled
 *   worker-lost flag set when worker exits unexpectedly; resumeThread
 *   restarts in the same session/worktree with the same thread id.
 */

import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  ThreadViewCursor,
  ThreadStatus as ProtocolThreadStatus,
  ThreadKind as ProtocolThreadKind,
  ThreadCreatedBy as ProtocolThreadCreatedBy,
  ThreadReport as ProtocolThreadReport,
  ThreadFlags as ProtocolThreadFlags,
  ThreadWaitingFor as ProtocolThreadWaitingFor,
  ThreadWorktree as ProtocolThreadWorktree,
  ThreadTokens as ProtocolThreadTokens,
  ThreadDiffStats as ProtocolThreadDiffStats,
} from "@piarium/protocol";

// ── Types (re-exported from protocol) ──────────────────────────────

export type ThreadStatus = ProtocolThreadStatus;
export type ThreadKind = ProtocolThreadKind;
export type ThreadCreatedBy = ProtocolThreadCreatedBy;
export type ThreadReport = ProtocolThreadReport;
export type ThreadFlags = ProtocolThreadFlags;
export type ThreadWaitingFor = ProtocolThreadWaitingFor;
export type ThreadWorktree = ProtocolThreadWorktree;
export type ThreadTokens = ProtocolThreadTokens;
export type ThreadDiffStats = ProtocolThreadDiffStats;

export interface ThreadRecord {
  id: string;
  parentSessionId: string;
  sessionId: string;
  forkPoint: { entryId: string } | null;
  brief: string;
  role: string | null;
  createdBy: ThreadCreatedBy;
  kind: ThreadKind;
  worktree: ThreadWorktree | null;
  status: ThreadStatus;
  flags: ThreadFlags;
  waitingFor: ThreadWaitingFor | null;
  lastActivityAt: string;
  steps: number;
  tokens: ThreadTokens;
  costUsd: number | null;
  lastToolCall: { name: string; at: string } | null;
  diffStats: ThreadDiffStats | null;
  report: ThreadReport | null;
  exitReason: string | null;
  createdAt: string;
  updatedAt: string;
  /** Monotonically increasing event sequence (incremented on every state change) */
  eventSeq: number;
  /** Whether this thread is hidden from the parent agent's list view */
  hidden: boolean;
}

export interface CreateThreadInput {
  parentSessionId: string;
  brief: string;
  role?: string;
  kind: ThreadKind;
  createdBy: ThreadCreatedBy;
  forkPoint?: { entryId: string };
  carryBlocks?: boolean;
  scope?: string[];
  worktree: "none" | "shared" | "isolated";
  model?: { providerId: string; modelId: string };
  tools: string[];
  permissions: unknown;
  systemPromptFragment?: string;
  autoRun: boolean;
  hidden?: boolean;
}

// ── Persistence ────────────────────────────────────────────────────

export interface ThreadRegistryOptions {
  dataDir: string;
  hostId: string;
  /** Called when a thread record changes (for protocol event emission) */
  onThreadChanged?: (parentSessionId: string, thread: ThreadRecord) => void;
  /** Called when a thread completes with a report */
  onThreadDone?: (parentSessionId: string, threadId: string, report: ThreadReport) => void;
  /** Called when a thread is dequeued (promoted from queued to runnable).
   * The host should spawn the child session and call setSessionId. */
  onThreadDequeued?: (parentSessionId: string, thread: ThreadRecord) => Promise<void>;
  /** Max concurrent running threads per parent (default 12) */
  maxConcurrency?: number;
}

function threadFilePath(dataDir: string, hostId: string, parentSessionId: string): string {
  return join(dataDir, "threads", hostId, `${parentSessionId}.json`);
}

function nowISO(): string {
  return new Date().toISOString();
}

function makeFlags(): ThreadFlags {
  return { workerLost: false, stalled: false, looping: false };
}

function makeTokens(): ThreadTokens {
  return { input: 0, output: 0, cacheRead: 0 };
}

// ── State transition table (§9.3 lifecycle) ────────────────────────
//
// Valid transitions: from → { allowed next states }
const STATE_TRANSITIONS: Record<ThreadStatus, ThreadStatus[]> = {
  "queued": ["running", "cancelled"],
  "running": ["idle", "waiting-for-input", "done", "failed", "cancelled", "queued"],
  "idle": ["running", "cancelled", "archived"],
  "waiting-for-input": ["running", "cancelled", "archived"],
  "done": ["merged", "archived"],
  "failed": ["archived", "running"], // running = resume
  "cancelled": ["archived"],
  "merged": ["archived"],
  "archived": [],
};

function isValidTransition(from: ThreadStatus, to: ThreadStatus): boolean {
  if (from === to) return true; // idempotent
  const allowed = STATE_TRANSITIONS[from];
  return allowed ? allowed.includes(to) : false;
}

/** States that free a concurrency slot. */
const TERMINAL_STATES: ReadonlySet<ThreadStatus> = new Set([
  "done",
  "failed",
  "cancelled",
  "merged",
  "archived",
]);

// ── Registry ───────────────────────────────────────────────────────

export function createThreadRegistry(options: ThreadRegistryOptions) {
  const { dataDir, hostId } = options;
  const maxConcurrency = options.maxConcurrency ?? 12;
  // In-memory cache: parentSessionId → Map<threadId, ThreadRecord>
  const cache = new Map<string, Map<string, ThreadRecord>>();
  // Observer cursors: `${observerSessionId}:${threadId}` → ThreadViewCursor
  const cursors = new Map<string, ThreadViewCursor>();
  // Wait wakeup: parentSessionId → array of resolve callbacks
  const waiters = new Map<string, Array<() => void>>();
  // Serialized write chain per parent
  const persistChains = new Map<string, Promise<void>>();
  let persistCounter = 0;
  // Parents currently being torn down — suppresses dequeue
  const draining = new Set<string>();
  // Global event sequence counter — initialized from persisted records
  let globalEventSeq = 0;

  async function loadParent(parentSessionId: string): Promise<Map<string, ThreadRecord>> {
    const existing = cache.get(parentSessionId);
    if (existing) return existing;
    const map = new Map<string, ThreadRecord>();
    let maxSeq = 0;
    try {
      const raw = await readFile(threadFilePath(dataDir, hostId, parentSessionId), "utf8");
      const records = JSON.parse(raw) as ThreadRecord[];
      for (const r of records) {
        // Backfill hidden field for old records
        if (r.hidden === undefined) r.hidden = false;
        map.set(r.id, r);
        if (r.eventSeq > maxSeq) maxSeq = r.eventSeq;
      }
    } catch {
      // File doesn't exist yet — empty map
    }
    cache.set(parentSessionId, map);
    // Advance globalEventSeq past any persisted sequence
    if (maxSeq >= globalEventSeq) globalEventSeq = maxSeq + 1;
    return map;
  }

  async function writeSnapshot(parentSessionId: string): Promise<void> {
    const map = cache.get(parentSessionId);
    if (!map) return;
    const filePath = threadFilePath(dataDir, hostId, parentSessionId);
    await mkdir(join(filePath, ".."), { recursive: true });
    const records = [...map.values()];
    // Atomic write: temp file + rename to avoid partial writes.
    // The temp name is unique per write so two writes can never race on
    // the same path even if serialization is bypassed.
    persistCounter += 1;
    const tmpPath = `${filePath}.${process.pid}.${persistCounter}.tmp`;
    await writeFile(tmpPath, JSON.stringify(records, null, 2), "utf8");
    await rename(tmpPath, filePath);
  }

  /**
   * Serialize writes per parent: several records can reach a terminal state
   * in the same tick (`cancelAllForParent`), and concurrent temp-file +
   * rename sequences on one path lose writes or fail outright.
   */
  async function persist(parentSessionId: string): Promise<void> {
    const previous = persistChains.get(parentSessionId) ?? Promise.resolve();
    const next = previous.then(() => writeSnapshot(parentSessionId));
    // Keep the chain alive after a failed write; report the failure to the
    // caller that caused it, not to the next one.
    persistChains.set(parentSessionId, next.then(() => undefined, () => undefined));
    return next;
  }

  function emitChange(thread: ThreadRecord): void {
    options.onThreadChanged?.(thread.parentSessionId, thread);
    if (thread.status === "done" && thread.report) {
      options.onThreadDone?.(thread.parentSessionId, thread.id, thread.report);
    }
    // Wake up any waiters for this parent session
    const sessionWaiters = waiters.get(thread.parentSessionId);
    if (sessionWaiters) {
      for (const resolve of sessionWaiters) {
        resolve();
      }
      waiters.set(thread.parentSessionId, []);
    }
  }

  async function createThread(input: CreateThreadInput): Promise<ThreadRecord> {
    const id = `thread-${randomUUID().slice(0, 8)}`;
    const now = nowISO();
    globalEventSeq += 1;
    const map = await loadParent(input.parentSessionId);
    const record: ThreadRecord = {
      id,
      parentSessionId: input.parentSessionId,
      sessionId: "", // Filled by spawnSession
      forkPoint: input.forkPoint ?? null,
      brief: input.brief,
      role: input.role ?? null,
      createdBy: input.createdBy,
      kind: input.kind,
      worktree: null, // Filled when worktree is created
      // "queued" means created but not yet spawned. The caller decides
      // whether a slot is free (countActive) and spawns immediately, or
      // leaves it for maybeDequeue.
      status: input.autoRun ? "queued" : "idle",
      flags: makeFlags(),
      waitingFor: null,
      lastActivityAt: now,
      steps: 0,
      tokens: makeTokens(),
      costUsd: null,
      lastToolCall: null,
      diffStats: null,
      report: null,
      exitReason: null,
      createdAt: now,
      updatedAt: now,
      eventSeq: globalEventSeq,
      hidden: input.hidden ?? false,
    };
    map.set(id, record);
    await persist(input.parentSessionId);
    emitChange(record);
    return record;
  }

  async function getThread(parentSessionId: string, threadId: string): Promise<ThreadRecord | null> {
    const map = await loadParent(parentSessionId);
    return map.get(threadId) ?? null;
  }

  async function listThreads(parentSessionId: string, includeHidden = false): Promise<ThreadRecord[]> {
    const map = await loadParent(parentSessionId);
    return [...map.values()].filter((t) => includeHidden || !t.hidden);
  }

  /**
   * Threads occupying a concurrency slot: everything that has been spawned
   * and has not reached a terminal state. `queued` threads have not been
   * spawned yet, so they do not occupy a slot. Hidden threads count — a
   * review thread is a real child session.
   */
  async function countActive(parentSessionId: string): Promise<number> {
    const map = await loadParent(parentSessionId);
    return [...map.values()].filter(
      (t) => t.status === "running" || t.status === "idle" || t.status === "waiting-for-input",
    ).length;
  }

  async function updateThread(
    parentSessionId: string,
    threadId: string,
    update: Partial<ThreadRecord>,
  ): Promise<ThreadRecord | null> {
    const map = await loadParent(parentSessionId);
    const thread = map.get(threadId);
    if (!thread) return null;
    // Validate state transition if status is changing
    const statusChanged = update.status !== undefined && update.status !== thread.status;
    if (statusChanged) {
      if (!isValidTransition(thread.status, update.status!)) {
        throw new Error(`Invalid thread state transition: ${thread.status} → ${update.status}`);
      }
    }
    globalEventSeq += 1;
    const updated: ThreadRecord = {
      ...thread,
      ...update,
      updatedAt: nowISO(),
      eventSeq: globalEventSeq,
    };
    map.set(threadId, updated);
    await persist(parentSessionId);
    emitChange(updated);
    // Reaching any terminal state frees a slot. Doing it here rather than in
    // each caller means every path that ends a thread — done, failed,
    // cancelled, merged, archived, or a direct updateThread — dequeues.
    if (statusChanged && TERMINAL_STATES.has(updated.status)) {
      await maybeDequeue(parentSessionId);
    }
    return updated;
  }

  async function setSessionId(parentSessionId: string, threadId: string, sessionId: string): Promise<ThreadRecord | null> {
    return updateThread(parentSessionId, threadId, { sessionId, status: "running" });
  }

  async function setWorktree(parentSessionId: string, threadId: string, worktree: ThreadWorktree): Promise<ThreadRecord | null> {
    return updateThread(parentSessionId, threadId, { worktree });
  }

  async function markWorkerLost(parentSessionId: string, threadId: string): Promise<ThreadRecord | null> {
    const map = await loadParent(parentSessionId);
    const thread = map.get(threadId);
    if (!thread) return null;
    return updateThread(parentSessionId, threadId, {
      flags: { ...thread.flags, workerLost: true },
    });
  }

  async function resumeThread(parentSessionId: string, threadId: string): Promise<ThreadRecord | null> {
    const map = await loadParent(parentSessionId);
    const thread = map.get(threadId);
    if (!thread) return null;
    return updateThread(parentSessionId, threadId, {
      status: "running",
      flags: { ...thread.flags, workerLost: false },
    });
  }

  async function cancelThread(parentSessionId: string, threadId: string, exitReason?: string): Promise<ThreadRecord | null> {
    return updateThread(parentSessionId, threadId, {
      status: "cancelled",
      exitReason: exitReason ?? "cancelled by user or parent",
    });
  }

  async function archiveThread(parentSessionId: string, threadId: string): Promise<ThreadRecord | null> {
    return updateThread(parentSessionId, threadId, { status: "archived" });
  }

  async function convertThread(parentSessionId: string, threadId: string): Promise<ThreadRecord | null> {
    return updateThread(parentSessionId, threadId, { kind: "implementation" });
  }

  async function completeThread(
    parentSessionId: string,
    threadId: string,
    report: ThreadReport,
  ): Promise<ThreadRecord | null> {
    // Idempotent: if already done with a report, return existing
    const map = await loadParent(parentSessionId);
    const thread = map.get(threadId);
    if (!thread) return null;
    if (thread.status === "done" && thread.report) {
      return thread; // Already completed — return same record
    }
    return updateThread(parentSessionId, threadId, {
      status: "done",
      report,
      exitReason: null,
    });
  }

  async function mergeThread(parentSessionId: string, threadId: string): Promise<ThreadRecord | null> {
    return updateThread(parentSessionId, threadId, { status: "merged" });
  }

  async function updateProgress(
    parentSessionId: string,
    threadId: string,
    progress: {
      steps?: number;
      tokens?: Partial<ThreadTokens>;
      lastToolCall?: { name: string; at: string };
      diffStats?: ThreadDiffStats;
      costUsd?: number;
    },
  ): Promise<ThreadRecord | null> {
    const map = await loadParent(parentSessionId);
    const thread = map.get(threadId);
    if (!thread) return null;
    return updateThread(parentSessionId, threadId, {
      steps: progress.steps ?? thread.steps,
      tokens: { ...thread.tokens, ...(progress.tokens ?? {}) },
      lastToolCall: progress.lastToolCall ?? thread.lastToolCall,
      diffStats: progress.diffStats ?? thread.diffStats,
      costUsd: progress.costUsd ?? thread.costUsd,
      lastActivityAt: nowISO(),
    });
  }

  async function setWaitingFor(
    parentSessionId: string,
    threadId: string,
    waitingFor: ThreadWaitingFor | null,
  ): Promise<ThreadRecord | null> {
    return updateThread(parentSessionId, threadId, {
      status: waitingFor ? "waiting-for-input" : "running",
      waitingFor,
    });
  }

  async function setFlags(
    parentSessionId: string,
    threadId: string,
    flags: Partial<ThreadFlags>,
  ): Promise<ThreadRecord | null> {
    const map = await loadParent(parentSessionId);
    const thread = map.get(threadId);
    if (!thread) return null;
    return updateThread(parentSessionId, threadId, {
      flags: { ...thread.flags, ...flags },
    });
  }

  async function cancelAllForParent(parentSessionId: string): Promise<void> {
    draining.add(parentSessionId);
    try {
      const map = await loadParent(parentSessionId);
      const updates: Promise<ThreadRecord | null>[] = [];
      for (const thread of map.values()) {
        if (thread.status === "running" || thread.status === "queued"
          || thread.status === "idle" || thread.status === "waiting-for-input") {
          updates.push(cancelThread(parentSessionId, thread.id, "parent session deleted"));
        }
      }
      await Promise.all(updates);
    } finally {
      draining.delete(parentSessionId);
    }
  }

  async function deleteThread(parentSessionId: string, threadId: string): Promise<boolean> {
    const map = await loadParent(parentSessionId);
    const deleted = map.delete(threadId);
    if (deleted) {
      // Clean up cursors for this thread
      for (const key of cursors.keys()) {
        if (key.endsWith(`:${threadId}`)) {
          cursors.delete(key);
        }
      }
      await persist(parentSessionId);
    }
    return deleted;
  }

  // ── Observer cursors (§9.3.7) ───────────────────────────────────

  function cursorKey(observerSessionId: string, threadId: string): string {
    return `${observerSessionId}:${threadId}`;
  }

  function getCursor(observerSessionId: string, threadId: string): ThreadViewCursor | null {
    return cursors.get(cursorKey(observerSessionId, threadId)) ?? null;
  }

  function setCursor(observerSessionId: string, threadId: string, cursor: ThreadViewCursor): void {
    cursors.set(cursorKey(observerSessionId, threadId), cursor);
  }

  function clearCursorsForSession(observerSessionId: string): void {
    for (const key of cursors.keys()) {
      if (key.startsWith(`${observerSessionId}:`)) {
        cursors.delete(key);
      }
    }
  }

  // ── Wait subscription (blocking wait, §9.3.6) ───────────────────

  /**
   * Subscribe to thread state changes for a parent session.
   * Returns an unsubscribe function. When any thread in the session
   * changes state, the callback is called.
   */
  function subscribeToChanges(parentSessionId: string, callback: () => void): () => void {
    if (!waiters.has(parentSessionId)) {
      waiters.set(parentSessionId, []);
    }
    waiters.get(parentSessionId)!.push(callback);
    return () => {
      const arr = waiters.get(parentSessionId);
      if (arr) {
        const idx = arr.indexOf(callback);
        if (idx !== -1) arr.splice(idx, 1);
      }
    };
  }

  /**
   * Check if concurrency allows dequeuing a queued thread, and if so,
   * promote the oldest queued thread. Called after a thread reaches a
   * terminal state (done/failed/cancelled/merged).
   */
  async function maybeDequeue(parentSessionId: string): Promise<void> {
    // While the parent is being torn down every remaining thread is being
    // cancelled; promoting a queued one into a fresh child session there
    // would resurrect work the user just deleted.
    if (draining.has(parentSessionId)) return;
    if (await countActive(parentSessionId) >= maxConcurrency) return;
    await tryDequeue(parentSessionId);
  }

  /**
   * Try to dequeue a queued thread (called when a running thread finishes).
   * Promotes the oldest queued thread to "running" status and calls the
   * onThreadDequeued callback so the host can spawn the child session.
   * Returns the dequeued thread or null if no queued threads exist.
   */
  async function tryDequeue(parentSessionId: string): Promise<ThreadRecord | null> {
    const map = await loadParent(parentSessionId);
    const queued = [...map.values()]
      .filter((t) => t.status === "queued")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    if (queued.length === 0) return null;
    const next = queued[0]!;
    // The host will call setSessionId which transitions queued → running.
    // We just notify the host; the actual spawn happens asynchronously.
    if (options.onThreadDequeued) {
      await options.onThreadDequeued(parentSessionId, next);
    }
    return next;
  }

  return {
    createThread,
    getThread,
    listThreads,
    countActive,
    updateThread,
    setSessionId,
    setWorktree,
    markWorkerLost,
    resumeThread,
    cancelThread,
    archiveThread,
    convertThread,
    completeThread,
    mergeThread,
    updateProgress,
    setWaitingFor,
    setFlags,
    cancelAllForParent,
    deleteThread,
    // Observer cursors
    getCursor,
    setCursor,
    clearCursorsForSession,
    // Wait subscription
    subscribeToChanges,
    tryDequeue,
    // Concurrency
    maxConcurrency,
  };
}

export type ThreadRegistry = ReturnType<typeof createThreadRegistry>;
