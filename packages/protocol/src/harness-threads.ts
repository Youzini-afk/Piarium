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
export type ThreadAttention = "none" | "user" | "permission" | "thread" | "stalled" | "looping";
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
  review?: {
    resultRevision: number;
    reviewThreadId: string;
    reviewRunId: string;
  };
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
  /**
   * Isolated Runs without path-binding tools keep a scratch cwd and read the
   * WorkingState view. Resume must not treat this as an incomplete copy.
   */
  viewMode?: "virtual" | "materialized";
  /**
   * Durable progress through directory reconstruction and environment setup.
   * `materializing` may have a partial managed directory on disk; it is never
   * safe to open until the state advances to `setup` or `ready`.
   */
  preparationStage?: "materialize" | "materializing" | "setup" | "ready";
  /** Fingerprint of a failed partial materialization used to detect later user changes before retry cleanup. */
  materializationFingerprint?: string;
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
  /**
   * Host projection of checks and review for the current result.
   * Command exits are facts; they are not a "result verified" flag.
   */
  verification?: ThreadVerificationProjection;
  /** Hidden auto-review thread bound to one published source revision. */
  reviewOf?: ThreadReviewOf;
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

export interface ThreadVerificationCommandFact {
  command: string;
  cwd: string;
  exitCode: number | null;
  cancelled: boolean;
  relation: "same-run-matching-result" | "post-merge-matching-tree" | "unbound" | "uncertain";
  inputChanged: boolean | null;
  outputHandle?: string;
}

export interface ThreadChildCheckProjection {
  resultRevision: number;
  binding: "bound" | "uncertain";
  bindingReason?: string;
  commands: ThreadVerificationCommandFact[];
  /** Fact about recorded command exits. Not "this result passed". */
  allExitedZero: boolean | null;
}

export interface ThreadParentCheckProjection {
  mergedResultRevision: number;
  mergeOperationId?: string;
  draftUnsaved: boolean;
  binding: "bound" | "uncertain" | "cannot-verify-unsaved-draft" | "not-recorded" | "not-integrated";
  note?: string;
  commands: ThreadVerificationCommandFact[];
  allExitedZero: boolean | null;
}

export interface ThreadReviewFinding {
  severity: string;
  file?: string;
  line?: number;
  message: string;
}

export interface ThreadReviewProjection {
  resultRevision: number;
  status: "none" | "running" | "completed" | "failed" | "cancelled";
  reviewThreadId?: string;
  reviewRunId?: string;
  /** True only while this exact review identity is the configured completion gate. */
  gate?: boolean;
  conclusion?: string;
  findings?: ThreadReviewFinding[];
  error?: string;
}

export interface ThreadVerificationProjection {
  currentResultRevision?: number;
  childChecks: ThreadChildCheckProjection | null;
  parentChecks: ThreadParentCheckProjection | null;
  review: ThreadReviewProjection | null;
}

export interface ThreadReviewOf {
  sourceThreadId: string;
  resultRevision: number;
}

export interface ThreadRun {
  id: string;
  threadId: string;
  attempt: number;
  runtimeId: string;
  sessionId: string | null;
  /** Last published resultRevision known when this Run started, if any. */
  inputRevision?: number;
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
  | "surface-intent"
  | "surface-dispatched"
  | "surface-applied"
  | "surface-undone"
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
  baseRevision?: string | null;
  ownerId?: string;
  ownerGeneration?: number;
  ownerRegistrationId?: string;
  documentInstanceId?: string;
  bufferHash?: string;
  encoding?: string;
  bom?: boolean;
  lineEnding?: "lf" | "crlf" | "cr";
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

export interface ThreadMergeParams {
  threadId: string;
  /** Omit to integrate the latest published result. */
  resultRevision?: number;
  /** Required when submitting conflict resolutions from a prior preview. */
  expectedBindingFingerprint?: string;
  resolutions?: ThreadConflictResolution[];
}

export interface ThreadMergeResult {
  text: string;
  merged: number;
  conflicts: string[];
  /** Draft paths that must be applied through Document Registry, not disk. */
  surfaceTargetPaths?: string[];
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
