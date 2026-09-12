/**
 * Thread protocol types — shared between Host events and harness services.
 *
 * A Thread is durable work. A ThreadRun is one execution attempt. Keeping
 * those records separate prevents a restarted worker from rewriting history
 * as though the first attempt never ended.
 */

import type { PermissionPolicy } from "./permission-gate.js";

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

/**
 * Host-owned mapping from a live Pi session to the Thread catalog it belongs to.
 * `owningWorkspaceId` is the original project workspace; it is not the scratch
 * or materialized execution workspace Documents assigns to the Run cwd.
 */
export interface ThreadSessionBinding {
  sessionId: string;
  owningWorkspaceId: string;
  threadId: string;
  runId: string;
  parent: ThreadParent;
}

export type RetrievalFactStatus = "source-checked" | "unknown" | "unavailable";
export type RetrievalSourceCheck = "source-valid" | "unavailable" | "unknown";
export type RetrievalEvidenceCompletion =
  | "delivered"
  | "incomplete"
  | "cancelled"
  | "unavailable";

export interface RetrievalOutputRef {
  durability: "ephemeral";
  generation: string;
  handle: string;
}

export interface RetrievalArtifactRef {
  durability: "durable";
  hash: string;
  byteLength: number;
}

export interface RetrievalReceiptAuthority {
  owningWorkspaceId: string;
  sessionId: string;
  threadId?: string;
  runId?: string;
}

export interface RetrievalUrlReceipt {
  receiptId: string;
  finalUrl: string;
  contentHash: string;
  revision: string;
  /** Durable bytes fetched for this exact receipt. */
  artifact: RetrievalArtifactRef;
  /** The actor that may promote this temporary receipt into retrieval evidence. */
  authority: RetrievalReceiptAuthority;
}

export interface RetrievalFactSource {
  kind: "local" | "url" | "output";
  check?: RetrievalSourceCheck;
  path?: string;
  startLine?: number;
  endLine?: number;
  revision?: string;
  origin?: "disk" | "surface-draft" | "working-branch";
  contentHash?: string;
  excerpt?: string;
  artifact?: RetrievalArtifactRef;
  url?: string;
  receiptId?: string;
  outputRef?: RetrievalOutputRef;
}

export interface RetrievalFact {
  claim: string;
  status: RetrievalFactStatus;
  sources: RetrievalFactSource[];
}

export interface RetrievalAttempt {
  action: string;
  outcome: "rejected" | "unavailable" | "empty" | "failed";
  detail?: string;
}

/**
 * Host-validated retrieval delivery. Host can prove source-checked /
 * source-valid identity, not that a claim is semantically true. There are
 * no recommendation or priority fields.
 */
export interface RetrievalEvidence {
  question: string;
  scope: string[];
  facts: RetrievalFact[];
  unknowns: string[];
  attempted: RetrievalAttempt[];
  completion: RetrievalEvidenceCompletion;
}

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
  /** Present for retrieval threads; Host-sealed fact material. */
  evidence?: RetrievalEvidence;
  /** Run that sealed `evidence`; stable across later Run attempts. */
  evidenceRunId?: string;
}

export const emptyRetrievalEvidence = (
  question: string,
  scope: readonly string[],
  completion: RetrievalEvidenceCompletion = "incomplete",
): RetrievalEvidence => ({
  question,
  scope: [...scope],
  facts: [],
  unknowns: [],
  attempted: [],
  completion,
});

export const summarizeRetrievalEvidence = (evidence: RetrievalEvidence): string => {
  const checked = evidence.facts.filter((fact) => fact.status === "source-checked").length;
  return `retrieval ${evidence.completion}: ${checked} source-checked, ${evidence.unknowns.length} unknown, ${evidence.attempted.length} attempted`;
};

export const formatRetrievalEvidenceText = (evidence: RetrievalEvidence): string => {
  const lines = [
    `Question: ${evidence.question}`,
    `Scope: ${evidence.scope.join(", ") || "(workspace)"}`,
    `Completion: ${evidence.completion}`,
    `Facts (${evidence.facts.length}):`,
  ];
  for (const fact of evidence.facts) {
    lines.push(`- [${fact.status}] ${fact.claim}`);
    for (const source of fact.sources) {
      if (source.kind === "local") {
        const range = source.startLine !== undefined && source.endLine !== undefined
          ? `:${source.startLine}-${source.endLine}`
          : "";
        const revision = source.revision ? ` @${source.revision}` : "";
        const origin = source.origin ? ` (${source.origin})` : "";
        const check = source.check ? ` ${source.check}` : "";
        lines.push(`  ${source.path ?? "?"}${range}${revision}${origin}${check}`);
        if (source.excerpt) {
          for (const line of source.excerpt.split("\n")) lines.push(`    ${line}`);
        }
        continue;
      }
      if (source.kind === "url") {
        const receipt = source.receiptId ? ` receipt ${source.receiptId}` : "";
        lines.push(`  ${source.url ?? "?"}${receipt}`);
        continue;
      }
      if (source.artifact) {
        lines.push(`  output artifact ${source.artifact.hash}`);
        continue;
      }
      lines.push(`  output ${source.outputRef?.handle ?? "?"}`);
    }
  }
  if (evidence.unknowns.length > 0) {
    lines.push("Unknowns:");
    for (const item of evidence.unknowns) lines.push(`- ${item}`);
  }
  if (evidence.attempted.length > 0) {
    lines.push("Attempted:");
    for (const item of evidence.attempted) {
      lines.push(`- ${item.action}: ${item.outcome}${item.detail ? ` (${item.detail})` : ""}`);
    }
  }
  return lines.join("\n");
};

export const sealRetrievalEvidence = (
  pending: RetrievalEvidence | undefined,
  input: {
    brief: string;
    scope: readonly string[];
    outcome: ThreadRunOutcome;
    exitReason: string | null;
  },
): RetrievalEvidence => {
  const base = pending
    ? {
        question: input.brief,
        scope: [...pending.scope],
        facts: pending.facts.map((fact) => ({
          ...fact,
          sources: fact.sources.map((source) => {
            if (!source.outputRef) return source;
            const { outputRef: _ephemeral, ...rest } = source;
            return rest;
          }),
        })),
        unknowns: [...pending.unknowns],
        attempted: [...pending.attempted],
        completion: pending.completion,
      }
    : emptyRetrievalEvidence(input.brief, input.scope, "incomplete");
  if (input.outcome === "cancelled") {
    return { ...base, question: input.brief, completion: "cancelled" };
  }
  if (!pending) {
    const lost = input.exitReason ?? "no validated facts were submitted";
    return {
      ...base,
      question: input.brief,
      completion: "incomplete",
      unknowns: base.unknowns.includes(lost) ? base.unknowns : [...base.unknowns, lost],
    };
  }
  const unavailableOnly = pending.facts.length > 0
    && pending.facts.every((fact) => fact.status === "unavailable");
  if (unavailableOnly) return { ...base, question: input.brief, completion: "unavailable" };
  return { ...base, question: input.brief, completion: "delivered" };
};

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
  /**
   * Piarium-managed directory that owns `path` and every switch/snapshot
   * sibling. Destructive and Git-mutating operations reject records without
   * this persistent ownership root or whose canonical path escapes it.
   */
  managedRoot?: string;
  /** Retrieval input view; may be materialized for LSP but is never publishable. */
  readOnlyInput?: boolean;
  /**
   * Parent-state identity (parent HEAD or `thread-<id>@<writeRevision>`).
   * Inspect/snapshot/settle must not treat this as a commit that the
   * execution repository can resolve.
   */
  base: string;
  /**
   * Commit currently resolvable in the execution Git repository after
   * `git init`, detached worktree add, rematerialize, or crash recovery.
   * Cleared when the execution directory is reclaimed.
   */
  executionBaseline?: string;
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
   * Durable directory switch journal for a frozen `writeRevision`.
   * Restart recovers to one authoritative view; it must not leave a half-switched
   * live path. Caller abort rolls the switch back to virtual.
   */
  materializationSwitch?: {
    writeRevision: number;
    stagingPath: string;
    backupPath: string;
    stage: "staging-ready" | "live-backed-up" | "staging-promoted";
  };
  /**
   * Durable progress through directory reconstruction and environment setup.
   * `materializing` may have a partial managed directory on disk; it is never
   * safe to open until the state advances to `setup` or `ready`.
   */
  preparationStage?: "capturing-baseline" | "materialize" | "materializing" | "setup" | "ready";
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
  /** Frozen Host permission overlay. Nested children inherit or narrow it. */
  permissions?: PermissionPolicy;
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
  /** Host-validated retrieval draft; copied into report.evidence at settle. */
  pendingEvidence?: RetrievalEvidence;
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
  /** CoW/reflink backend summary from the last materialization (D-250). */
  cow?: { reflink: number; copy: number };
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
  /** UTF-8 byte offset when paging a retrieval report. */
  offset?: number;
  /** UTF-8 byte length when paging a retrieval report. */
  length?: number;
}

export interface ThreadReadResult {
  text: string;
  report: ThreadReport | null;
  transcriptRef: TranscriptRef | null;
  nextOffset?: number;
  eof?: boolean;
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

export interface ThreadFactsSetParams {
  question: string;
  facts: Array<{
    claim: string;
    sources: Array<{
      kind: "local" | "url" | "output";
      path?: string;
      startLine?: number;
      endLine?: number;
      url?: string;
      receiptId?: string;
      outputRef?: RetrievalOutputRef;
    }>;
  }>;
  unknowns?: string[];
  attempted?: Array<{
    action: string;
    outcome: "rejected" | "unavailable" | "empty" | "failed";
    detail?: string;
  }>;
}

export interface ThreadFactsSetResult {
  text: string;
  evidence: RetrievalEvidence;
}

export interface ThreadDispatchResult {
  text: string;
  threadId: string;
  queued: boolean;
}
