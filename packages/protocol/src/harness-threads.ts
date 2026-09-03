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

// ── Harness service methods for thread operations ──────────────────

export interface ThreadListParams {
  parentSessionId: string;
}

export interface ThreadListResult {
  threads: Array<{
    id: string;
    status: ThreadStatus;
    brief: string;
    role: string | null;
    steps: number;
    lastActivityAt: string;
    flags: ThreadFlags;
    waitingFor: ThreadWaitingFor | null;
  }>;
}

export interface ThreadWaitParams {
  parentSessionId: string;
  ids?: string[];
  timeoutMs?: number;
}

export interface ThreadWaitResult {
  text: string;
  done: number;
  running: number;
  queued: number;
}

export interface ThreadSendParams {
  parentSessionId: string;
  threadId: string;
  message: string;
  from: "user" | "parent-agent";
}

export interface ThreadSendResult {
  accepted: boolean;
}

export interface ThreadReadParams {
  parentSessionId: string;
  threadId: string;
  steps?: number;
}

export interface ThreadReadResult {
  text: string;
  report: ThreadReport | null;
}

export interface ThreadMergeParams {
  parentSessionId: string;
  threadId: string;
}

export interface ThreadMergeResult {
  text: string;
  merged: number;
  conflicts: string[];
}

export interface ThreadKillParams {
  parentSessionId: string;
  threadId: string;
}

export interface ThreadKillResult {
  text: string;
}

export interface ThreadDispatchParams {
  parentSessionId: string;
  role: string;
  task: string;
  scope?: string[];
}

export interface ThreadDispatchResult {
  text: string;
  threadId: string;
}
