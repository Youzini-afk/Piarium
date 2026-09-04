/**
 * Thread protocol types — shared between host events and harness services.
 *
 * Design: agent-harness.md §9.3, agent-harness-plan.md §3.4
 */

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
}

// ── Observer cursor (incremental views, §9.3.7) ───────────────────

export interface ThreadViewCursor {
  /** Last event sequence number shown to this observer */
  eventSeq: number;
  /** Last status shown */
  status: ThreadStatus;
  /** Last progress block version shown */
  progressVersion: number;
  /** Last decisions count shown */
  decisionsCount: number;
  /** Last diff stats shown */
  diffStats: ThreadDiffStats | null;
  /** When this cursor was last advanced */
  viewedAt: string;
}

// ── TTL table for default wait timeout (§9.3.6, §9.2.6) ────────────

export interface TtlTable {
  /** Default timeout in ms per provider ID. Unknown → fallback. */
  [providerId: string]: number;
}

export const DEFAULT_TTL_TABLE: TtlTable = {
  anthropic: 240_000,
  "anthropic-1h": 3_300_000,
  openai: 240_000,
  gemini: 240_000,
};
export const DEFAULT_WAIT_TIMEOUT_MS = 240_000;

// ── Harness service methods for thread operations ──────────────────

export interface ThreadListParams {
  /** Filter to specific thread IDs. Omit = all visible threads. */
  ids?: string[];
  /** Ignore observer cursor, return full snapshot. */
  full?: boolean;
}

export interface ThreadListResult {
  text: string;
  threads: Array<{
    id: string;
    status: ThreadStatus;
    brief: string;
    role: string | null;
    steps: number;
    lastActivityAt: string;
    flags: ThreadFlags;
    waitingFor: ThreadWaitingFor | null;
    diffStats: ThreadDiffStats | null;
  }>;
}

export interface ThreadWaitParams {
  ids?: string[];
  timeoutMs?: number;
}

/**
 * `waiting` counts threads that are idle or waiting for an answer. Those are
 * the ones the parent (or the user) has to act on, so they are reported
 * separately rather than being folded into running or done.
 */
export interface ThreadWaitResult {
  text: string;
  done: number;
  running: number;
  /** Idle or waiting-for-input — someone has to act on these. */
  waiting: number;
  queued: number;
  /** Whether the wait timed out (normal result, not an error) */
  timedOut: boolean;
}

export interface ThreadSendParams {
  threadId: string;
  message: string;
  from: "user" | "parent-agent";
}

export interface ThreadSendResult {
  accepted: boolean;
  /** Thread status after send (e.g. "running" if woken from idle) */
  status: ThreadStatus;
}

export type ThreadReadWhat = "blocks" | "report" | "steps";

export interface ThreadReadParams {
  threadId: string;
  /** What to read: "blocks" (default), "report", or "steps" */
  what?: ThreadReadWhat;
  /** For steps: cursor to read since. Omit = since last cursor. */
  since?: number;
}

export interface ThreadReadResult {
  text: string;
  report: ThreadReport | null;
  /** For steps: the handle containing the transcript slice */
  traceHandle: string | null;
}

export interface ThreadMergeParams {
  threadId: string;
}

export interface ThreadMergeResult {
  text: string;
  merged: number;
  conflicts: string[];
}

export interface ThreadKillParams {
  threadId: string;
  /** Keep worktree after kill (default true) */
  keepWorktree?: boolean;
}

export interface ThreadKillResult {
  text: string;
}

export interface ThreadDispatchParams {
  role: string;
  task: string;
  scope?: string[];
}

export interface ThreadDispatchResult {
  text: string;
  threadId: string;
  /** Whether the thread was queued (concurrency full) or started */
  queued: boolean;
}
