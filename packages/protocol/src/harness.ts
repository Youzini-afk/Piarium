/**
 * Harness service request channel — typed protocol for worker→host service calls.
 *
 * The worker emits a `harness.request` event; the host routes it to a registered
 * service and calls `harness.respond` with the result. This mirrors the
 * `workspace.mutation.request` / `workspace.mutation.respond` pattern so the
 * channel works across every transport (local, Electron, relay) without the
 * worker holding host credentials.
 */

import type {
  ThreadListParams,
  ThreadListResult,
  ThreadWaitParams,
  ThreadWaitResult,
  ThreadSendParams,
  ThreadSendResult,
  ThreadReadParams,
  ThreadReadResult,
  ThreadMergeParams,
  ThreadMergeResult,
  ThreadKillParams,
  ThreadKillResult,
  ThreadDispatchParams,
  ThreadDispatchResult,
} from "./harness-threads.js";
import type { MemoryApplyResult, MemoryBlockSnapshot, MemoryEditOp } from "./memory-agent.js";
import type { HarnessMemoryMode } from "./harness-settings.js";
import type { AgentInputContext, JsonValue } from "./types.js";

export interface OutputSlice {
  text: string;
  offset: number;
  length: number;
  nextOffset: number;
  total: number;
  eof: boolean;
}

export interface OutputRef {
  durability: "ephemeral";
  generation: string;
  handle: string;
}

export type ShellOutputKind = "vitest" | "tsc" | "eslint" | "git" | "generic";

export interface ShellOutputOrganization {
  kind: ShellOutputKind;
  omitted: boolean;
  partial: boolean;
}

export interface ShellExecResultCompleted {
  kind: "completed";
  exitCode: number;
  durationMs: number;
  cwd: string;
  stdout: string;
  stderr: string;
  handle: string | null;
  shown: { head: number; tail: number; total: number } | null;
  display?: string;
  organized?: ShellOutputOrganization;
}

export interface ShellExecResultBackground {
  kind: "background";
  id: string;
  waitedMs: number;
  cwd: string;
  outputSoFar: string;
  command?: string;
  display?: string;
  organized?: ShellOutputOrganization;
}

export interface ShellExecResultSpawnFailed {
  kind: "spawn-failed";
  reason: string;
  interpreter: string;
  hint: string;
}

export type ShellExecResult =
  | ShellExecResultCompleted
  | ShellExecResultBackground
  | ShellExecResultSpawnFailed;

export interface ShellReadResult extends OutputSlice {
  running: boolean;
  exitCode?: number;
  command?: string;
  display?: string;
  organized?: ShellOutputOrganization;
  observation?: {
    mode: "incremental";
    first: boolean;
    sinceMs?: number;
    lastOutputAgoMs?: number;
  };
}

export interface SearchContentParams {
  pattern: string;
  path?: string;
  glob?: string[];
  ignoreCase?: boolean;
  fixedStrings?: boolean;
  before?: number;
  after?: number;
  context?: number;
  limit?: number;
}

export interface SearchContentHit {
  line: number;
  text: string;
  before: string[];
  after: string[];
}

/**
 * Unique-file coverage of one search pattern. Distinct from hit-level
 * `partial`: a per-file hit cap does not change how many matching files
 * were seen. Explore candidate-mode only.
 */
export type ExploreTermCoverage = "complete" | "lower-bound" | "unknown";

export interface SearchContentFile {
  path: string;
  hits: SearchContentHit[];
}

export interface SearchContentResult {
  status: "ready" | "empty" | "unavailable";
  files: SearchContentFile[];
  totalHits: number;
  totalFiles: number;
  searchedFiles: number;
  partial: boolean;
  handle?: string;
  /**
   * Explore candidate-mode only: matching files that had hits but were omitted
   * because the file count itself exceeded the working budget. Exact for this
   * single query. Absent on grep.
   */
  filesDropped?: number;
  /**
   * Unique-file coverage for this pattern. Distinct from `partial`, which also
   * folds per-file hit caps and display-budget trims that do not change how
   * many matching files were seen. Absent on grep.
   */
  fileCoverage?: ExploreTermCoverage;
}

export interface DiagnosticItem {
  line: number;
  character: number;
  severity: string;
  code?: string;
  message: string;
  source: string;
}

/** Which text a Host language answer was computed from (D-087). */
export type LanguageTextProvenance = "disk" | "surface-draft";

export interface DiagnosticsResult {
  status: "ready" | "pending" | "unavailable";
  snapshot?: string;
  /** Text identity the diagnosed document was bound to. */
  revision?: string;
  source?: LanguageTextProvenance;
  diagnostics: DiagnosticItem[];
  resolvedDiagnostics?: DiagnosticItem[];
  observation?: {
    mode: "incremental";
    first: boolean;
    sinceMs?: number;
    added: number;
    resolved: number;
  };
  reason?: string;
}

export interface LspNavigationResult {
  status: "ready" | "empty" | "unavailable";
  text: string;
  value?: JsonValue;
  /** Text identity the queried document was bound to (D-087). */
  revision?: string;
  source?: LanguageTextProvenance;
  /**
   * Files whose positions the language server computed from its own read. LSP
   * does not report the version it used, so they carry no bound revision.
   */
  unpinnedPaths?: string[];
}

export type FsLockParams =
  | { action: "acquire"; paths: string[]; timeoutMs?: number }
  | { action: "release"; leaseId: string };

export type FsLockResult =
  | { held: true; leaseIds: string[] }
  | { held: false; released: boolean };

export type FetchResult =
  | { status: "ok"; url: string; finalUrl: string; contentType: string; title?: string; markdown: string; bytes: number; fromCache: boolean; rendered: boolean }
  | { status: "redirect-cross-host"; url: string; location: string; statusCode: number }
  | { status: "blocked"; url: string; reason: "private-network" | "domain-blocked" | "scheme" }
  | { status: "empty-shell"; url: string; hint: string }
  | { status: "renderer-unavailable"; url: string }
  | { status: "failed"; url: string; reason: string };

export interface SearchResultItem {
  title: string;
  url: string;
  snippet: string;
  publishedAt?: string;
}

/**
 * The source selected for a native Pi `read` call. Disk reads stay inside the
 * Pi runtime; surface drafts are returned as save-compatible bytes by the
 * authenticated Application Host.
 */
export type WorkingBranchPathOrigin = "base" | "delta" | "draft-base";

export interface WorkingBranchReadProvenance {
  branchId: string;
  revision: number;
  origin: WorkingBranchPathOrigin;
}

export type DocumentReadSourceResult =
  | { source: "disk" }
  | { base64: string; revision: string; source: "surface-draft" }
  | {
    source: "working-branch";
    revision: string;
    provenance: WorkingBranchReadProvenance;
    base64?: string;
    missing?: true;
  };

/**
 * Content-free view of fixed editor paths used by the native Pi find/ls
 * wrappers. File entries carry the immutable surface revision; directories
 * are virtual ancestors and therefore have no content revision.
 */
export interface DocumentPathOverlayEntry {
  /** Path relative to the authorized request root; "." denotes that root. */
  path: string;
  kind: "file" | "directory";
  revision?: string;
}

export interface DocumentPathOverlayParams {
  path: string;
  /** Native find's glob. Omitted for ls, which lists all immediate entries. */
  pattern?: string;
}

export type DocumentPathOverlayResult =
  | { status: "disk" }
  | { status: "ready"; entries: DocumentPathOverlayEntry[]; authority?: "surface" | "working-branch" };

/**
 * Whether a native `write` / `edit` / `apply_patch` may proceed on one path.
 *
 * Reads follow this turn's fixed editor draft while writes apply to disk. When
 * those differ, writing text derived from the draft would persist the user's
 * unsaved changes without their decision, so the write is refused with an
 * actionable reason instead (D-089). `revision` is the draft identity the
 * refusal was computed against.
 */
export type DocumentWriteGuardResult =
  | { status: "allow" }
  | { status: "conflict"; message: string; revision: string }
  | { status: "unavailable"; message: string };

export type DocumentBranchWriteAction = "write" | "edit" | "delete";

export interface DocumentBranchWriteChange {
  path: string;
  action: DocumentBranchWriteAction;
  content?: string;
  edits?: ReadonlyArray<{ oldText: string; newText: string }>;
}

/**
 * Commit one or more text mutations to the unpublished WorkingState delta.
 * `expectedRevision` is the CAS token captured when the tool started.
 * `{ status: "disk" }` means this Run is not on a virtual branch view.
 */
export interface DocumentBranchWriteParams {
  expectedRevision?: number;
  path?: string;
  action?: DocumentBranchWriteAction;
  content?: string;
  edits?: ReadonlyArray<{ oldText: string; newText: string }>;
  changes?: DocumentBranchWriteChange[];
}

export type DocumentBranchWriteResult =
  | { status: "disk" }
  | { status: "committed"; revision: number; provenance: WorkingBranchReadProvenance }
  | { status: "conflict"; revision: number; message: string }
  | { status: "rejected"; message: string };

export type WorkingBranchEnsureMaterializedResult =
  | { status: "virtual" }
  | { status: "materialized"; path: string }
  | { status: "failed"; message: string };

// ── Phase 2: Zone 2, compaction, todo, recall ──────────────────────

export interface Zone2AssembleParams {
  afterEventId?: number;
  contextUsage?: { used: number; window: number };
  /** Effective session memory mode; `off` excludes stored blocks from Zone 2. */
  memoryMode: HarnessMemoryMode;
  query?: string;
  sinceTurn: number;
  /**
   * Current Pi session branch entry IDs (ancestor path from root to leaf).
   * Used to resolve the single visible revision of each memory block.
   */
  branchEntryIds: string[];
}

export interface Zone2AssembleResult {
  content: string | null;
  eventCursor: number;
}

export interface CompactionBeforeParams {
  firstKeptEntryId: string;
  tokensBefore: number;
  /** Complete active ancestor path used to resolve branch-local blocks. */
  branchEntryIds: string[];
  /**
   * Entry IDs of the conversation history being removed by compaction,
   * in branch order (oldest first). The Host uses this to verify the
   * memory keeper has continuously processed the entire range before
   * allowing takeover.
   */
  removedEntryIds: string[];
  /** Effective session mode at the Pi hook that requested takeover. */
  mode: HarnessMemoryMode;
}

export interface CompactionBeforeResult {
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
}

export interface CompactionAfterParams {
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
}

export interface CompactionAfterResult {
  acknowledged: boolean;
}

export interface TodoUpsertParams {
  items: Array<{ text: string; status: "open" | "done" | "blocked" }>;
  branchEntryIds: string[];
  confidence?: number;
}

export interface TodoUpsertResult {
  text: string;
}

export interface RecallSearchParams {
  query: string;
  k?: number;
}

export interface RecallSearchResultItem {
  scope: string;
  title: string;
  via: string;
  id: number;
}

export interface RecallSearchResult {
  text: string;
  results: RecallSearchResultItem[];
  details?: {
    vector: "unconfigured" | "unavailable" | "failed" | "empty" | "partial" | "used";
    spaceId?: string;
  };
}

export interface KnowledgeSuggestParams {
  content: string;
  trigger?: string;
}

export interface KnowledgeSuggestResult {
  created: boolean;
  skippedReason?: "empty" | "duplicate" | "no-workspace";
  suggestion?: {
    id: number;
    content: string;
    trigger: string;
    status: "suggested" | "accepted";
    scope: "workspace" | "user";
  };
}

export interface RelatedQueryParams {
  /** Workspace path or symbol / connection-literal name. */
  anchor: string;
}

export type RelatedQueryStatus = "ready" | "empty" | "unavailable" | "failed";

/** Query-time file class shared by explore and related. Not stored on the graph. */
export type HarnessFileRole = "source" | "test" | "docs" | "lock" | "other";
export type HarnessFileRoleGround = "filename-pattern" | "project-declaration" | "unknown";

export interface HarnessFileRoleDecision {
  path: string;
  role: HarnessFileRole;
  ground: HarnessFileRoleGround;
}

export interface RelatedQueryResult {
  text: string;
  status: RelatedQueryStatus;
  anchor: { kind: "path" | "name"; value: string };
  /** Query-time decoration of every path in this result. Not a graph fact. */
  roles: HarnessFileRoleDecision[];
  definitions: Array<{ name: string; kind: string; path: string }>;
  imports: {
    items: Array<{ specifier: string; path: string; resolvedPath?: string }>;
    unresolved: Array<{ specifier: string; path: string; reason: "non-relative" | "unresolved-relative" }>;
    incomplete: boolean;
  };
  importers: {
    items: Array<{ path: string; specifier: string }>;
    incomplete: boolean;
  };
  connections: {
    items: Array<{
      literal: string;
      callee: string;
      path: string;
      otherEnds: Array<{ path: string; kind: string; callee?: string }>;
    }>;
    incomplete: boolean;
  };
}

export interface ExploreSearchParams {
  question: string;
  paths?: string[];
  limit?: number;
  /** Known symbols, method names, error text, or path fragments. Literal matches; not a hard filter. */
  anchors?: string[];
}

export type ExploreSourceStatus =
  | "ready"
  | "empty"
  | "unavailable"
  | "failed"
  | "stale"
  | "not-requested"
  | "forbidden";

export type ExploreStructureProvider = "lsp" | "tree-sitter";

export type ExploreStructureStatus =
  | "ready"
  | "empty"
  | "unavailable"
  | "unsupported"
  | "stale"
  | "failed"
  | "cancelled"
  | "not-requested";

export interface ExploreStructureUnit {
  name: string;
  kind: string;
  startLine: number;
  endLine: number;
  omitted?: Array<{ startLine: number; endLine: number }>;
}

export interface ExploreStructureSource {
  provider: ExploreStructureProvider | null;
  status: ExploreStructureStatus;
}

export interface ExploreSearchSnippet {
  path: string;
  startLine: number;
  endLine: number;
  text: string;
  why: string;
  revision: string;
  source: "disk" | "surface-draft" | "working-branch";
  unit?: ExploreStructureUnit;
  structure?: ExploreStructureSource;
  /** Formatter must keep this range intact or omit the whole excerpt. */
  required?: boolean;
}

export interface ExploreSearchIssue {
  path: string;
  status: "unavailable" | "failed" | "stale" | "forbidden";
  message: string;
}

export interface ExploreSearchProvenance {
  path: string;
  revision: string;
  source: "disk" | "surface-draft" | "working-branch" | null;
  status: ExploreSourceStatus;
  matchedGroups: string[];
}

/**
 * `ready` — every excerpt path was answered by the graph. `partial` — at least
 * one lookup failed or the graph was not open for that workspace. `unavailable`
 * — no lookup succeeded. An absent `relations` means no excerpt path had any
 * edge, which is different from all three of these.
 */
export type ExploreRelationStatus = "ready" | "partial" | "unavailable";

export type ExploreGraphStatus =
  | "ready"
  | "empty"
  | "unavailable"
  | "failed"
  | "stale"
  | "not-requested";

export type ExploreQueryRelation = "register" | "import" | "define" | "unknown";
export type ExploreQueryDomain = "implementation" | "design" | "dependency" | "unknown";

export interface ExploreQueryDetails {
  objects: string[];
  relation: ExploreQueryRelation;
  domain: ExploreQueryDomain;
}

export interface ExploreTermWeight {
  term: string;
  kind: "object" | "content" | "anchor";
  /** Distinct files in this call's candidate pool that matched the group. */
  uniqueFiles: number;
  coverage: ExploreTermCoverage;
  variants: string[];
  /**
   * Query-internal weight. Ordinary match contribution is 1. Extra
   * distinctiveness is added only when `coverage` is `complete`.
   */
  weight: number;
}

/**
 * Per-call term weights. This is not corpus IDF: N and df are this
 * query's candidate pool after hit-budget truncation.
 */
export interface ExploreDistinctivenessDetails {
  scope: "query-pool";
  poolFiles: number;
  terms: ExploreTermWeight[];
}

export type ExploreArrivalKind = "lexical" | "graph" | "semantic";
export type ExploreGraphArrivalReason = "object-triggered" | "statement-evidence" | "same-container";

export interface ExploreLexicalArrival {
  kind: "lexical";
  groups: string[];
  hits: string[];
}

export interface ExploreGraphArrival {
  kind: "graph";
  edgeKind?: "connects" | "associates" | "definition" | "import";
  arrivalReason: ExploreGraphArrivalReason;
}

export interface ExploreSemanticArrival {
  kind: "semantic";
  queryVariant?: string;
  blockId?: string;
  rank?: number;
  similarity?: number;
}

export type ExploreArrival = ExploreLexicalArrival | ExploreGraphArrival | ExploreSemanticArrival;
export type ExploreAssessment = "verified-relation" | "object-present" | "name-only" | "unverified";
export type ExplorePurpose = "primary" | "support" | "candidate";

/** Generated windows for this call, packed or not. Used by observation meters. */
export interface ExploreWindowTrace {
  path: string;
  startLine: number;
  endLine: number;
  why: string;
  packed: boolean;
  hits: string[];
  arrivals: ExploreArrival[];
  assessment: ExploreAssessment;
  purpose: ExplorePurpose;
  unit?: ExploreStructureUnit;
}

export interface ExploreSkippedQueries {
  /** Broad/content-word patterns not launched because a direct clue already verified. */
  reason: "direct-verified";
  patterns: string[];
}

export type ExploreSemanticStatus =
  | "not-requested"
  | "ready"
  | "empty"
  | "unavailable"
  | "failed"
  | "stale"
  | "incomplete";

export type ExploreSemanticCoverage = "empty" | "partial" | "complete";
export type ExploreIndexLifecycle = "idle" | "building" | "rebuilding" | "ready";

export interface ExploreSemanticDetails {
  status: ExploreSemanticStatus;
  coverage: ExploreSemanticCoverage;
  generation?: string;
  spaceId?: string;
  scope?: { scopeKind: string; scopeId: string };
  index: { lifecycle: ExploreIndexLifecycle };
  blocks?: number;
  units?: number;
  primary?: number;
  /** Paths whose body is available but whose vectors are not yet in this view. */
  gaps?: ExploreSemanticGap[];
}

export interface ExploreRerankDetails {
  status: ExploreModelStageStatus;
  providerId?: string;
  modelId?: string;
  batchId?: string;
  evaluated?: number;
  note?: string;
}

export interface ExploreGraphDetails {
  status: ExploreGraphStatus;
  /** Distinct definition files, not hit count. */
  definitions: number;
  /** Distinct confirmed-connection (`connects`) files. */
  connections: number;
  /** Distinct association-candidate files. Not the same evidence grade as `connections`. */
  associates?: number;
  imports: number;
  /**
   * Floor of graph-source files that exceeded the independent graph budget.
   * Combined with rg `searched.filesDropped` by taking the maximum, not the sum.
   */
  filesDropped?: number;
  partial?: boolean;
}

export interface ExploreFileRelation {
  path: string;
  /** Disk revision the edges were collected from; null on legacy rows. */
  documentRevision: string | null;
  /**
   * The graph revision differs from the excerpt the agent is reading, so the
   * edges may name lines that moved. The edge itself is still evidence; its
   * line numbers are not (agent-harness 7.2).
   */
  stale: boolean;
  /** Link extraction was blocked for this revision, so edges may be missing. */
  incomplete: boolean;
  imports: Array<{ specifier: string; line: number }>;
  connections: Array<{ callee: string; literal: string; line: number }>;
  associations: Array<{ callee: string; literal: string; line: number }>;
}

/**
 * Dedicated reranker output is scores only. It cannot carry complementary
 * groups, required ranges, or gaps, and it is not run in the same batch as
 * the explore model by default (D-174, D-176).
 */
export interface ExploreRerankScore {
  viewId: string;
  score: number;
}

export type ExploreModelStageStatus = "used" | "skipped" | "unconfigured" | "failed" | "cancelled";

export interface ExploreModelParticipation {
  plan: ExploreModelStageStatus;
  select: ExploreModelStageStatus;
  followup: ExploreModelStageStatus;
  rerank?: ExploreModelStageStatus;
  note?: string;
}

export type ExploreSemanticGapReason =
  | "draft-vector-pending"
  | "draft-unavailable"
  | "thread-vector-pending"
  | "index-read-failed";

export interface ExploreSemanticGap {
  path: string;
  reason: ExploreSemanticGapReason;
}

export type ExploreQueryTaskFamily = "lexical" | "graph" | "semantic" | "plan" | "followup" | "model";
export type ExploreQueryTaskStatus =
  | "pending"
  | "running"
  | "ready"
  | "empty"
  | "unavailable"
  | "failed"
  | "cancelled"
  | "incomplete";

export interface ExploreQuerySourceState {
  id: string;
  family: ExploreQueryTaskFamily;
  status: ExploreQueryTaskStatus;
}

export interface ExploreQueryVocab {
  objects: string[];
  anchors: string[];
  catalog?: { symbolCount: number; fileCount?: number };
  packages?: string[];
  entries?: string[];
}

export interface ExploreQueryStartParams {
  question: string;
  paths?: string[];
  limit?: number;
  anchors?: string[];
  /** Whole public-explore remaining wait, not a fresh per-RPC budget. */
  budgetMs?: number;
  /** Leave judge/present time. Algorithm-only `explore.search` leaves this false. */
  reserveForJudge?: boolean;
}

export interface ExploreQueryStartResult {
  queryId: string;
  question: string;
  deadlineAt: number;
  parsed: ExploreQueryDetails;
  vocab: ExploreQueryVocab;
  sources: ExploreQuerySourceState[];
  inputSource: AgentInputContext["source"];
}

export interface ExploreGroupedSearchPlanGroup {
  id: string;
  concept: string;
  expressions: string[];
  expectedMaterials?: string[];
}

export interface ExploreGroupedSearchPlan {
  behavior: string;
  groups: ExploreGroupedSearchPlanGroup[];
}

export interface ExploreQueryPlanParams {
  queryId: string;
  plan: ExploreGroupedSearchPlan;
}

export interface ExploreQueryPlanResult {
  queryId: string;
  launched: string[];
  reused: string[];
  sources: ExploreQuerySourceState[];
}

export interface ExploreQueryRange {
  rangeId: string;
  startLine: number;
  endLine: number;
}

export interface ExploreQueryView {
  viewId: string;
  path: string;
  startLine: number;
  endLine: number;
  text: string;
  revision: string;
  source: "disk" | "surface-draft" | "working-branch";
  ranges: ExploreQueryRange[];
  arrivals: ExploreArrival[];
  assessment: ExploreAssessment;
  purpose: ExplorePurpose;
  why: string;
  unit?: ExploreStructureUnit;
  /** Not sent to the candidate model; selecting it is rejected as unseen. */
  unevaluated?: boolean;
}

export interface ExploreQueryViewsParams {
  queryId: string;
}

export interface ExploreQueryViewsResult {
  queryId: string;
  question: string;
  hypotheses?: { behavior?: string; expectedMaterials?: string[] };
  views: ExploreQueryView[];
  unevaluated: number;
  sources: ExploreQuerySourceState[];
  deadlineAt: number;
}

export interface ExploreQuerySelectedRange {
  viewId: string;
  rangeIds?: string[];
  startLine?: number;
  endLine?: number;
  required?: boolean;
}

export interface ExploreQuerySelectionGroup {
  id: string;
  purpose: string;
  views: ExploreQuerySelectedRange[];
  gap?: string;
}

export interface ExploreQuerySelectParams {
  queryId: string;
  groups: ExploreQuerySelectionGroup[];
  /** Keep earlier accepted groups and merge by group id. Incremental follow-up uses this. */
  merge?: boolean;
}

export interface ExploreQuerySelectResult {
  queryId: string;
  accepted: Array<{ groupId: string; viewIds: string[] }>;
  rejected: Array<{ groupId?: string; viewId?: string; reason: string }>;
  gaps: string[];
}

export interface ExploreQueryFollowupLocate {
  kind: "symbol" | "path" | "connect";
  value: string;
}

export interface ExploreQueryFollowupSearch {
  expression: string;
}

export interface ExploreQueryFollowupParams {
  queryId: string;
  searches?: ExploreQueryFollowupSearch[];
  locates?: ExploreQueryFollowupLocate[];
  gaps?: string[];
}

export interface ExploreQueryFollowupResult {
  queryId: string;
  launched: string[];
  reused: string[];
  newViews: ExploreQueryView[];
  sources: ExploreQuerySourceState[];
}

export interface ExploreQueryFinishParams {
  queryId: string;
  model?: ExploreModelParticipation;
}

export interface ExploreQueryCancelParams {
  queryId: string;
}

export interface ExploreQueryReleaseParams {
  queryId: string;
}

export interface HarnessCancelData {
  requestId?: string;
  queryId?: string;
}

export interface ExploreSearchResult {
  text: string;
  snippets: ExploreSearchSnippet[];
  issues: ExploreSearchIssue[];
  notRequested: { count: number; paths: string[] };
  omitted: Array<{ path: string; startLine: number; endLine: number; reason: string }>;
  partial: boolean;
  /**
   * `filesDropped` is a floor, not a total: query terms and search roots match overlapping
   * file sets, so the distinct union cannot be recovered from per-query counts. It carries
   * the largest single-query drop, and the model-visible body says "at least".
   */
  searched: { patterns: number; files: number; ms: number; incomplete: boolean; filesDropped?: number };
  handle: string;
  details: {
    provenance: ExploreSearchProvenance[];
    anchors: { supplied: string[]; used: string[]; truncated: number };
    byteBudget: number;
    structure?: {
      files: Array<{
        path: string;
        provider: ExploreStructureProvider | null;
        status: ExploreStructureStatus;
      }>;
    };
    /**
     * Outbound graph facts for excerpt paths only. `connections` are confirmed
     * call/register shapes; `associations` are same-string literals whose own
     * call shape is not a connection, so they are candidates, not facts.
     */
    relations?: { status: ExploreRelationStatus; files: ExploreFileRelation[] };
    /**
     * Path-level graph recall (definitions, connection endpoints, reverse
     * imports). The graph never supplies line numbers for excerpts; those are
     * re-located in the current text. Distinct from `relations`, which annotate
     * already-selected excerpts.
     */
    graph?: ExploreGraphDetails;
    query?: ExploreQueryDetails;
    skippedQueries?: ExploreSkippedQueries;
    distinctiveness?: ExploreDistinctivenessDetails;
    windows?: ExploreWindowTrace[];
    semantic?: ExploreSemanticDetails;
    rerank?: ExploreRerankDetails;
    model?: ExploreModelParticipation;
    /** Per-source production outcome. failed/empty/unavailable/incomplete/cancelled stay distinct. */
    sources?: ExploreQuerySourceState[];
  };
}

export interface HarnessServiceMap {
  "shell.exec": { params: { command: string; cwd?: string; waitMs?: number }; result: ShellExecResult };
  "shell.read": { params: { id: string; offset?: number; length?: number }; result: ShellReadResult };
  "shell.write": { params: { id: string; text: string }; result: { accepted: boolean } };
  "shell.kill": { params: { id: string }; result: { killed: boolean } };
  "output.store": { params: { text: string; label?: string }; result: { ref: OutputRef; total: number } };
  "output.read": { params: { handle: string; offset?: number; length?: number }; result: OutputSlice };
  "search.content": { params: SearchContentParams; result: SearchContentResult };
  "lsp.diagnostics": { params: { path: string; waitMs?: number }; result: DiagnosticsResult };
  "lsp.diagnosticsSnapshot": { params: { path: string; full?: boolean }; result: DiagnosticsResult };
  "lsp.symbols": { params: { path: string; query: string }; result: LspNavigationResult };
  "lsp.definition": { params: { path: string; line: number; character?: number }; result: LspNavigationResult };
  "lsp.references": { params: { path: string; line: number; character?: number }; result: LspNavigationResult };
  "lsp.hover": { params: { path: string; line: number; character?: number }; result: LspNavigationResult };
  "fs.lock": { params: FsLockParams; result: FsLockResult };
  "web.fetch": { params: { url: string; render?: boolean }; result: FetchResult };
  "web.search": { params: { query: string; allowedDomains?: string[]; blockedDomains?: string[]; recency?: "day" | "week" | "month" | "year"; limit?: number }; result: { providerId: string; results: SearchResultItem[] } };
  "zone2.assemble": { params: Zone2AssembleParams; result: Zone2AssembleResult };
  "compaction.before": { params: CompactionBeforeParams; result: CompactionBeforeResult };
  "compaction.after": { params: CompactionAfterParams; result: CompactionAfterResult };
  "todo.upsert": { params: TodoUpsertParams; result: TodoUpsertResult };
  "recall.search": { params: RecallSearchParams; result: RecallSearchResult };
  "knowledge.suggest": { params: KnowledgeSuggestParams; result: KnowledgeSuggestResult };
  "memory.blocks.get": { params: { branchEntryIds: string[] }; result: { blocks: MemoryBlockSnapshot[] } };
  "memory.blocks.apply": { params: { cursorTurn: number; ops: MemoryEditOp[]; branchEntryIds: string[]; coveredEntryIds: string[] }; result: MemoryApplyResult };
  // Phase 3: Thread operations
  "thread.dispatch": { params: ThreadDispatchParams; result: ThreadDispatchResult };
  "thread.list": { params: ThreadListParams; result: ThreadListResult };
  "thread.wait": { params: ThreadWaitParams; result: ThreadWaitResult };
  "thread.send": { params: ThreadSendParams; result: ThreadSendResult };
  "thread.read": { params: ThreadReadParams; result: ThreadReadResult };
  "thread.merge": { params: ThreadMergeParams; result: ThreadMergeResult };
  "thread.kill": { params: ThreadKillParams; result: ThreadKillResult };
  "explore.search": {
    params: ExploreSearchParams;
    result: ExploreSearchResult;
  };
  "explore.query.start": {
    params: ExploreQueryStartParams;
    result: ExploreQueryStartResult;
  };
  "explore.query.plan": {
    params: ExploreQueryPlanParams;
    result: ExploreQueryPlanResult;
  };
  "explore.query.views": {
    params: ExploreQueryViewsParams;
    result: ExploreQueryViewsResult;
  };
  "explore.query.select": {
    params: ExploreQuerySelectParams;
    result: ExploreQuerySelectResult;
  };
  "explore.query.followup": {
    params: ExploreQueryFollowupParams;
    result: ExploreQueryFollowupResult;
  };
  "explore.query.finish": {
    params: ExploreQueryFinishParams;
    result: ExploreSearchResult;
  };
  "explore.query.cancel": {
    params: ExploreQueryCancelParams;
    result: { cancelled: boolean };
  };
  "explore.query.release": {
    params: ExploreQueryReleaseParams;
    result: { released: boolean };
  };
  "related.query": {
    params: RelatedQueryParams;
    result: RelatedQueryResult;
  };
  "document.readSource": { params: { path: string }; result: DocumentReadSourceResult };
  "document.pathOverlay": { params: DocumentPathOverlayParams; result: DocumentPathOverlayResult };
  "document.writeGuard": { params: { path: string }; result: DocumentWriteGuardResult };
  "document.branchWrite": { params: DocumentBranchWriteParams; result: DocumentBranchWriteResult };
  "workingBranch.ensureMaterialized": { params: Record<string, never>; result: WorkingBranchEnsureMaterializedResult };
  "surface.snapshot.commit": { params: { context: AgentInputContext }; result: { committed: boolean } };
  "surface.snapshot.release": { params: { context: AgentInputContext }; result: { released: boolean } };
}

export type HarnessMethod = keyof HarnessServiceMap;

/**
 * Coarse, host-enforced capabilities for worker-to-host harness services.
 * These describe structural authority only; interactive allow/ask/deny policy
 * remains owned by the Pi tool gate.
 */
export type HarnessCapability =
  | "context.session"
  | "control.thread"
  | "process.shell"
  | "read.lsp"
  | "read.output"
  | "read.document"
  | "read.search"
  | "read.web"
  | "write.document";

export const HARNESS_METHOD_CAPABILITY = {
  "shell.exec": "process.shell",
  "shell.read": "process.shell",
  "shell.write": "process.shell",
  "shell.kill": "process.shell",
  "output.store": "read.output",
  "output.read": "read.output",
  "search.content": "read.search",
  "lsp.diagnostics": "read.lsp",
  "lsp.diagnosticsSnapshot": "read.lsp",
  "lsp.symbols": "read.lsp",
  "lsp.definition": "read.lsp",
  "lsp.references": "read.lsp",
  "lsp.hover": "read.lsp",
  "fs.lock": "write.document",
  "web.fetch": "read.web",
  "web.search": "read.web",
  "zone2.assemble": "context.session",
  "compaction.before": "context.session",
  "compaction.after": "context.session",
  "todo.upsert": "context.session",
  "recall.search": "context.session",
  "knowledge.suggest": "context.session",
  "memory.blocks.get": "context.session",
  "memory.blocks.apply": "context.session",
  "thread.dispatch": "control.thread",
  "thread.list": "control.thread",
  "thread.wait": "control.thread",
  "thread.send": "control.thread",
  "thread.read": "control.thread",
  "thread.merge": "control.thread",
  "thread.kill": "control.thread",
  "explore.search": "read.search",
  "explore.query.start": "read.search",
  "explore.query.plan": "read.search",
  "explore.query.views": "read.search",
  "explore.query.select": "read.search",
  "explore.query.followup": "read.search",
  "explore.query.finish": "read.search",
  "explore.query.cancel": "read.search",
  "explore.query.release": "read.search",
  "related.query": "read.search",
  "document.readSource": "read.document",
  "document.pathOverlay": "read.document",
  "document.writeGuard": "write.document",
  "document.branchWrite": "write.document",
  "workingBranch.ensureMaterialized": "write.document",
  "surface.snapshot.commit": "context.session",
  "surface.snapshot.release": "context.session",
} as const satisfies Record<HarnessMethod, HarnessCapability>;

/** Identity attached by the broker after it has pinned a worker to a session. */
export interface HarnessActorIdentity {
  authorityInstanceId: string;
  sessionId: string;
  runId?: string;
  /** Broker-pinned relative workspace paths for a restricted child Run. */
  workspaceScope?: readonly string[];
  workerId: string;
  workerGeneration: number;
}

/** Identity completed with workspace and frozen authority by the Host. */
export interface HarnessActorContext extends HarnessActorIdentity {
  workspaceId: string | null;
  workspaceScope?: readonly string[];
  grantedCapabilities: readonly HarnessCapability[];
}

const HARNESS_METHODS: ReadonlySet<string> = new Set<string>([
  "shell.exec",
  "shell.read",
  "shell.write",
  "shell.kill",
  "output.store",
  "output.read",
  "search.content",
  "lsp.diagnostics",
  "lsp.diagnosticsSnapshot",
  "lsp.symbols",
  "lsp.definition",
  "lsp.references",
  "lsp.hover",
  "fs.lock",
  "web.fetch",
  "web.search",
  "zone2.assemble",
  "compaction.before",
  "compaction.after",
  "todo.upsert",
  "recall.search",
  "knowledge.suggest",
  "memory.blocks.get",
  "memory.blocks.apply",
  "thread.dispatch",
  "thread.list",
  "thread.wait",
  "thread.send",
  "thread.read",
  "thread.merge",
  "thread.kill",
  "explore.search",
  "explore.query.start",
  "explore.query.plan",
  "explore.query.views",
  "explore.query.select",
  "explore.query.followup",
  "explore.query.finish",
  "explore.query.cancel",
  "explore.query.release",
  "related.query",
  "document.readSource",
  "document.pathOverlay",
  "document.writeGuard",
  "document.branchWrite",
  "workingBranch.ensureMaterialized",
  "surface.snapshot.commit",
  "surface.snapshot.release",
]);

export function isHarnessMethod(value: unknown): value is HarnessMethod {
  return typeof value === "string" && HARNESS_METHODS.has(value);
}

export type HarnessError = {
  code: "unavailable" | "timeout" | "invalid-params" | "not-found" | "expired" | "denied" | "forbidden" | "failed";
  message: string;
  retryable?: boolean;
};

export interface HarnessRequestData {
  requestId: string;
  method: HarnessMethod;
  params: unknown;
  /** Current immutable input source selected by SessionHost. */
  inputContext?: AgentInputContext;
  /**
   * How long the worker is prepared to wait, in milliseconds. The router
   * uses it instead of its own default so a deliberately long call such as
   * `thread.wait` is not aborted at the default 30s. Clamped by the router
   * to `HARNESS_MAX_REQUEST_TIMEOUT_MS`; absent means "use the default".
   */
  timeoutMs?: number;
}

/**
 * Upper bound the router applies to a worker-supplied `timeoutMs`. A worker
 * must not be able to pin a host handler open indefinitely.
 */
export const HARNESS_MAX_REQUEST_TIMEOUT_MS = 3_600_000;

export type HarnessRespondParams = {
  requestId: string;
  sessionId: string;
} & (
  | { ok: true; result: unknown }
  | { ok: false; error: HarnessError }
);

/**
 * Build the typed `harness.respond` params from a router outcome.
 * Callers pass this to `piRuntimeBroker.requestForSession(sessionId, 'harness.respond', params)`.
 */
export function buildHarnessRespondParams(
  sessionId: string,
  requestId: string,
  outcome: { ok: true; result: unknown } | { ok: false; error: HarnessError },
): HarnessRespondParams {
  if (outcome.ok) {
    return { requestId, sessionId, ok: true, result: outcome.result };
  }
  return { requestId, sessionId, ok: false, error: outcome.error };
}
