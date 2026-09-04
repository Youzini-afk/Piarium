/**
 * Thread protocol types — shared between Host events and harness services.
 *
 * A Thread is durable work. A ThreadRun is one execution attempt. Keeping
 * those records separate prevents a restarted worker from rewriting history
 * as though the first attempt never ended.
 */

export type ThreadKind = "discussion" | "implementation";
export type ThreadCreatedBy = "user" | "agent";
export type ThreadLifecycle = "queued" | "active" | "settled" | "archived";
export type ThreadAttention = "none" | "user" | "permission" | "stalled" | "looping";
export type ThreadIntegration = "none" | "dirty" | "merge-ready" | "conflict" | "merged";
export type ThreadRunWorkerState = "starting" | "running" | "lost" | "exited";
export type ThreadRunOutcome = "success" | "failure" | "cancelled" | "lost";

export type ThreadParent =
  | { kind: "session"; id: string }
  | { kind: "thread"; id: string };

export interface ThreadReport {
  conclusion: string;
  changedFiles: string[];
  unresolved: string[];
  deviations: string[];
  confidence: number;
  transcriptRef: TranscriptRef;
  blocksSnapshot: Record<string, string>;
}

export interface TranscriptRef {
  runtimeId: string;
  sessionId: string;
  /** Null means the first entry on the referenced branch. */
  fromEntryId: string | null;
  /** Null means the current/referenced branch leaf. */
  toEntryId: string | null;
  branchLeafId?: string;
}

export interface ThreadWaitingFor {
  kind: "user" | "permission" | "thread";
  text: string;
}

export interface ThreadWorktree {
  path: string;
  base: string;
  /** Internal branch that retains the baseline and, after settlement, the result. */
  branch?: string;
  /** Commit containing the complete child delta, suitable for later recovery or cleanup. */
  resultCommit?: string;
}

/** Immutable launch inputs captured when the Thread is created. */
export interface ThreadLaunchManifest {
  concurrency: number;
  scope: string[];
  systemPromptFragment: string | null;
  tools: string[];
  worktree: "none" | "shared" | "isolated";
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

export interface Thread {
  id: string;
  parent: ThreadParent;
  workspaceId: string;
  forkPoint: { entryId: string } | null;
  brief: string;
  role: string | null;
  model: import("./harness-settings.js").ModelSelection | null;
  manifest: ThreadLaunchManifest;
  createdBy: ThreadCreatedBy;
  kind: ThreadKind;
  worktree: ThreadWorktree | null;
  lifecycle: ThreadLifecycle;
  attention: ThreadAttention;
  waitingFor: ThreadWaitingFor | null;
  integration: ThreadIntegration;
  diffStats: ThreadDiffStats | null;
  report: ThreadReport | null;
  activeRunId: string | null;
  createdAt: string;
  updatedAt: string;
  eventSeq: number;
  hidden: boolean;
}

export interface ThreadRun {
  id: string;
  threadId: string;
  attempt: number;
  runtimeId: string;
  sessionId: string | null;
  workerState: ThreadRunWorkerState;
  outcome: ThreadRunOutcome | null;
  exitReason: string | null;
  tokens: ThreadTokens;
  costUsd: number | null;
  steps: number;
  lastToolCall: { name: string; at: string } | null;
  startedAt: string;
  lastActivityAt: string;
  endedAt: string | null;
}

// ── Observer cursor (incremental views, §9.3.7) ───────────────────

export interface ThreadViewCursor {
  eventSeq: number;
  lifecycle: ThreadLifecycle;
  attention: ThreadAttention;
  integration: ThreadIntegration;
  activeRunId: string | null;
  workerState: ThreadRunWorkerState | null;
  outcome: ThreadRunOutcome | null;
  progressVersion: number;
  decisionsCount: number;
  diffStats: ThreadDiffStats | null;
  viewedAt: string;
}

// Provider TTL values remain telemetry for the opt-in keepalive experiment;
// they are not the default `wait` schedule.
export interface TtlTable {
  [providerId: string]: number;
}

export const DEFAULT_TTL_TABLE: TtlTable = {
  anthropic: 240_000,
  "anthropic-1h": 3_300_000,
  openai: 240_000,
  gemini: 240_000,
};

// ── Harness service methods for thread operations ─────────────────

export interface ThreadListParams {
  ids?: string[];
  full?: boolean;
}

export interface ThreadListItem {
  id: string;
  lifecycle: ThreadLifecycle;
  attention: ThreadAttention;
  integration: ThreadIntegration;
  brief: string;
  createdAt: string;
  role: string | null;
  updatedAt: string;
  activeRun: ThreadRun | null;
  waitingFor: ThreadWaitingFor | null;
  diffStats: ThreadDiffStats | null;
}

export interface ThreadListResult {
  text: string;
  threads: ThreadListItem[];
}

export interface ThreadWaitParams {
  ids?: string[];
  timeoutMs?: number;
}

export interface ThreadWaitResult {
  text: string;
  done: number;
  running: number;
  waiting: number;
  queued: number;
  timedOut: boolean;
}

export interface ThreadSendParams {
  threadId: string;
  message: string;
  from: "user" | "parent-agent";
}

export interface ThreadSendResult {
  accepted: boolean;
  lifecycle: ThreadLifecycle;
  attention: ThreadAttention;
}

export type ThreadReadWhat = "blocks" | "report" | "steps";

export interface ThreadReadParams {
  threadId: string;
  what?: ThreadReadWhat;
  since?: number;
}

export interface ThreadReadResult {
  text: string;
  report: ThreadReport | null;
  transcriptRef: TranscriptRef | null;
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
  keepWorktree?: boolean;
}

export interface ThreadKillResult {
  text: string;
}

export interface ThreadDispatchParams {
  /** Frozen parent-session setting; not exposed as a model tool argument. */
  concurrency?: number;
  role: string;
  task: string;
  scope?: string[];
  /** Resolved by pi-host from the session's frozen role catalog. */
  model?: import("./harness-settings.js").ModelSelection;
}

export interface ThreadDispatchResult {
  text: string;
  threadId: string;
  queued: boolean;
}
