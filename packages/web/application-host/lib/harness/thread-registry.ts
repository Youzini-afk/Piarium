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

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ThreadViewCursor } from "@piarium/protocol";

// ── Types ──────────────────────────────────────────────────────────

export type ThreadStatus =
  | "queued"
  | "running"
  | "idle"
  | "waiting-for-input"
  | "done"
  | "failed"
  | "cancelled"
  | "merged"
  | "archived";

export type ThreadKind = "discussion" | "implementation";
export type ThreadCreatedBy = "user" | "agent";

export interface ThreadReport {
  conclusion: string;
  changedFiles: string[];
  unresolved: string[];
  deviations: string[];
  confidence: number;
  traceHandle: string;
  blocksSnapshot: Record<string, string>;
}

export interface ThreadFlags {
  workerLost: boolean;
  stalled: boolean;
  looping: boolean;
}

export interface ThreadWaitingFor {
  kind: "user" | "permission" | "thread";
  text: string;
}

export interface ThreadWorktree {
  path: string;
  base: string;
}

export interface ThreadTokens {
  input: number;
  output: number;
  cacheRead: number;
}

export interface ThreadDiffStats {
  files: number;
  insertions: number;
  deletions: number;
}

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

// ── Registry ───────────────────────────────────────────────────────

export function createThreadRegistry(options: ThreadRegistryOptions) {
  const { dataDir, hostId } = options;
  const maxConcurrency = options.maxConcurrency ?? 12;
  // In-memory cache: parentSessionId → Map<threadId, ThreadRecord>
  const cache = new Map<string, Map<string, ThreadRecord>>();
  // hidden threads: not included in listThreads for the parent agent
  const hidden = new Set<string>();
  // Observer cursors: `${observerSessionId}:${threadId}` → ThreadViewCursor
  const cursors = new Map<string, ThreadViewCursor>();
  // Wait wakeup: parentSessionId → array of resolve callbacks
  const waiters = new Map<string, Array<() => void>>();
  // Global event sequence counter
  let globalEventSeq = 0;

  async function loadParent(parentSessionId: string): Promise<Map<string, ThreadRecord>> {
    const existing = cache.get(parentSessionId);
    if (existing) return existing;
    let map = new Map<string, ThreadRecord>();
    try {
      const raw = await readFile(threadFilePath(dataDir, hostId, parentSessionId), "utf8");
      const records = JSON.parse(raw) as ThreadRecord[];
      map = new Map(records.map((r) => [r.id, r]));
    } catch {
      // File doesn't exist yet — empty map
    }
    cache.set(parentSessionId, map);
    return map;
  }

  async function persist(parentSessionId: string): Promise<void> {
    const map = cache.get(parentSessionId);
    if (!map) return;
    const filePath = threadFilePath(dataDir, hostId, parentSessionId);
    await mkdir(join(filePath, ".."), { recursive: true });
    const records = [...map.values()];
    await writeFile(filePath, JSON.stringify(records, null, 2), "utf8");
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
    // Check concurrency: if autoRun and running threads >= max, queue it
    const map = await loadParent(input.parentSessionId);
    const runningCount = [...map.values()].filter(
      (t) => t.status === "running" || t.status === "queued",
    ).length;
    const shouldQueue = input.autoRun && runningCount >= maxConcurrency;
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
      status: shouldQueue ? "queued" : (input.autoRun ? "queued" : "idle"),
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
    };
    map.set(id, record);
    if (input.hidden) hidden.add(id);
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
    return [...map.values()].filter((t) => includeHidden || !hidden.has(t.id));
  }

  async function updateThread(
    parentSessionId: string,
    threadId: string,
    update: Partial<ThreadRecord>,
  ): Promise<ThreadRecord | null> {
    const map = await loadParent(parentSessionId);
    const thread = map.get(threadId);
    if (!thread) return null;
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
    const map = await loadParent(parentSessionId);
    const updates: Promise<ThreadRecord | null>[] = [];
    for (const thread of map.values()) {
      if (thread.status === "running" || thread.status === "queued" || thread.status === "waiting-for-input") {
        updates.push(cancelThread(parentSessionId, thread.id, "parent session deleted"));
      }
    }
    await Promise.all(updates);
  }

  async function deleteThread(parentSessionId: string, threadId: string): Promise<boolean> {
    const map = await loadParent(parentSessionId);
    const deleted = map.delete(threadId);
    if (deleted) {
      hidden.delete(threadId);
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
   * Try to dequeue a queued thread (called when a running thread finishes).
   * Returns the dequeued thread or null.
   */
  async function tryDequeue(parentSessionId: string): Promise<ThreadRecord | null> {
    const map = await loadParent(parentSessionId);
    const queued = [...map.values()]
      .filter((t) => t.status === "queued")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    if (queued.length === 0) return null;
    return queued[0] ?? null;
  }

  return {
    createThread,
    getThread,
    listThreads,
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
