import type { ThreadDiffStats } from "@piarium/protocol";
import type {
  RecoveryState,
  RegularFileState,
  SymlinkState,
  DirectoryState,
  MissingState,
  UnsupportedState,
} from "../../recovery/journal-files.js";

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
  createdAt: string;
  updatedAt: string;
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

export interface IntegrationApplyResult {
  operationId: string;
  status: "applied" | "conflict" | "compensated" | "needs-attention";
  appliedPaths: string[];
  conflictPaths: string[];
  /** Draft-derived paths that require reconciliation with the originating editor surface. */
  surfaceTargetPaths?: string[];
  compensatedPaths?: string[];
  needsAttentionPaths?: string[];
  diffStats: ThreadDiffStats;
  text: string;
}
