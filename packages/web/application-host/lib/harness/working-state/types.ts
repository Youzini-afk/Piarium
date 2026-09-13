import type { ThreadDiffStats } from "@piarium/protocol";
import type {
  RecoveryState,
  RegularFileState,
  SymlinkState,
  DirectoryState,
  MissingState,
  UnsupportedState,
} from "../../recovery/journal-files.js";
import type { WorkspaceRecoveryStorageContext } from "../../recovery/journal-engine.js";
import type { RecoveryIdentity, RecoveryFileStore } from "../../recovery/journal-files.js";

export interface WorkingStateRootContext {
  identity: RecoveryIdentity;
  root: string;
  fileStore: RecoveryFileStore;
  resourceOperationGate: { run<T>(resources: readonly unknown[], operation: () => Promise<T>): Promise<T> };
}

export type {
  RecoveryState,
  RegularFileState,
  SymlinkState,
  DirectoryState,
  MissingState,
  UnsupportedState,
};

export interface ContentObject {
  hash: string;
  bytes: Buffer;
  byteLength: number;
}

export interface WorkingBranch {
  branchId: string;
  workspaceId: string;
  baseRef?: string | undefined;
  baseState: Record<string, RecoveryState>;
  /** Paths whose effective base state was determined by unsaved surface drafts, including structural closure. */
  draftBasePaths: string[];
  /** Relative file or directory roots copied from harness.worktree.copyIgnored at launch. */
  captureScopes: string[];
  deltas: Record<string, RecoveryState>;
  headRevision: number;
  /** Monotonic CAS token for unpublished virtual writes (D-213). */
  writeRevision: number;
  createdAt: string;
  updatedAt: string;
}

/** Root identity and CAS metadata. Tree entries stay behind the asynchronous path/range API. */
export interface WorkingBranchRoot {
  branchId: string;
  workspaceId: string;
  baseRef?: string;
  baseRoot: string;
  root: string;
  headRevision: number;
  writeRevision: number;
  draftBasePaths: string[];
  captureScopes: string[];
  createdAt: string;
  updatedAt: string;
}

export type WorkingStatePathOrigin = "base" | "delta" | "draft-base";

export type WorkingStateContentSource =
  | { kind: "branch"; branchId: string; path: string; revision?: number }
  | { kind: "pin"; pinId: string; path: string };

export interface WorkingStateTreeEntry {
  path: string;
  state: RecoveryState;
  origin: WorkingStatePathOrigin;
  root?: string;
  viewRevision?: number;
  contentSource?: WorkingStateContentSource;
}

export interface WorkingStateTreeRead {
  branch: WorkingBranchRoot;
  /** The immutable/current root actually read. */
  root: string;
  /** Published revision for fixed reads; writeRevision for the current view. */
  viewRevision: number;
  entries: WorkingStateTreeEntry[];
}

export interface WorkingStateReadOptions {
  revision?: number;
  pin?: WorkingStatePinnedRoot;
  signal?: AbortSignal;
  deadlineAt?: number;
}

export interface WorkingStatePinnedRoot {
  pinId: string;
  branchId: string;
  workspaceId: string;
  revision: number;
  writeRevision: number;
  root: string;
  branch: WorkingBranchRoot;
}

export interface WorkingStatePin extends WorkingStatePinnedRoot {
  release(): Promise<void>;
}

/**
 * Branch roots and paths are asynchronous because the Rust kernel owns them.
 * Implementations must not retain an expanded workspace tree between operations.
 */
export interface WorkingStateRootStore {
  getBranchRoot(branchId: string, options?: { signal?: AbortSignal }): Promise<WorkingBranchRoot | null>;
  /** Read a published result by its immutable branch/revision identity. The returned state maps are
   * restricted to changedPaths; callers must use readStateSlice for any additional paths. */
  getResult(branchId: string, revision: number, options?: { signal?: AbortSignal }): Promise<WorkingResult | null>;
  readStateSlice(branchId: string, paths: readonly string[], options?: WorkingStateReadOptions): Promise<Record<string, RecoveryState> | null>;
  readPath(branchId: string, path: string, options?: WorkingStateReadOptions): Promise<WorkingStateTreeEntry | null>;
  listPaths(branchId: string, roots: readonly string[], options?: WorkingStateReadOptions): Promise<WorkingStateTreeRead | null>;
  readContent(entry: WorkingStateTreeEntry, options?: { offset?: number; length?: number; signal?: AbortSignal }): Promise<Buffer | null>;
  getObject(hash: string): Promise<Buffer | null>;
  pinBranch(branchId: string, options?: { revision?: number; signal?: AbortSignal }): Promise<WorkingStatePin>;
  putObject(bytes: Buffer): Promise<{ hash: string; byteLength: number }>;
  commitVirtualWrites(
    branchId: string,
    expectedWriteRevision: number,
    files: Record<string, RecoveryState>,
  ): Promise<{ status: "committed"; writeRevision: number; root?: string } | { status: "conflict"; writeRevision: number; root?: string }>;
  materializeResult(branchId: string, revision: number, directory: string): Promise<import("./materializer.js").MaterializeResult>;
  captureBranchCandidateIdentity(branchId: string, directory: string, changedPaths: string[]): Promise<string | null>;
  publishHeadResult(branchId: string): Promise<WorkingResult>;
  publishDirectoryResult(branchId: string, directory: string, changedPaths?: string[], options?: { indexModes?: Map<string, string> | Record<string, string>; validateFixedSource?: () => Promise<boolean> }): Promise<WorkingResult>;
}

export interface WorkspaceWorkingStateRootAccess {
  withBranchStore<T>(
    workspaceId: string,
    purpose: string,
    operation: (store: WorkingStateRootStore, context?: WorkingStateRootContext) => Promise<T> | T,
    mode?: "exclusive" | "shared",
    actor?: { sessionId: string; threadId?: string; runId?: string },
  ): Promise<T>;
}

export interface DraftBaselinePathProvenance {
  baseRevision: string | null;
  encoding: string;
  bom: boolean;
  localEditRevision: number;
  revision: string;
}

export interface DraftBaseline {
  id: string;
  workspaceId: string;
  createdAt: string;
  pathStates: Record<string, RecoveryState>;
  provenance: Record<string, DraftBaselinePathProvenance>;
}

export interface WorkingResult {
  resultRevision: number;
  branchId: string;
  parentRef?: string | undefined;
  changedPaths: string[];
  /** Fixed baseline states for every changed path. */
  baseStates: Record<string, RecoveryState>;
  /** Fixed result states for every changed path. */
  pathStates: Record<string, RecoveryState>;
  diffStats: ThreadDiffStats;
  createdAt: string;
  /** Rust-kernel root bound to resultRevision when the kernel is authoritative. */
  root?: string;
}

export type ThreeWayPathDecision =
  | "identical"
  | "apply-child"
  | "keep-parent"
  | "merge-clean"
  | "conflict";

export interface ThreeWayPathPlan {
  path: string;
  decision: ThreeWayPathDecision;
  baseState: RecoveryState;
  parentState: RecoveryState;
  childState: RecoveryState;
  mergedText?: string;
  mergedMode?: number;
  conflictMarkers?: string;
  conflictReason?: string;
  isText: boolean;
}

export interface ThreeWayMergePlan {
  operationId: string;
  workspaceId: string;
  threadId: string;
  resultRevision: number | string;
  clean: boolean;
  paths: ThreeWayPathPlan[];
  appliedPaths: string[];
  conflictPaths: string[];
  diffStats: ThreadDiffStats;
}

export type CommandInputRelation =
  | "same-run-matching-result"
  | "post-merge-matching-tree"
  | "unbound"
  | "uncertain";

export interface VerificationActorIdentity {
  authorityInstanceId: string;
  sessionId: string;
  workerId: string;
  workerGeneration: number;
  runId?: string;
}

export interface CommandVerificationRecord {
  id: string;
  runId: string;
  command: string;
  cwd: string;
  envSummary?: { PATH?: boolean; VIRTUAL_ENV?: string };
  commandRunId?: string;
  startedAt: number;
  endedAt: number;
  exitCode: number | null;
  cancelled: boolean;
  outputHandle?: string;
  outputPreview?: string;
  actor: VerificationActorIdentity;
  bindingGeneration: number;
  inputIdentity: {
    kind: "tree" | "unbound";
    branchId?: string;
    root?: string;
    startTreeHash?: string;
    endTreeHash?: string;
    reason?: string;
  };
  inputChangedDuringRun: boolean | null;
  relationToPublished: CommandInputRelation;
}

export interface ResultVerificationBundle {
  resultRevision: number;
  branchId: string;
  resultTreeHash?: string;
  recordedAt: number;
  binding: "bound" | "uncertain";
  bindingReason?: string;
  checks: CommandVerificationRecord[];
}

export interface ParentVerificationBundle {
  mergedResultRevision: number;
  mergeOperationId?: string;
  parentTreeHash?: string;
  windowOpenedAt?: number;
  recordedAt: number;
  draftUnsaved: boolean;
  note?: string;
  binding: "bound" | "uncertain" | "cannot-verify-unsaved-draft" | "not-recorded" | "not-integrated";
  checks: CommandVerificationRecord[];
}

export interface ResultReviewRecord {
  resultRevision: number;
  status: "running" | "completed" | "failed" | "cancelled";
  recordedAt: number;
  reviewThreadId?: string;
  reviewRunId?: string;
  gate?: boolean;
  conclusion?: string;
  findings?: Array<{ severity: string; file?: string; line?: number; message: string }>;
  error?: string;
}

export interface WorkingStateVerifications {
  child: Record<string, ResultVerificationBundle[]>;
  parent: Record<string, ParentVerificationBundle[]>;
  reviews: Record<string, ResultReviewRecord[]>;
}

export interface IntegrationApplyResult {
  operationId: string;
  status: "applied" | "conflict" | "compensated" | "needs-attention";
  appliedPaths: string[];
  conflictPaths: string[];
  /** Draft-derived paths that require reconciliation with the originating editor surface. */
  surfaceTargetPaths?: string[];
  preview?: import("@piarium/protocol").ThreadIntegrationPreview;
  compensatedPaths?: string[];
  needsAttentionPaths?: string[];
  diffStats: ThreadDiffStats;
  text: string;
}
