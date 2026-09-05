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
  deltas: Record<string, RecoveryState>;
  headRevision: number;
  createdAt: string;
  updatedAt: string;
}

export interface WorkingResult {
  resultRevision: number;
  branchId: string;
  parentRef?: string | undefined;
  changedPaths: string[];
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
  compensatedPaths?: string[];
  needsAttentionPaths?: string[];
  diffStats: ThreadDiffStats;
  text: string;
}
