/** User-facing history management; these actions are not Agent tools. */
export type ThreadResultRetentionReason =
  | "branch-head"
  | "current-result"
  | "run-input"
  | "review"
  | "integration";

export interface ThreadResultHistoryEntry {
  resultRevision: number;
  createdAt: string;
  changedPaths: string[];
  /** Unique logical content bytes referenced by this version, including shared objects. */
  retainedBytes: number;
  protectedReasons: ThreadResultRetentionReason[];
}

export interface ThreadResultHistory {
  workspaceId: string;
  threadId: string;
  branchId: string | null;
  results: ThreadResultHistoryEntry[];
}

export interface ThreadResultHistoryReleaseParams {
  /** Must still be the Thread's working branch when release is committed. */
  branchId: string;
  resultRevisions: number[];
}

export interface ThreadResultHistoryReleaseResult {
  releasedRevisions: number[];
  /** Missing is an idempotent no-op, not proof that the version once existed. */
  missingRevisions: number[];
  cleanup:
    | { status: "complete"; objectsDeleted: number; byteLengthReclaimed: number }
    | { status: "failed"; message: string };
}
