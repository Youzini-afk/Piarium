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
  resultCommit?: string;
  /** Native immutable working-state revision read by inspect/merge/reopen. */
  resultRevision?: number;
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
  /** Immutable copy-backend result directory for legacy/non-native callers. */
  resultPath?: string;
  /** Whether the physical directory is currently materialized on disk. */
  materialized?: boolean;
  /** Physical disk footprint in bytes, if measured. */
  diskBytes?: number;
  /** Files changed in the worktree if inspected or recorded. */
  changedFiles?: string[];
  /** Why a materialized directory could not be reclaimed safely. */
  retentionReason?: string;
}

/** Immutable launch inputs captured when the Thread is created. */
export interface ThreadLaunchManifest {
  carryBlocks: boolean;
  concurrency: number;
  /** Host-owned immutable editor draft baseline captured at dispatch. */
  draftBaselineId: string | null;
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
  /** Host-owned working-state branch associated with this Thread. */
  workBranchId?: string;
  /** Latest published immutable result on workBranchId. */
  resultRevision?: number;
  lifecycle: ThreadLifecycle;
  attention: ThreadAttention;
  waitingFor: ThreadWaitingFor | null;
  integration: ThreadIntegration;
  diffStats: ThreadDiffStats | null;
  report: ThreadReport | null;
  mergedCommit?: string;
  /** Native result revision most recently integrated into the parent. */
  mergedResultRevision?: number;
  /** Compact Host preview binding shared by Thread, wait, Zone 2, and the thread UI. */
  integrationBinding?: ThreadIntegrationBinding;
  activeRunId: string | null;
  createdAt: string;
  updatedAt: string;
  eventSeq: number;
  hidden: boolean;
  /** User-requested keep of the materialized directory across archive/reclaim. */
  keepWorktree?: boolean;
}

export interface ThreadSpaceMeasurement {
  logicalBytes: number | null;
  allocatedBytes: number | null;
  unknown: boolean;
}

export interface ThreadOccupancy {
  threadId: string;
  materialized: ThreadSpaceMeasurement;
  exclusiveObjects: ThreadSpaceMeasurement;
  sharedObjects: ThreadSpaceMeasurement;
  reclaimable: boolean;
  reclaimableLogicalBytes: number | null;
  keepReasons: string[];
}

export interface WorkspaceThreadSpace {
  workspaceId: string;
  threads: ThreadOccupancy[];
  uniqueObjectLogicalBytes: number | null;
  uniqueObjectUnknown: boolean;
  materializedLogicalBytes: number | null;
  budget?: { maxBytes?: number; minFreeRatio?: number };
  freeBytes: number | null;
  status: "ok" | "over-budget" | "low-free" | "enospc" | "unknown";
  note: string;
}

export type ThreadRestoreStatus =
  | "restored"
  | "path-occupied"
  | "rebuild-failed"
  | "enospc"
  | "budget-unavailable";

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

export type IntegrationApplyPhase =
  | "pending"
  | "disk-applied"
  | "surface-applied"
  | "conflict"
  | "unavailable"
  | "compensated"
  | "skipped-identical";

export type IntegrationPathDecision =
  | "identical"
  | "apply-child"
  | "keep-parent"
  | "merge-clean"
  | "conflict"
  | "unavailable";

export interface ThreadSurfaceParent {
  resourceId: string;
  localEditRevision: number;
  baseRevision: string | null;
  content: string;
}

export interface ThreadConflictResolution {
  path: string;
  choice: "parent" | "child" | "base" | "text";
  text?: string;
  expectedParentRevision?: string;
  expectedLocalEditRevision?: number;
}

export interface IntegrationPathBinding {
  target: "disk" | "surface" | "unavailable";
  revision: string;
  localEditRevision?: number;
}

export interface IntegrationPathProjection {
  path: string;
  target: IntegrationPathBinding["target"];
  decision: IntegrationPathDecision;
  phase: IntegrationApplyPhase;
  isText: boolean;
  conflictReason?: string;
  parentText?: string;
  childText?: string;
  baselineText?: string;
}

export interface ThreadIntegrationBinding {
  operationId: string;
  resultRevision: number;
  bindingFingerprint: string;
  valid: boolean;
  mergeReady: boolean;
  conflictPaths: string[];
  surfaceTargetPaths: string[];
  unavailablePaths: string[];
}

export const threadIntegrationBindingFromPreview = (
  preview: ThreadIntegrationPreview,
): ThreadIntegrationBinding => ({
  operationId: preview.operationId,
  resultRevision: preview.resultRevision,
  bindingFingerprint: preview.bindingFingerprint,
  valid: preview.valid,
  mergeReady: preview.mergeReady,
  conflictPaths: [...preview.conflictPaths],
  surfaceTargetPaths: [...preview.surfaceTargetPaths],
  unavailablePaths: [...preview.unavailablePaths],
});

export interface ThreadIntegrationPreview {
  operationId: string;
  threadId: string;
  resultRevision: number;
  bindingFingerprint: string;
  valid: boolean;
  mergeReady: boolean;
  binding: Record<string, IntegrationPathBinding>;
  paths: IntegrationPathProjection[];
  conflictPaths: string[];
  surfaceTargetPaths: string[];
  unavailablePaths: string[];
  appliedPaths: string[];
  invalidReason?: string;
}

export interface ThreadSurfaceEdit {
  resourceId: string;
  expectedLocalEditRevision: number;
  expectedBaseRevision: string | null;
  newText: string;
}

export interface ThreadMergeParams {
  threadId: string;
  /** Omit to integrate the latest published result. */
  resultRevision?: number;
  /** Live editor buffers identified by workspace resource, not the focused window. */
  surfaceParents?: ThreadSurfaceParent[];
  resolutions?: ThreadConflictResolution[];
}

export interface ThreadMergeResult {
  text: string;
  merged: number;
  conflicts: string[];
  /** Draft paths that must be applied through Document Registry, not disk. */
  surfaceTargetPaths?: string[];
  surfaceEdits?: ThreadSurfaceEdit[];
  preview?: ThreadIntegrationPreview;
  status?: "applied" | "conflict" | "compensated" | "needs-attention";
  appliedPaths?: string[];
  resultRevision?: number;
  operationId?: string;
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
