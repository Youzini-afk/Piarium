import {
  PIARIUM_WORKSPACE_RECOVERY_SERVICE_ID,
  PIARIUM_WORKSPACE_RECOVERY_SERVICE_VERSION,
} from "./services.js";
import type {
  JsonObject,
  JsonValue,
  PiariumExtensionServiceInvocationRequest,
} from "./types.js";

export const PIARIUM_WORKSPACE_RECOVERY_CONTRACT_VERSION = 2 as const;

export type WorkspaceRecoverySnapshotConsistency =
  | "point-in-time"
  | "validated"
  | "unstable"
  | "incomplete";

export type WorkspaceRecoverySnapshotAvailability =
  | "ready"
  | "incomplete"
  | "missing"
  | "malformed"
  | "corrupt";

export type WorkspaceRecoveryCoverageState =
  | "present"
  | "known-absent"
  | "excluded-unknown"
  | "unstable";

export type WorkspaceRecoveryManifestEntryKind =
  | "regular-file"
  | "directory"
  | "symlink"
  | "excluded"
  | "unsupported";

export type WorkspaceRecoverySnapshotSource =
  | "baseline"
  | "turn-before"
  | "turn-after"
  | "manual"
  | "safety"
  | "restore";

export type WorkspaceRecoveryFailureCode =
  | "invalid-request"
  | "workspace-not-found"
  | "workspace-untrusted"
  | "snapshot-unavailable"
  | "snapshot-missing"
  | "snapshot-malformed"
  | "snapshot-incomplete"
  | "snapshot-corrupt"
  | "object-missing"
  | "object-corrupt"
  | "storage-malformed"
  | "storage-move-failed"
  | "operation-not-found"
  | "stale-plan"
  | "unstable-coverage"
  | "dirty-buffers"
  | "active-writer"
  | "insufficient-space"
  | "locked-path"
  | "unsupported-metadata"
  | "navigation-conflict"
  | "recovery-in-progress"
  | "needs-attention"
  | "unavailable"
  | "internal";

export interface WorkspaceRecoveryFailure {
  code: WorkspaceRecoveryFailureCode;
  details?: JsonObject;
  message: string;
  operationId?: string;
  retryable: boolean;
}

export interface WorkspaceRecoveryIdentity {
  authorityId: string;
  canonicalRoot: string;
  filesystemProfile: string;
  workspaceId: string;
}

export interface WorkspaceRecoveryCoverageIssue {
  path: string;
  reason: string;
  state: Exclude<WorkspaceRecoveryCoverageState, "present" | "known-absent">;
}

export interface WorkspaceRecoverySnapshotCoverage {
  excludedUnknown: number;
  issues: WorkspaceRecoveryCoverageIssue[];
  knownAbsent: number;
  present: number;
  unstable: number;
}

export interface WorkspaceRecoverySnapshotSummary {
  availability: WorkspaceRecoverySnapshotAvailability;
  byteLength: number;
  consistency: WorkspaceRecoverySnapshotConsistency;
  coverage: WorkspaceRecoverySnapshotCoverage;
  createdAt: string;
  entryCount: number;
  id: string;
  label?: string;
  manifestHash: string;
  parentSnapshotId: string | null;
  policyRevision: string;
  restoredFrom?: string;
  sequence: number;
  source: WorkspaceRecoverySnapshotSource;
  workspaceId: string;
}

export interface WorkspaceRecoveryManifestEntry {
  byteLength?: number;
  comparisonKey: string;
  coverage: WorkspaceRecoveryCoverageState;
  executable?: boolean;
  kind: WorkspaceRecoveryManifestEntryKind;
  mode?: number;
  objectHash?: string;
  path: string;
  platformMetadata?: JsonObject;
  readonly?: boolean;
  reason?: string;
  symlinkTarget?: string;
}

export interface WorkspaceRecoverySnapshotManifest {
  entries: WorkspaceRecoveryManifestEntry[];
  manifestHash: string;
  nextCursor: string | null;
  snapshot: WorkspaceRecoverySnapshotSummary;
}

export interface WorkspaceRecoveryCaptureInput {
  label?: string;
  reuseIfUnchanged?: boolean;
  source?: WorkspaceRecoverySnapshotSource;
  workspaceId: string;
}

export interface WorkspaceRecoveryCaptureWitness {
  epoch: number;
  mutationRevision: number;
  writerRevision: number;
}

export type WorkspaceRecoveryTurnProvenance = "caused-by" | "observed-during" | "overlapped";

export interface WorkspaceRecoveryTurnStartInput {
  activeWriterScopes: string[];
  beforeSnapshotId?: string;
  executionId: string;
  failure?: WorkspaceRecoveryFailure;
  provenance: WorkspaceRecoveryTurnProvenance;
  runtimeGeneration: number;
  sessionId: string;
  userEntryId: string;
  workerId: string;
  workspaceId: string;
}

export interface WorkspaceRecoveryTurnSettledInput {
  activeWriterScopes: string[];
  afterSnapshotId?: string;
  assistantEntryId?: string;
  executionId: string;
  failure?: WorkspaceRecoveryFailure;
  provenance: WorkspaceRecoveryTurnProvenance;
  workspaceId: string;
}

export interface WorkspaceRecoveryTurnBinding {
  activeWriterScopes: string[];
  afterSnapshotId?: string;
  assistantEntryId?: string;
  beforeSnapshotId?: string;
  executionId: string;
  failure?: WorkspaceRecoveryFailure;
  provenance: WorkspaceRecoveryTurnProvenance;
  runtimeGeneration: number;
  runtimeKey: string;
  sessionId: string;
  settledAt?: string;
  startedAt: string;
  status: "pending" | "ready" | "incomplete";
  userEntryId: string;
  workerId: string;
  workspaceId: string;
}

export interface WorkspaceRecoveryEntryTarget {
  entryId: string;
  sessionId: string;
  workspaceId: string;
}

export type WorkspaceRecoveryEntryBindingResult =
  | {
      binding: WorkspaceRecoveryTurnBinding;
      position: "before" | "after";
      snapshotId: string;
      status: "ready";
    }
  | {
      binding?: WorkspaceRecoveryTurnBinding;
      reason: "entry-unbound" | "session-unbound" | "snapshot-incomplete";
      status: "unbound" | "incomplete";
    }
  | WorkspaceRecoveryFailedResult;

export interface WorkspaceRecoveryCheckpointInput {
  name: string;
  workspaceId: string;
}

export type WorkspaceRestoreMode = "in-place" | "new-workspace";

export type WorkspaceRestoreOperationState =
  | "planned"
  | "staged"
  | "commit-decided"
  | "applying-workspace"
  | "workspace-verified"
  | "completion-decided"
  | "compensating-workspace"
  | "compensated"
  | "complete"
  | "aborted"
  | "needs-attention";

export interface WorkspaceRestoreConflict {
  code: WorkspaceRecoveryFailureCode;
  message: string;
  path?: string;
}

export interface WorkspaceRestoreFileOperation {
  byteLength?: number;
  kind?: WorkspaceRecoveryManifestEntryKind;
  objectHash?: string;
  path: string;
  type: "write" | "delete" | "mkdir" | "symlink" | "metadata";
}

export interface WorkspaceRestoreGitState {
  available: boolean;
  operation?: string;
  repository: boolean;
  staged: boolean;
}

export interface WorkspaceRestorePlan {
  activeWriterScopes: string[];
  allowedModes: WorkspaceRestoreMode[];
  conflicts: WorkspaceRestoreConflict[];
  createdAt: string;
  dirtyBufferCount: number;
  git: WorkspaceRestoreGitState;
  id: string;
  newWorkspacePath: string;
  operationCount: number;
  operations: WorkspaceRestoreFileOperation[];
  recommendedMode: WorkspaceRestoreMode;
  revision: string;
  safetySnapshotId: string;
  targetSnapshotId: string;
  totalBytes: number;
  witness: WorkspaceRecoveryCaptureWitness;
  workspaceId: string;
}

export interface WorkspaceRestorePrepareInput {
  newWorkspacePath?: string;
  targetSnapshotId: string;
  workspaceId: string;
}

export interface WorkspaceRestoreApplyInput {
  expectedRevision: string;
  mode: WorkspaceRestoreMode;
  newWorkspacePath?: string;
  operationId: string;
}

export interface WorkspaceRestoreOperation {
  appliedOperations: number;
  compensatedSnapshotId?: string;
  completionHold?: "conversation";
  createdAt: string;
  destinationPath: string;
  failure?: WorkspaceRecoveryFailure;
  id: string;
  mode?: WorkspaceRestoreMode;
  planRevision: string;
  safetySnapshotId: string;
  state: WorkspaceRestoreOperationState;
  restoredSnapshotId?: string;
  targetSnapshotId: string;
  totalOperations: number;
  updatedAt: string;
  workspaceId: string;
}

export interface WorkspaceRecoveryEditorImage {
  data: string;
  mimeType: string;
}

export interface WorkspaceCombinedRecoveryPrepareInput {
  entryId: string;
  newWorkspacePath?: string;
  sessionId: string;
  workspaceId: string;
}

export interface WorkspaceCombinedRecoveryPlan {
  allowedModes: WorkspaceRestoreMode[];
  createdAt: string;
  entryId: string;
  expectedLeafId: string | null;
  id: string;
  navigationKind: "entry" | "leaf";
  restore: WorkspaceRestorePlan;
  revision: string;
  sessionId: string;
  targetLeafId: string | null;
  targetSnapshotId: string;
  undoOf?: string;
  workspaceId: string;
}

export interface WorkspaceCombinedRecoveryApplyInput {
  expectedRevision: string;
  mode: WorkspaceRestoreMode;
  newWorkspacePath?: string;
  operationId: string;
}

export type WorkspaceCombinedRecoveryOperationState =
  | "planned"
  | "applying-workspace"
  | "workspace-verified"
  | "navigating-conversation"
  | "compensating-workspace"
  | "compensated"
  | "alternate-ready"
  | "complete"
  | "aborted"
  | "needs-attention";

export interface WorkspaceCombinedRecoveryOperation {
  conversationState: "unchanged" | "navigated" | "diverged";
  createdAt: string;
  destinationPath?: string;
  editorImages?: WorkspaceRecoveryEditorImage[];
  editorText?: string;
  entryId: string;
  expectedLeafId: string | null;
  failure?: WorkspaceRecoveryFailure;
  id: string;
  mode?: WorkspaceRestoreMode;
  navigationMarkerId?: string;
  restoreOperationId: string;
  revision: string;
  sessionId: string;
  state: WorkspaceCombinedRecoveryOperationState;
  targetLeafId: string | null;
  targetSnapshotId: string;
  undoOf?: string;
  updatedAt: string;
  workspaceId: string;
  workspaceAppliedOperations?: number;
  workspaceState: "unchanged" | "restored" | "compensated" | "materialized-new" | "needs-attention";
  workspaceTotalOperations?: number;
}

export interface WorkspaceRecoverySnapshotQuery {
  cursor?: number;
  limit?: number;
  workspaceId: string;
}

export interface WorkspaceRecoverySnapshotPage {
  nextCursor: number | null;
  snapshots: WorkspaceRecoverySnapshotSummary[];
}

export interface WorkspaceRecoverySnapshotReadInput {
  entryCursor?: string;
  entryLimit?: number;
  snapshotId: string;
  workspaceId: string;
}

export interface WorkspaceRecoverySnapshotDiffInput {
  afterSnapshotId: string;
  beforeSnapshotId: string;
  cursor?: string;
  limit?: number;
  workspaceId: string;
}

export interface WorkspaceRecoverySnapshotDiffEntry {
  after?: WorkspaceRecoveryManifestEntry;
  before?: WorkspaceRecoveryManifestEntry;
  path: string;
  type: "added" | "modified" | "removed";
}

export interface WorkspaceRecoverySnapshotDiff {
  afterSnapshotId: string;
  beforeSnapshotId: string;
  changes: WorkspaceRecoverySnapshotDiffEntry[];
  nextCursor: string | null;
  workspaceId: string;
}

export type RecoveryStorageMode =
  | "application-data"
  | "workspace-local"
  | "workspace-adjacent"
  | "custom";

export type RecoveryStorageLocation =
  | { mode: Exclude<RecoveryStorageMode, "custom"> }
  | { customRoot: string; mode: "custom" };

export interface RecoveryStorageStatus {
  authorityId: string;
  byteLength: number;
  encryption: { available: boolean; enabled: boolean };
  location: RecoveryStorageLocation;
  locationSource: "global" | "workspace";
  objectCount: number;
  readySnapshotCount: number;
  registryRevision: number;
  snapshotCount: number;
  state: "missing" | "ready" | "incomplete" | "malformed" | "corrupt";
  workspaceId?: string;
}

export interface SetRecoveryStorageLocationInput {
  location: RecoveryStorageLocation;
  workspaceId: string;
}

export interface RecoveryStorageWorkspaceSummary {
  byteLength: number;
  canonicalRoot: string;
  failure?: WorkspaceRecoveryFailure;
  lastActivityAt: string | null;
  location: RecoveryStorageLocation;
  locationSource: "global" | "workspace";
  migrationRequired: boolean;
  objectCount: number;
  snapshotCount: number;
  state: RecoveryStorageStatus["state"] | "unavailable";
  storageAvailable: boolean;
  workspaceAvailable: boolean;
  workspaceId: string;
}

export type RecoveryStorageMoveState =
  | "copying"
  | "verifying"
  | "switching"
  | "complete"
  | "failed";

export interface RecoveryStorageMoveOperation {
  byteLength: number;
  failure?: WorkspaceRecoveryFailure;
  from: RecoveryStorageLocation;
  id: string;
  startedAt: string;
  state: RecoveryStorageMoveState;
  to: RecoveryStorageLocation;
  updatedAt: string;
  workspaceId: string;
}

export interface RecoveryStorageCleanupInput {
  workspaceId: string;
}

export interface RecoveryStorageCleanupResult {
  byteLengthReclaimed: number;
  failures: WorkspaceRecoveryFailure[];
  manifestsDeleted: number;
  objectsDeleted: number;
  operationId: string;
  retainedPins: number;
  status: "complete" | "failed";
  workspaceId: string;
}

export interface WorkspaceRecoveryStatus {
  capabilities: {
    bindings: boolean;
    capture: boolean;
    checkpoints: boolean;
    combined: boolean;
    diff: boolean;
    read: boolean;
    restore: boolean;
    storageManagement: boolean;
  };
  identity: WorkspaceRecoveryIdentity;
  status: "ready";
  storage: RecoveryStorageStatus;
}

export interface WorkspaceRecoveryFailedResult {
  failure: WorkspaceRecoveryFailure;
  status: "failed";
}

export type WorkspaceRecoveryCaptureResult =
  | {
      reused: boolean;
      snapshot: WorkspaceRecoverySnapshotSummary;
      status: "captured";
      witness: WorkspaceRecoveryCaptureWitness;
    }
  | WorkspaceRecoveryFailedResult;

export type WorkspaceRecoveryTurnBindingResult =
  | { binding: WorkspaceRecoveryTurnBinding; status: "ready" }
  | WorkspaceRecoveryFailedResult;

export type WorkspaceRestorePrepareResult =
  | { plan: WorkspaceRestorePlan; status: "ready" }
  | WorkspaceRecoveryFailedResult;

export type WorkspaceRestoreOperationResult =
  | { operation: WorkspaceRestoreOperation; status: "ready" }
  | WorkspaceRecoveryFailedResult;

export type WorkspaceCombinedRecoveryPrepareResult =
  | { plan: WorkspaceCombinedRecoveryPlan; status: "ready" }
  | WorkspaceRecoveryFailedResult;

export type WorkspaceCombinedRecoveryOperationResult =
  | { operation: WorkspaceCombinedRecoveryOperation; status: "ready" }
  | WorkspaceRecoveryFailedResult;

export type WorkspaceCombinedRecoveryListResult =
  | { operations: WorkspaceCombinedRecoveryOperation[]; status: "ready" }
  | WorkspaceRecoveryFailedResult;

export type WorkspaceRecoveryListResult =
  | { page: WorkspaceRecoverySnapshotPage; status: "ready" }
  | WorkspaceRecoveryFailedResult;

export type WorkspaceRecoveryReadResult =
  | { manifest: WorkspaceRecoverySnapshotManifest; status: "ready" | "incomplete" }
  | { failure: WorkspaceRecoveryFailure; snapshotId: string; status: "missing" | "malformed" | "corrupt" }
  | WorkspaceRecoveryFailedResult;

export type WorkspaceRecoveryDiffResult =
  | { diff: WorkspaceRecoverySnapshotDiff; status: "ready" }
  | WorkspaceRecoveryFailedResult;

export type WorkspaceRecoveryStatusResult = WorkspaceRecoveryStatus | WorkspaceRecoveryFailedResult;
export type RecoveryStorageStatusResult =
  | { status: "ready"; storage: RecoveryStorageStatus }
  | WorkspaceRecoveryFailedResult;
export type RecoveryStorageMoveResult =
  | { operation: RecoveryStorageMoveOperation; status: "ready" }
  | WorkspaceRecoveryFailedResult;
export type RecoveryStorageCleanupOperationResult =
  | { result: RecoveryStorageCleanupResult; status: "ready" }
  | WorkspaceRecoveryFailedResult;
export type RecoveryStorageWorkspaceListResult =
  | { status: "ready"; workspaces: RecoveryStorageWorkspaceSummary[] }
  | WorkspaceRecoveryFailedResult;

export class WorkspaceRecoveryContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceRecoveryContractError";
  }
}

const record = (value: unknown, label: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WorkspaceRecoveryContractError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
};

const text = (value: unknown, label: string): string => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new WorkspaceRecoveryContractError(`${label} must be a non-empty string`);
  }
  return value;
};

const plainText = (value: unknown, label: string): string => {
  if (typeof value !== "string") throw new WorkspaceRecoveryContractError(`${label} must be a string`);
  return value;
};

const optionalText = (value: unknown, label: string): string | undefined => (
  value === undefined ? undefined : text(value, label)
);

const nullableText = (value: unknown, label: string): string | null => (
  value === null ? null : text(value, label)
);

const contentHash = (value: unknown, label: string): string => {
  const parsed = text(value, label);
  if (!/^sha256-[0-9a-f]{64}$/.test(parsed)) {
    throw new WorkspaceRecoveryContractError(`${label} must be a SHA-256 content hash`);
  }
  return parsed;
};

const portablePath = (value: unknown, label: string): string => {
  const parsed = text(value, label);
  if (parsed === ".") return parsed;
  if (parsed.includes("\\") || parsed.includes("\0") || parsed.startsWith("/")
    || /^[A-Za-z]:/.test(parsed)
    || parsed.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
    throw new WorkspaceRecoveryContractError(`${label} must be a normalized workspace-relative path`);
  }
  return parsed;
};

const count = (value: unknown, label: string): number => {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new WorkspaceRecoveryContractError(`${label} must be a non-negative safe integer`);
  }
  return Number(value);
};

const positive = (value: unknown, label: string): number => {
  const parsed = count(value, label);
  if (parsed === 0) throw new WorkspaceRecoveryContractError(`${label} must be positive`);
  return parsed;
};

const isoTimestamp = (value: unknown, label: string): string => {
  const parsed = text(value, label);
  if (!Number.isFinite(Date.parse(parsed))) throw new WorkspaceRecoveryContractError(`${label} must be an ISO timestamp`);
  return parsed;
};

const jsonObject = (value: unknown, label: string): JsonObject => {
  const raw = record(value, label);
  try {
    return JSON.parse(JSON.stringify(raw)) as JsonObject;
  } catch {
    throw new WorkspaceRecoveryContractError(`${label} must be JSON-safe`);
  }
};

const oneOf = <T extends string>(value: unknown, values: readonly T[], label: string): T => {
  if (typeof value !== "string" || !values.includes(value as T)) {
    throw new WorkspaceRecoveryContractError(`${label} is unsupported`);
  }
  return value as T;
};

const CONSISTENCIES = ["point-in-time", "validated", "unstable", "incomplete"] as const;
const AVAILABILITIES = ["ready", "incomplete", "missing", "malformed", "corrupt"] as const;
const COVERAGE_STATES = ["present", "known-absent", "excluded-unknown", "unstable"] as const;
const ENTRY_KINDS = ["regular-file", "directory", "symlink", "excluded", "unsupported"] as const;
const SOURCES = ["baseline", "turn-before", "turn-after", "manual", "safety", "restore"] as const;
const FAILURE_CODES: readonly WorkspaceRecoveryFailureCode[] = [
  "invalid-request", "workspace-not-found", "workspace-untrusted", "snapshot-unavailable",
  "snapshot-missing", "snapshot-malformed", "snapshot-incomplete", "snapshot-corrupt",
  "object-missing", "object-corrupt", "storage-malformed", "storage-move-failed",
  "operation-not-found", "stale-plan", "unstable-coverage", "dirty-buffers", "active-writer",
  "insufficient-space", "locked-path", "unsupported-metadata", "navigation-conflict",
  "recovery-in-progress", "needs-attention", "unavailable", "internal",
];
const TURN_PROVENANCE = ["caused-by", "observed-during", "overlapped"] as const;

export const parseWorkspaceRecoveryFailure = (value: unknown): WorkspaceRecoveryFailure => {
  const raw = record(value, "Workspace recovery failure");
  if (typeof raw.retryable !== "boolean") throw new WorkspaceRecoveryContractError("failure.retryable must be boolean");
  return {
    code: oneOf(raw.code, FAILURE_CODES, "failure.code"),
    message: text(raw.message, "failure.message"),
    retryable: raw.retryable,
    ...(raw.details === undefined ? {} : { details: jsonObject(raw.details, "failure.details") }),
    ...(optionalText(raw.operationId, "failure.operationId") ? { operationId: raw.operationId as string } : {}),
  };
};

export const parseWorkspaceRecoveryIdentity = (value: unknown): WorkspaceRecoveryIdentity => {
  const raw = record(value, "Workspace recovery identity");
  return {
    authorityId: text(raw.authorityId, "identity.authorityId"),
    canonicalRoot: text(raw.canonicalRoot, "identity.canonicalRoot"),
    filesystemProfile: text(raw.filesystemProfile, "identity.filesystemProfile"),
    workspaceId: text(raw.workspaceId, "identity.workspaceId"),
  };
};

export const parseWorkspaceRecoverySnapshotCoverage = (value: unknown): WorkspaceRecoverySnapshotCoverage => {
  const raw = record(value, "Snapshot coverage");
  if (!Array.isArray(raw.issues)) throw new WorkspaceRecoveryContractError("coverage.issues must be an array");
  return {
    excludedUnknown: count(raw.excludedUnknown, "coverage.excludedUnknown"),
    issues: raw.issues.map((item, index) => {
      const issue = record(item, `coverage.issues[${index}]`);
      return {
        path: portablePath(issue.path, `coverage.issues[${index}].path`),
        reason: text(issue.reason, `coverage.issues[${index}].reason`),
        state: oneOf(issue.state, ["excluded-unknown", "unstable"] as const, `coverage.issues[${index}].state`),
      };
    }),
    knownAbsent: count(raw.knownAbsent, "coverage.knownAbsent"),
    present: count(raw.present, "coverage.present"),
    unstable: count(raw.unstable, "coverage.unstable"),
  };
};

export const parseWorkspaceRecoverySnapshotSummary = (value: unknown): WorkspaceRecoverySnapshotSummary => {
  const raw = record(value, "Workspace snapshot summary");
  const parentSnapshotId = raw.parentSnapshotId === null ? null : text(raw.parentSnapshotId, "snapshot.parentSnapshotId");
  return {
    availability: oneOf(raw.availability, AVAILABILITIES, "snapshot.availability"),
    byteLength: count(raw.byteLength, "snapshot.byteLength"),
    consistency: oneOf(raw.consistency, CONSISTENCIES, "snapshot.consistency"),
    coverage: parseWorkspaceRecoverySnapshotCoverage(raw.coverage),
    createdAt: isoTimestamp(raw.createdAt, "snapshot.createdAt"),
    entryCount: count(raw.entryCount, "snapshot.entryCount"),
    id: text(raw.id, "snapshot.id"),
    manifestHash: contentHash(raw.manifestHash, "snapshot.manifestHash"),
    parentSnapshotId,
    policyRevision: text(raw.policyRevision, "snapshot.policyRevision"),
    sequence: positive(raw.sequence, "snapshot.sequence"),
    source: oneOf(raw.source, SOURCES, "snapshot.source"),
    workspaceId: text(raw.workspaceId, "snapshot.workspaceId"),
    ...(optionalText(raw.label, "snapshot.label") ? { label: raw.label as string } : {}),
    ...(optionalText(raw.restoredFrom, "snapshot.restoredFrom") ? { restoredFrom: raw.restoredFrom as string } : {}),
  };
};

export const parseWorkspaceRecoveryManifestEntry = (value: unknown): WorkspaceRecoveryManifestEntry => {
  const raw = record(value, "Workspace recovery manifest entry");
  const result: WorkspaceRecoveryManifestEntry = {
    comparisonKey: text(raw.comparisonKey, "entry.comparisonKey"),
    coverage: oneOf(raw.coverage, COVERAGE_STATES, "entry.coverage"),
    kind: oneOf(raw.kind, ENTRY_KINDS, "entry.kind"),
    path: portablePath(raw.path, "entry.path"),
  };
  if (raw.byteLength !== undefined) result.byteLength = count(raw.byteLength, "entry.byteLength");
  if (raw.mode !== undefined) result.mode = count(raw.mode, "entry.mode");
  for (const key of ["executable", "readonly"] as const) {
    if (raw[key] !== undefined) {
      if (typeof raw[key] !== "boolean") throw new WorkspaceRecoveryContractError(`entry.${key} must be boolean`);
      result[key] = raw[key];
    }
  }
  const objectHash = raw.objectHash === undefined ? undefined : contentHash(raw.objectHash, "entry.objectHash");
  const reason = optionalText(raw.reason, "entry.reason");
  const symlinkTarget = optionalText(raw.symlinkTarget, "entry.symlinkTarget");
  if (objectHash) result.objectHash = objectHash;
  if (reason) result.reason = reason;
  if (symlinkTarget) result.symlinkTarget = symlinkTarget;
  if (raw.platformMetadata !== undefined) result.platformMetadata = jsonObject(raw.platformMetadata, "entry.platformMetadata");
  if (result.kind === "regular-file" && result.coverage === "present" && !result.objectHash) {
    throw new WorkspaceRecoveryContractError("present regular-file entries require objectHash");
  }
  if (result.kind === "symlink" && result.coverage === "present" && result.symlinkTarget === undefined) {
    throw new WorkspaceRecoveryContractError("present symlink entries require symlinkTarget");
  }
  return result;
};

export const parseWorkspaceRecoverySnapshotManifest = (value: unknown): WorkspaceRecoverySnapshotManifest => {
  const raw = record(value, "Workspace snapshot manifest");
  if (!Array.isArray(raw.entries)) throw new WorkspaceRecoveryContractError("manifest.entries must be an array");
  const snapshot = parseWorkspaceRecoverySnapshotSummary(raw.snapshot);
  const manifestHash = contentHash(raw.manifestHash, "manifest.manifestHash");
  if (manifestHash !== snapshot.manifestHash) throw new WorkspaceRecoveryContractError("manifestHash must match snapshot.manifestHash");
  return {
    entries: raw.entries.map(parseWorkspaceRecoveryManifestEntry),
    manifestHash,
    nextCursor: raw.nextCursor === null ? null : text(raw.nextCursor, "manifest.nextCursor"),
    snapshot,
  };
};

export const parseWorkspaceRecoveryCaptureInput = (value: unknown): WorkspaceRecoveryCaptureInput => {
  const raw = record(value, "Workspace recovery capture input");
  if (raw.reuseIfUnchanged !== undefined && typeof raw.reuseIfUnchanged !== "boolean") {
    throw new WorkspaceRecoveryContractError("capture.reuseIfUnchanged must be boolean");
  }
  return {
    workspaceId: text(raw.workspaceId, "capture.workspaceId"),
    ...(optionalText(raw.label, "capture.label") ? { label: raw.label as string } : {}),
    ...(raw.reuseIfUnchanged === undefined ? {} : { reuseIfUnchanged: raw.reuseIfUnchanged }),
    ...(raw.source === undefined ? {} : { source: oneOf(raw.source, SOURCES, "capture.source") }),
  };
};

export const parseWorkspaceRecoveryCaptureWitness = (value: unknown): WorkspaceRecoveryCaptureWitness => {
  const raw = record(value, "Workspace recovery capture witness");
  return {
    epoch: positive(raw.epoch, "witness.epoch"),
    mutationRevision: positive(raw.mutationRevision, "witness.mutationRevision"),
    writerRevision: positive(raw.writerRevision, "witness.writerRevision"),
  };
};

const writerScopes = (value: unknown, label: string): string[] => {
  if (!Array.isArray(value)) throw new WorkspaceRecoveryContractError(`${label} must be an array`);
  return [...new Set(value.map((item, index) => text(item, `${label}[${index}]`)))].sort();
};

export const parseWorkspaceRecoveryTurnStartInput = (value: unknown): WorkspaceRecoveryTurnStartInput => {
  const raw = record(value, "Workspace recovery turn start");
  return {
    activeWriterScopes: writerScopes(raw.activeWriterScopes, "turn.activeWriterScopes"),
    executionId: text(raw.executionId, "turn.executionId"),
    provenance: oneOf(raw.provenance, TURN_PROVENANCE, "turn.provenance"),
    runtimeGeneration: positive(raw.runtimeGeneration, "turn.runtimeGeneration"),
    sessionId: text(raw.sessionId, "turn.sessionId"),
    userEntryId: text(raw.userEntryId, "turn.userEntryId"),
    workerId: text(raw.workerId, "turn.workerId"),
    workspaceId: text(raw.workspaceId, "turn.workspaceId"),
    ...(optionalText(raw.beforeSnapshotId, "turn.beforeSnapshotId")
      ? { beforeSnapshotId: raw.beforeSnapshotId as string }
      : {}),
    ...(raw.failure === undefined ? {} : { failure: parseWorkspaceRecoveryFailure(raw.failure) }),
  };
};

export const parseWorkspaceRecoveryTurnSettledInput = (value: unknown): WorkspaceRecoveryTurnSettledInput => {
  const raw = record(value, "Workspace recovery turn settled");
  return {
    activeWriterScopes: writerScopes(raw.activeWriterScopes, "turn.activeWriterScopes"),
    executionId: text(raw.executionId, "turn.executionId"),
    provenance: oneOf(raw.provenance, TURN_PROVENANCE, "turn.provenance"),
    workspaceId: text(raw.workspaceId, "turn.workspaceId"),
    ...(optionalText(raw.afterSnapshotId, "turn.afterSnapshotId")
      ? { afterSnapshotId: raw.afterSnapshotId as string }
      : {}),
    ...(optionalText(raw.assistantEntryId, "turn.assistantEntryId")
      ? { assistantEntryId: raw.assistantEntryId as string }
      : {}),
    ...(raw.failure === undefined ? {} : { failure: parseWorkspaceRecoveryFailure(raw.failure) }),
  };
};

export const parseWorkspaceRecoveryEntryTarget = (value: unknown): WorkspaceRecoveryEntryTarget => {
  const raw = record(value, "Workspace recovery entry target");
  return {
    entryId: text(raw.entryId, "target.entryId"),
    sessionId: text(raw.sessionId, "target.sessionId"),
    workspaceId: text(raw.workspaceId, "target.workspaceId"),
  };
};

export const parseWorkspaceRecoveryCheckpointInput = (value: unknown): WorkspaceRecoveryCheckpointInput => {
  const raw = record(value, "Workspace recovery checkpoint");
  return {
    name: text(raw.name, "checkpoint.name"),
    workspaceId: text(raw.workspaceId, "checkpoint.workspaceId"),
  };
};

const RESTORE_MODES = ["in-place", "new-workspace"] as const;
const RESTORE_STATES = [
  "planned", "staged", "commit-decided", "applying-workspace",
  "workspace-verified", "completion-decided", "compensating-workspace",
  "compensated", "complete", "aborted", "needs-attention",
] as const;
const COMBINED_STATES = [
  "planned", "applying-workspace", "workspace-verified", "navigating-conversation",
  "compensating-workspace", "compensated", "alternate-ready", "complete", "aborted", "needs-attention",
] as const;

export const parseWorkspaceRestorePrepareInput = (value: unknown): WorkspaceRestorePrepareInput => {
  const raw = record(value, "Workspace restore prepare input");
  return {
    targetSnapshotId: text(raw.targetSnapshotId, "restore.targetSnapshotId"),
    workspaceId: text(raw.workspaceId, "restore.workspaceId"),
    ...(optionalText(raw.newWorkspacePath, "restore.newWorkspacePath")
      ? { newWorkspacePath: raw.newWorkspacePath as string }
      : {}),
  };
};

export const parseWorkspaceRestoreApplyInput = (value: unknown): WorkspaceRestoreApplyInput => {
  const raw = record(value, "Workspace restore apply input");
  return {
    expectedRevision: contentHash(raw.expectedRevision, "restore.expectedRevision"),
    mode: oneOf(raw.mode, RESTORE_MODES, "restore.mode"),
    operationId: text(raw.operationId, "restore.operationId"),
    ...(optionalText(raw.newWorkspacePath, "restore.newWorkspacePath")
      ? { newWorkspacePath: raw.newWorkspacePath as string }
      : {}),
  };
};

export const parseWorkspaceRestoreFileOperation = (value: unknown): WorkspaceRestoreFileOperation => {
  const raw = record(value, "Workspace restore file operation");
  return {
    path: portablePath(raw.path, "restore operation.path"),
    type: oneOf(raw.type, ["write", "delete", "mkdir", "symlink", "metadata"] as const, "restore operation.type"),
    ...(raw.byteLength === undefined ? {} : { byteLength: count(raw.byteLength, "restore operation.byteLength") }),
    ...(raw.kind === undefined ? {} : { kind: oneOf(raw.kind, ENTRY_KINDS, "restore operation.kind") }),
    ...(raw.objectHash === undefined ? {} : { objectHash: contentHash(raw.objectHash, "restore operation.objectHash") }),
  };
};

export const parseWorkspaceRestorePlan = (value: unknown): WorkspaceRestorePlan => {
  const raw = record(value, "Workspace restore plan");
  if (!Array.isArray(raw.allowedModes) || !Array.isArray(raw.conflicts) || !Array.isArray(raw.operations)) {
    throw new WorkspaceRecoveryContractError("Restore plan collections must be arrays");
  }
  const git = record(raw.git, "restore.git");
  if (typeof git.available !== "boolean" || typeof git.repository !== "boolean" || typeof git.staged !== "boolean") {
    throw new WorkspaceRecoveryContractError("restore.git flags must be boolean");
  }
  return {
    activeWriterScopes: writerScopes(raw.activeWriterScopes, "restore.activeWriterScopes"),
    allowedModes: raw.allowedModes.map((item, index) => oneOf(item, RESTORE_MODES, `restore.allowedModes[${index}]`)),
    conflicts: raw.conflicts.map((item, index) => {
      const conflict = record(item, `restore.conflicts[${index}]`);
      return {
        code: oneOf(conflict.code, FAILURE_CODES, `restore.conflicts[${index}].code`),
        message: text(conflict.message, `restore.conflicts[${index}].message`),
        ...(conflict.path === undefined
          ? {}
          : { path: portablePath(conflict.path, `restore.conflicts[${index}].path`) }),
      };
    }),
    createdAt: isoTimestamp(raw.createdAt, "restore.createdAt"),
    dirtyBufferCount: count(raw.dirtyBufferCount, "restore.dirtyBufferCount"),
    git: {
      available: git.available,
      repository: git.repository,
      staged: git.staged,
      ...(optionalText(git.operation, "restore.git.operation") ? { operation: git.operation as string } : {}),
    },
    id: text(raw.id, "restore.id"),
    newWorkspacePath: text(raw.newWorkspacePath, "restore.newWorkspacePath"),
    operationCount: count(raw.operationCount, "restore.operationCount"),
    operations: raw.operations.map(parseWorkspaceRestoreFileOperation),
    recommendedMode: oneOf(raw.recommendedMode, RESTORE_MODES, "restore.recommendedMode"),
    revision: contentHash(raw.revision, "restore.revision"),
    safetySnapshotId: text(raw.safetySnapshotId, "restore.safetySnapshotId"),
    targetSnapshotId: text(raw.targetSnapshotId, "restore.targetSnapshotId"),
    totalBytes: count(raw.totalBytes, "restore.totalBytes"),
    witness: parseWorkspaceRecoveryCaptureWitness(raw.witness),
    workspaceId: text(raw.workspaceId, "restore.workspaceId"),
  };
};

export const parseWorkspaceRestoreOperation = (value: unknown): WorkspaceRestoreOperation => {
  const raw = record(value, "Workspace restore operation");
  return {
    appliedOperations: count(raw.appliedOperations, "restore operation.appliedOperations"),
    createdAt: isoTimestamp(raw.createdAt, "restore operation.createdAt"),
    destinationPath: text(raw.destinationPath, "restore operation.destinationPath"),
    id: text(raw.id, "restore operation.id"),
    planRevision: contentHash(raw.planRevision, "restore operation.planRevision"),
    safetySnapshotId: text(raw.safetySnapshotId, "restore operation.safetySnapshotId"),
    state: oneOf(raw.state, RESTORE_STATES, "restore operation.state"),
    targetSnapshotId: text(raw.targetSnapshotId, "restore operation.targetSnapshotId"),
    totalOperations: count(raw.totalOperations, "restore operation.totalOperations"),
    updatedAt: isoTimestamp(raw.updatedAt, "restore operation.updatedAt"),
    workspaceId: text(raw.workspaceId, "restore operation.workspaceId"),
    ...(raw.compensatedSnapshotId === undefined
      ? {}
      : { compensatedSnapshotId: text(raw.compensatedSnapshotId, "restore operation.compensatedSnapshotId") }),
    ...(raw.completionHold === undefined
      ? {}
      : { completionHold: oneOf(raw.completionHold, ["conversation"] as const, "restore operation.completionHold") }),
    ...(raw.failure === undefined ? {} : { failure: parseWorkspaceRecoveryFailure(raw.failure) }),
    ...(raw.mode === undefined ? {} : { mode: oneOf(raw.mode, RESTORE_MODES, "restore operation.mode") }),
    ...(raw.restoredSnapshotId === undefined
      ? {}
      : { restoredSnapshotId: text(raw.restoredSnapshotId, "restore operation.restoredSnapshotId") }),
  };
};

export const parseWorkspaceCombinedRecoveryPrepareInput = (
  value: unknown,
): WorkspaceCombinedRecoveryPrepareInput => {
  const raw = record(value, "Combined recovery prepare input");
  return {
    entryId: text(raw.entryId, "combined.entryId"),
    sessionId: text(raw.sessionId, "combined.sessionId"),
    workspaceId: text(raw.workspaceId, "combined.workspaceId"),
    ...(optionalText(raw.newWorkspacePath, "combined.newWorkspacePath")
      ? { newWorkspacePath: raw.newWorkspacePath as string }
      : {}),
  };
};

export const parseWorkspaceCombinedRecoveryApplyInput = (
  value: unknown,
): WorkspaceCombinedRecoveryApplyInput => {
  const raw = record(value, "Combined recovery apply input");
  return {
    expectedRevision: contentHash(raw.expectedRevision, "combined.expectedRevision"),
    mode: oneOf(raw.mode, RESTORE_MODES, "combined.mode"),
    operationId: text(raw.operationId, "combined.operationId"),
    ...(optionalText(raw.newWorkspacePath, "combined.newWorkspacePath")
      ? { newWorkspacePath: raw.newWorkspacePath as string }
      : {}),
  };
};

export const parseWorkspaceCombinedRecoveryPlan = (value: unknown): WorkspaceCombinedRecoveryPlan => {
  const raw = record(value, "Combined recovery plan");
  if (!Array.isArray(raw.allowedModes)) {
    throw new WorkspaceRecoveryContractError("combined.allowedModes must be an array");
  }
  return {
    allowedModes: raw.allowedModes.map((item, index) => oneOf(
      item,
      RESTORE_MODES,
      `combined.allowedModes[${index}]`,
    )),
    createdAt: isoTimestamp(raw.createdAt, "combined.createdAt"),
    entryId: text(raw.entryId, "combined.entryId"),
    expectedLeafId: nullableText(raw.expectedLeafId, "combined.expectedLeafId"),
    id: text(raw.id, "combined.id"),
    navigationKind: oneOf(raw.navigationKind, ["entry", "leaf"] as const, "combined.navigationKind"),
    restore: parseWorkspaceRestorePlan(raw.restore),
    revision: contentHash(raw.revision, "combined.revision"),
    sessionId: text(raw.sessionId, "combined.sessionId"),
    targetLeafId: nullableText(raw.targetLeafId, "combined.targetLeafId"),
    targetSnapshotId: text(raw.targetSnapshotId, "combined.targetSnapshotId"),
    ...(raw.undoOf === undefined ? {} : { undoOf: text(raw.undoOf, "combined.undoOf") }),
    workspaceId: text(raw.workspaceId, "combined.workspaceId"),
  };
};

const parseEditorImages = (value: unknown): WorkspaceRecoveryEditorImage[] => {
  if (!Array.isArray(value)) throw new WorkspaceRecoveryContractError("combined.editorImages must be an array");
  return value.map((item, index) => {
    const image = record(item, `combined.editorImages[${index}]`);
    return {
      data: text(image.data, `combined.editorImages[${index}].data`),
      mimeType: text(image.mimeType, `combined.editorImages[${index}].mimeType`),
    };
  });
};

export const parseWorkspaceCombinedRecoveryOperation = (
  value: unknown,
): WorkspaceCombinedRecoveryOperation => {
  const raw = record(value, "Combined recovery operation");
  return {
    conversationState: oneOf(
      raw.conversationState,
      ["unchanged", "navigated", "diverged"] as const,
      "combined.conversationState",
    ),
    createdAt: isoTimestamp(raw.createdAt, "combined.createdAt"),
    ...(raw.destinationPath === undefined
      ? {}
      : { destinationPath: text(raw.destinationPath, "combined.destinationPath") }),
    entryId: text(raw.entryId, "combined.entryId"),
    expectedLeafId: nullableText(raw.expectedLeafId, "combined.expectedLeafId"),
    id: text(raw.id, "combined.id"),
    ...(raw.mode === undefined ? {} : { mode: oneOf(raw.mode, RESTORE_MODES, "combined.mode") }),
    restoreOperationId: text(raw.restoreOperationId, "combined.restoreOperationId"),
    revision: contentHash(raw.revision, "combined.revision"),
    sessionId: text(raw.sessionId, "combined.sessionId"),
    state: oneOf(raw.state, COMBINED_STATES, "combined.state"),
    targetLeafId: nullableText(raw.targetLeafId, "combined.targetLeafId"),
    targetSnapshotId: text(raw.targetSnapshotId, "combined.targetSnapshotId"),
    ...(raw.undoOf === undefined ? {} : { undoOf: text(raw.undoOf, "combined.undoOf") }),
    updatedAt: isoTimestamp(raw.updatedAt, "combined.updatedAt"),
    workspaceId: text(raw.workspaceId, "combined.workspaceId"),
    ...(raw.workspaceAppliedOperations === undefined
      ? {}
      : { workspaceAppliedOperations: count(raw.workspaceAppliedOperations, "combined.workspaceAppliedOperations") }),
    workspaceState: oneOf(
      raw.workspaceState,
      ["unchanged", "restored", "compensated", "materialized-new", "needs-attention"] as const,
      "combined.workspaceState",
    ),
    ...(raw.workspaceTotalOperations === undefined
      ? {}
      : { workspaceTotalOperations: count(raw.workspaceTotalOperations, "combined.workspaceTotalOperations") }),
    ...(raw.editorImages === undefined ? {} : { editorImages: parseEditorImages(raw.editorImages) }),
    ...(raw.editorText === undefined ? {} : { editorText: plainText(raw.editorText, "combined.editorText") }),
    ...(raw.failure === undefined ? {} : { failure: parseWorkspaceRecoveryFailure(raw.failure) }),
    ...(raw.navigationMarkerId === undefined
      ? {}
      : { navigationMarkerId: text(raw.navigationMarkerId, "combined.navigationMarkerId") }),
  };
};

export const parseWorkspaceRecoverySnapshotQuery = (value: unknown): WorkspaceRecoverySnapshotQuery => {
  const raw = record(value, "Workspace snapshot query");
  return {
    workspaceId: text(raw.workspaceId, "query.workspaceId"),
    ...(raw.cursor === undefined ? {} : { cursor: positive(raw.cursor, "query.cursor") }),
    ...(raw.limit === undefined ? {} : { limit: positive(raw.limit, "query.limit") }),
  };
};

export const parseWorkspaceRecoverySnapshotReadInput = (value: unknown): WorkspaceRecoverySnapshotReadInput => {
  const raw = record(value, "Workspace snapshot read input");
  return {
    snapshotId: text(raw.snapshotId, "read.snapshotId"),
    workspaceId: text(raw.workspaceId, "read.workspaceId"),
    ...(optionalText(raw.entryCursor, "read.entryCursor") ? { entryCursor: raw.entryCursor as string } : {}),
    ...(raw.entryLimit === undefined ? {} : { entryLimit: positive(raw.entryLimit, "read.entryLimit") }),
  };
};

export const parseWorkspaceRecoverySnapshotDiffInput = (value: unknown): WorkspaceRecoverySnapshotDiffInput => {
  const raw = record(value, "Workspace snapshot diff input");
  return {
    afterSnapshotId: text(raw.afterSnapshotId, "diff.afterSnapshotId"),
    beforeSnapshotId: text(raw.beforeSnapshotId, "diff.beforeSnapshotId"),
    workspaceId: text(raw.workspaceId, "diff.workspaceId"),
    ...(optionalText(raw.cursor, "diff.cursor") ? { cursor: raw.cursor as string } : {}),
    ...(raw.limit === undefined ? {} : { limit: positive(raw.limit, "diff.limit") }),
  };
};

export const parseRecoveryStorageLocation = (value: unknown): RecoveryStorageLocation => {
  const raw = record(value, "Recovery storage location");
  const mode = oneOf(raw.mode, ["application-data", "workspace-local", "workspace-adjacent", "custom"] as const, "location.mode");
  if (mode === "custom") return { customRoot: text(raw.customRoot, "location.customRoot"), mode };
  if (raw.customRoot !== undefined) throw new WorkspaceRecoveryContractError("location.customRoot is only valid for custom mode");
  return { mode };
};

export const parseSetRecoveryStorageLocationInput = (value: unknown): SetRecoveryStorageLocationInput => {
  const raw = record(value, "Set recovery storage location input");
  return {
    location: parseRecoveryStorageLocation(raw.location),
    workspaceId: text(raw.workspaceId, "storage.workspaceId"),
  };
};

export const parseRecoveryStorageCleanupInput = (value: unknown): RecoveryStorageCleanupInput => {
  const raw = record(value, "Recovery storage cleanup input");
  return { workspaceId: text(raw.workspaceId, "cleanup.workspaceId") };
};

export const parseRecoveryStorageStatus = (value: unknown): RecoveryStorageStatus => {
  const raw = record(value, "Recovery storage status");
  const encryption = record(raw.encryption, "storage.encryption");
  if (typeof encryption.available !== "boolean" || typeof encryption.enabled !== "boolean") {
    throw new WorkspaceRecoveryContractError("storage.encryption flags must be boolean");
  }
  return {
    authorityId: text(raw.authorityId, "storage.authorityId"),
    byteLength: count(raw.byteLength, "storage.byteLength"),
    encryption: { available: encryption.available, enabled: encryption.enabled },
    location: parseRecoveryStorageLocation(raw.location),
    locationSource: oneOf(raw.locationSource, ["global", "workspace"] as const, "storage.locationSource"),
    objectCount: count(raw.objectCount, "storage.objectCount"),
    readySnapshotCount: count(raw.readySnapshotCount, "storage.readySnapshotCount"),
    registryRevision: count(raw.registryRevision, "storage.registryRevision"),
    snapshotCount: count(raw.snapshotCount, "storage.snapshotCount"),
    state: oneOf(raw.state, ["missing", "ready", "incomplete", "malformed", "corrupt"] as const, "storage.state"),
    ...(optionalText(raw.workspaceId, "storage.workspaceId") ? { workspaceId: raw.workspaceId as string } : {}),
  };
};

export const parseRecoveryStorageWorkspaceSummary = (value: unknown): RecoveryStorageWorkspaceSummary => {
  const raw = record(value, "Recovery storage workspace summary");
  if (typeof raw.migrationRequired !== "boolean"
    || typeof raw.storageAvailable !== "boolean"
    || typeof raw.workspaceAvailable !== "boolean") {
    throw new WorkspaceRecoveryContractError("Recovery storage workspace flags must be boolean");
  }
  return {
    byteLength: count(raw.byteLength, "workspace.byteLength"),
    canonicalRoot: text(raw.canonicalRoot, "workspace.canonicalRoot"),
    ...(raw.failure === undefined ? {} : { failure: parseWorkspaceRecoveryFailure(raw.failure) }),
    lastActivityAt: raw.lastActivityAt === null ? null : isoTimestamp(raw.lastActivityAt, "workspace.lastActivityAt"),
    location: parseRecoveryStorageLocation(raw.location),
    locationSource: oneOf(raw.locationSource, ["global", "workspace"] as const, "workspace.locationSource"),
    migrationRequired: raw.migrationRequired,
    objectCount: count(raw.objectCount, "workspace.objectCount"),
    snapshotCount: count(raw.snapshotCount, "workspace.snapshotCount"),
    state: oneOf(
      raw.state,
      ["missing", "ready", "incomplete", "malformed", "corrupt", "unavailable"] as const,
      "workspace.state",
    ),
    storageAvailable: raw.storageAvailable,
    workspaceAvailable: raw.workspaceAvailable,
    workspaceId: text(raw.workspaceId, "workspace.workspaceId"),
  };
};

export const parseRecoveryStorageMoveOperation = (value: unknown): RecoveryStorageMoveOperation => {
  const raw = record(value, "Recovery storage move operation");
  return {
    byteLength: count(raw.byteLength, "move.byteLength"),
    from: parseRecoveryStorageLocation(raw.from),
    id: text(raw.id, "move.id"),
    startedAt: isoTimestamp(raw.startedAt, "move.startedAt"),
    state: oneOf(raw.state, ["copying", "verifying", "switching", "complete", "failed"] as const, "move.state"),
    to: parseRecoveryStorageLocation(raw.to),
    updatedAt: isoTimestamp(raw.updatedAt, "move.updatedAt"),
    workspaceId: text(raw.workspaceId, "move.workspaceId"),
    ...(raw.failure === undefined ? {} : { failure: parseWorkspaceRecoveryFailure(raw.failure) }),
  };
};

export const parseRecoveryStorageCleanupResult = (value: unknown): RecoveryStorageCleanupResult => {
  const raw = record(value, "Recovery storage cleanup result");
  if (!Array.isArray(raw.failures)) throw new WorkspaceRecoveryContractError("cleanup.failures must be an array");
  return {
    byteLengthReclaimed: count(raw.byteLengthReclaimed, "cleanup.byteLengthReclaimed"),
    failures: raw.failures.map(parseWorkspaceRecoveryFailure),
    manifestsDeleted: count(raw.manifestsDeleted, "cleanup.manifestsDeleted"),
    objectsDeleted: count(raw.objectsDeleted, "cleanup.objectsDeleted"),
    operationId: text(raw.operationId, "cleanup.operationId"),
    retainedPins: count(raw.retainedPins, "cleanup.retainedPins"),
    status: oneOf(raw.status, ["complete", "failed"] as const, "cleanup.status"),
    workspaceId: text(raw.workspaceId, "cleanup.workspaceId"),
  };
};

const failed = (value: unknown): WorkspaceRecoveryFailedResult => {
  const raw = record(value, "Workspace recovery result");
  if (raw.status !== "failed") throw new WorkspaceRecoveryContractError("result.status must be failed");
  return { failure: parseWorkspaceRecoveryFailure(raw.failure), status: "failed" };
};

export const parseWorkspaceRecoveryTurnBinding = (value: unknown): WorkspaceRecoveryTurnBinding => {
  const raw = record(value, "Workspace recovery turn binding");
  return {
    activeWriterScopes: writerScopes(raw.activeWriterScopes, "binding.activeWriterScopes"),
    executionId: text(raw.executionId, "binding.executionId"),
    provenance: oneOf(raw.provenance, TURN_PROVENANCE, "binding.provenance"),
    runtimeGeneration: positive(raw.runtimeGeneration, "binding.runtimeGeneration"),
    runtimeKey: text(raw.runtimeKey, "binding.runtimeKey"),
    sessionId: text(raw.sessionId, "binding.sessionId"),
    startedAt: isoTimestamp(raw.startedAt, "binding.startedAt"),
    status: oneOf(raw.status, ["pending", "ready", "incomplete"] as const, "binding.status"),
    userEntryId: text(raw.userEntryId, "binding.userEntryId"),
    workerId: text(raw.workerId, "binding.workerId"),
    workspaceId: text(raw.workspaceId, "binding.workspaceId"),
    ...(optionalText(raw.afterSnapshotId, "binding.afterSnapshotId")
      ? { afterSnapshotId: raw.afterSnapshotId as string }
      : {}),
    ...(optionalText(raw.assistantEntryId, "binding.assistantEntryId")
      ? { assistantEntryId: raw.assistantEntryId as string }
      : {}),
    ...(optionalText(raw.beforeSnapshotId, "binding.beforeSnapshotId")
      ? { beforeSnapshotId: raw.beforeSnapshotId as string }
      : {}),
    ...(raw.failure === undefined ? {} : { failure: parseWorkspaceRecoveryFailure(raw.failure) }),
    ...(optionalText(raw.settledAt, "binding.settledAt") ? { settledAt: raw.settledAt as string } : {}),
  };
};

export const parseWorkspaceRecoveryCaptureResult = (value: unknown): WorkspaceRecoveryCaptureResult => {
  const raw = record(value, "Workspace recovery capture result");
  if (raw.status !== "failed" && typeof raw.reused !== "boolean") {
    throw new WorkspaceRecoveryContractError("capture.reused must be boolean");
  }
  return raw.status === "failed" ? failed(raw) : {
    reused: raw.reused as boolean,
    snapshot: parseWorkspaceRecoverySnapshotSummary(raw.snapshot),
    status: oneOf(raw.status, ["captured"] as const, "capture.status"),
    witness: parseWorkspaceRecoveryCaptureWitness(raw.witness),
  };
};

export const parseWorkspaceRecoveryTurnBindingResult = (value: unknown): WorkspaceRecoveryTurnBindingResult => {
  const raw = record(value, "Workspace recovery turn binding result");
  return raw.status === "failed" ? failed(raw) : {
    binding: parseWorkspaceRecoveryTurnBinding(raw.binding),
    status: oneOf(raw.status, ["ready"] as const, "binding result.status"),
  };
};

export const parseWorkspaceRestorePrepareResult = (value: unknown): WorkspaceRestorePrepareResult => {
  const raw = record(value, "Workspace restore prepare result");
  return raw.status === "failed" ? failed(raw) : {
    plan: parseWorkspaceRestorePlan(raw.plan),
    status: oneOf(raw.status, ["ready"] as const, "restore prepare.status"),
  };
};

export const parseWorkspaceRestoreOperationResult = (value: unknown): WorkspaceRestoreOperationResult => {
  const raw = record(value, "Workspace restore operation result");
  return raw.status === "failed" ? failed(raw) : {
    operation: parseWorkspaceRestoreOperation(raw.operation),
    status: oneOf(raw.status, ["ready"] as const, "restore operation result.status"),
  };
};

export const parseWorkspaceCombinedRecoveryPrepareResult = (
  value: unknown,
): WorkspaceCombinedRecoveryPrepareResult => {
  const raw = record(value, "Combined recovery prepare result");
  return raw.status === "failed" ? failed(raw) : {
    plan: parseWorkspaceCombinedRecoveryPlan(raw.plan),
    status: oneOf(raw.status, ["ready"] as const, "combined prepare.status"),
  };
};

export const parseWorkspaceCombinedRecoveryOperationResult = (
  value: unknown,
): WorkspaceCombinedRecoveryOperationResult => {
  const raw = record(value, "Combined recovery operation result");
  return raw.status === "failed" ? failed(raw) : {
    operation: parseWorkspaceCombinedRecoveryOperation(raw.operation),
    status: oneOf(raw.status, ["ready"] as const, "combined operation result.status"),
  };
};

export const parseWorkspaceCombinedRecoveryListResult = (
  value: unknown,
): WorkspaceCombinedRecoveryListResult => {
  const raw = record(value, "Combined recovery operation list");
  if (raw.status === "failed") return failed(raw);
  if (!Array.isArray(raw.operations)) {
    throw new WorkspaceRecoveryContractError("combined operations must be an array");
  }
  return {
    operations: raw.operations.map(parseWorkspaceCombinedRecoveryOperation),
    status: oneOf(raw.status, ["ready"] as const, "combined operations.status"),
  };
};

export const parseWorkspaceRecoveryEntryBindingResult = (value: unknown): WorkspaceRecoveryEntryBindingResult => {
  const raw = record(value, "Workspace recovery entry binding result");
  if (raw.status === "failed") return failed(raw);
  const status = oneOf(raw.status, ["ready", "unbound", "incomplete"] as const, "entry binding.status");
  if (status === "ready") {
    return {
      binding: parseWorkspaceRecoveryTurnBinding(raw.binding),
      position: oneOf(raw.position, ["before", "after"] as const, "entry binding.position"),
      snapshotId: text(raw.snapshotId, "entry binding.snapshotId"),
      status,
    };
  }
  return {
    reason: oneOf(
      raw.reason,
      ["entry-unbound", "session-unbound", "snapshot-incomplete"] as const,
      "entry binding.reason",
    ),
    status,
    ...(raw.binding === undefined ? {} : { binding: parseWorkspaceRecoveryTurnBinding(raw.binding) }),
  };
};

export const parseWorkspaceRecoveryListResult = (value: unknown): WorkspaceRecoveryListResult => {
  const raw = record(value, "Workspace recovery list result");
  if (raw.status === "failed") return failed(raw);
  const page = record(raw.page, "list.page");
  if (!Array.isArray(page.snapshots)) throw new WorkspaceRecoveryContractError("list.page.snapshots must be an array");
  return {
    page: {
      nextCursor: page.nextCursor === null ? null : positive(page.nextCursor, "list.page.nextCursor"),
      snapshots: page.snapshots.map(parseWorkspaceRecoverySnapshotSummary),
    },
    status: oneOf(raw.status, ["ready"] as const, "list.status"),
  };
};

export const parseWorkspaceRecoveryReadResult = (value: unknown): WorkspaceRecoveryReadResult => {
  const raw = record(value, "Workspace recovery read result");
  if (raw.status === "failed") return failed(raw);
  const status = oneOf(raw.status, ["ready", "incomplete", "missing", "malformed", "corrupt"] as const, "read.status");
  if (status === "ready" || status === "incomplete") {
    return { manifest: parseWorkspaceRecoverySnapshotManifest(raw.manifest), status };
  }
  return {
    failure: parseWorkspaceRecoveryFailure(raw.failure),
    snapshotId: text(raw.snapshotId, "read.snapshotId"),
    status,
  };
};

export const parseWorkspaceRecoveryDiffResult = (value: unknown): WorkspaceRecoveryDiffResult => {
  const raw = record(value, "Workspace recovery diff result");
  if (raw.status === "failed") return failed(raw);
  const diff = record(raw.diff, "diff");
  if (!Array.isArray(diff.changes)) throw new WorkspaceRecoveryContractError("diff.changes must be an array");
  return {
    diff: {
      afterSnapshotId: text(diff.afterSnapshotId, "diff.afterSnapshotId"),
      beforeSnapshotId: text(diff.beforeSnapshotId, "diff.beforeSnapshotId"),
      changes: diff.changes.map((item, index) => {
        const change = record(item, `diff.changes[${index}]`);
        return {
          path: portablePath(change.path, `diff.changes[${index}].path`),
          type: oneOf(change.type, ["added", "modified", "removed"] as const, `diff.changes[${index}].type`),
          ...(change.before === undefined ? {} : { before: parseWorkspaceRecoveryManifestEntry(change.before) }),
          ...(change.after === undefined ? {} : { after: parseWorkspaceRecoveryManifestEntry(change.after) }),
        };
      }),
      nextCursor: diff.nextCursor === null ? null : text(diff.nextCursor, "diff.nextCursor"),
      workspaceId: text(diff.workspaceId, "diff.workspaceId"),
    },
    status: oneOf(raw.status, ["ready"] as const, "diff.status"),
  };
};

export const parseWorkspaceRecoveryStatusResult = (value: unknown): WorkspaceRecoveryStatusResult => {
  const raw = record(value, "Workspace recovery status result");
  if (raw.status === "failed") return failed(raw);
  const capabilities = record(raw.capabilities, "status.capabilities");
  for (const key of ["bindings", "capture", "checkpoints", "combined", "diff", "read", "restore", "storageManagement"] as const) {
    if (typeof capabilities[key] !== "boolean") throw new WorkspaceRecoveryContractError(`status.capabilities.${key} must be boolean`);
  }
  return {
    capabilities: {
      bindings: capabilities.bindings as boolean,
      capture: capabilities.capture as boolean,
      checkpoints: capabilities.checkpoints as boolean,
      combined: capabilities.combined as boolean,
      diff: capabilities.diff as boolean,
      read: capabilities.read as boolean,
      restore: capabilities.restore as boolean,
      storageManagement: capabilities.storageManagement as boolean,
    },
    identity: parseWorkspaceRecoveryIdentity(raw.identity),
    status: oneOf(raw.status, ["ready"] as const, "status.status"),
    storage: parseRecoveryStorageStatus(raw.storage),
  };
};

export const parseRecoveryStorageStatusResult = (value: unknown): RecoveryStorageStatusResult => {
  const raw = record(value, "Recovery storage status result");
  return raw.status === "failed" ? failed(raw) : {
    status: oneOf(raw.status, ["ready"] as const, "storage result.status"),
    storage: parseRecoveryStorageStatus(raw.storage),
  };
};

export const parseRecoveryStorageMoveResult = (value: unknown): RecoveryStorageMoveResult => {
  const raw = record(value, "Recovery storage move result");
  return raw.status === "failed" ? failed(raw) : {
    operation: parseRecoveryStorageMoveOperation(raw.operation),
    status: oneOf(raw.status, ["ready"] as const, "move result.status"),
  };
};

export const parseRecoveryStorageCleanupOperationResult = (value: unknown): RecoveryStorageCleanupOperationResult => {
  const raw = record(value, "Recovery storage cleanup operation result");
  return raw.status === "failed" ? failed(raw) : {
    result: parseRecoveryStorageCleanupResult(raw.result),
    status: oneOf(raw.status, ["ready"] as const, "cleanup result.status"),
  };
};

export const parseRecoveryStorageWorkspaceListResult = (value: unknown): RecoveryStorageWorkspaceListResult => {
  const raw = record(value, "Recovery storage workspace list result");
  if (raw.status === "failed") return failed(raw);
  if (!Array.isArray(raw.workspaces)) {
    throw new WorkspaceRecoveryContractError("Recovery storage workspace list must be an array");
  }
  return {
    status: oneOf(raw.status, ["ready"] as const, "workspace list.status"),
    workspaces: raw.workspaces.map(parseRecoveryStorageWorkspaceSummary),
  };
};

export interface WorkspaceRecoveryAPI {
  applyCombinedRecovery(input: WorkspaceCombinedRecoveryApplyInput): Promise<WorkspaceCombinedRecoveryOperationResult>;
  applyRestore(input: WorkspaceRestoreApplyInput): Promise<WorkspaceRestoreOperationResult>;
  cancelCombinedOperation(operationId: string): Promise<WorkspaceCombinedRecoveryOperationResult>;
  cancelOperation(operationId: string): Promise<WorkspaceRestoreOperationResult>;
  clearStorageLocationOverride(workspaceId: string): Promise<RecoveryStorageMoveResult>;
  captureSnapshot(input: WorkspaceRecoveryCaptureInput): Promise<WorkspaceRecoveryCaptureResult>;
  cleanupStorage(input: RecoveryStorageCleanupInput): Promise<RecoveryStorageCleanupOperationResult>;
  createCheckpoint(input: WorkspaceRecoveryCheckpointInput): Promise<WorkspaceRecoveryCaptureResult>;
  deleteWorkspaceHistory(workspaceId: string): Promise<RecoveryStorageCleanupOperationResult>;
  diffSnapshots(input: WorkspaceRecoverySnapshotDiffInput): Promise<WorkspaceRecoveryDiffResult>;
  getCombinedOperation(operationId: string): Promise<WorkspaceCombinedRecoveryOperationResult>;
  getStorageMove(operationId: string): Promise<RecoveryStorageMoveResult>;
  getOperation(operationId: string): Promise<WorkspaceRestoreOperationResult>;
  listStorageWorkspaces(): Promise<RecoveryStorageWorkspaceListResult>;
  listSnapshots(input: WorkspaceRecoverySnapshotQuery): Promise<WorkspaceRecoveryListResult>;
  listCombinedOperations(workspaceId: string): Promise<WorkspaceCombinedRecoveryListResult>;
  readSnapshot(input: WorkspaceRecoverySnapshotReadInput): Promise<WorkspaceRecoveryReadResult>;
  prepareCombinedRecovery(input: WorkspaceCombinedRecoveryPrepareInput): Promise<WorkspaceCombinedRecoveryPrepareResult>;
  prepareCombinedUndo(operationId: string): Promise<WorkspaceCombinedRecoveryPrepareResult>;
  prepareRestore(input: WorkspaceRestorePrepareInput): Promise<WorkspaceRestorePrepareResult>;
  recordTurnSettled(input: WorkspaceRecoveryTurnSettledInput): Promise<WorkspaceRecoveryTurnBindingResult>;
  recordTurnStart(input: WorkspaceRecoveryTurnStartInput): Promise<WorkspaceRecoveryTurnBindingResult>;
  resolveEntry(input: WorkspaceRecoveryEntryTarget): Promise<WorkspaceRecoveryEntryBindingResult>;
  setDefaultStorageLocation(location: RecoveryStorageLocation): Promise<RecoveryStorageStatusResult>;
  setStorageLocation(input: SetRecoveryStorageLocationInput): Promise<RecoveryStorageMoveResult>;
  status(workspaceId: string): Promise<WorkspaceRecoveryStatusResult>;
  storageStatus(workspaceId?: string): Promise<RecoveryStorageStatusResult>;
}

export type WorkspaceRecoveryServiceInvoker = (
  request: PiariumExtensionServiceInvocationRequest,
) => Promise<JsonValue>;

export const createWorkspaceRecoveryAPI = (
  invokeService: WorkspaceRecoveryServiceInvoker,
): WorkspaceRecoveryAPI => {
  const call = (method: string, args: JsonValue[]) => invokeService({
    args,
    method,
    serviceId: PIARIUM_WORKSPACE_RECOVERY_SERVICE_ID,
    version: PIARIUM_WORKSPACE_RECOVERY_SERVICE_VERSION,
  });
  return {
    applyCombinedRecovery: async (input) => parseWorkspaceCombinedRecoveryOperationResult(await call("applyCombinedRecovery", [parseWorkspaceCombinedRecoveryApplyInput(input) as unknown as JsonValue])),
    applyRestore: async (input) => parseWorkspaceRestoreOperationResult(await call("applyRestore", [parseWorkspaceRestoreApplyInput(input) as unknown as JsonValue])),
    cancelCombinedOperation: async (operationId) => parseWorkspaceCombinedRecoveryOperationResult(await call("cancelCombinedOperation", [text(operationId, "operationId")])),
    cancelOperation: async (operationId) => parseWorkspaceRestoreOperationResult(await call("cancelOperation", [text(operationId, "operationId")])),
    clearStorageLocationOverride: async (workspaceId) => parseRecoveryStorageMoveResult(await call("clearStorageLocationOverride", [text(workspaceId, "workspaceId")])),
    captureSnapshot: async (input) => parseWorkspaceRecoveryCaptureResult(await call("captureSnapshot", [parseWorkspaceRecoveryCaptureInput(input) as unknown as JsonValue])),
    cleanupStorage: async (input) => parseRecoveryStorageCleanupOperationResult(await call("cleanupStorage", [parseRecoveryStorageCleanupInput(input) as unknown as JsonValue])),
    createCheckpoint: async (input) => parseWorkspaceRecoveryCaptureResult(await call("createCheckpoint", [parseWorkspaceRecoveryCheckpointInput(input) as unknown as JsonValue])),
    deleteWorkspaceHistory: async (workspaceId) => parseRecoveryStorageCleanupOperationResult(await call("deleteWorkspaceHistory", [text(workspaceId, "workspaceId")])),
    diffSnapshots: async (input) => parseWorkspaceRecoveryDiffResult(await call("diffSnapshots", [parseWorkspaceRecoverySnapshotDiffInput(input) as unknown as JsonValue])),
    getCombinedOperation: async (operationId) => parseWorkspaceCombinedRecoveryOperationResult(await call("getCombinedOperation", [text(operationId, "operationId")])),
    getStorageMove: async (operationId) => parseRecoveryStorageMoveResult(await call("getStorageMove", [text(operationId, "operationId")])),
    getOperation: async (operationId) => parseWorkspaceRestoreOperationResult(await call("getOperation", [text(operationId, "operationId")])),
    listStorageWorkspaces: async () => parseRecoveryStorageWorkspaceListResult(await call("listStorageWorkspaces", [])),
    listSnapshots: async (input) => parseWorkspaceRecoveryListResult(await call("listSnapshots", [parseWorkspaceRecoverySnapshotQuery(input) as unknown as JsonValue])),
    listCombinedOperations: async (workspaceId) => parseWorkspaceCombinedRecoveryListResult(await call("listCombinedOperations", [text(workspaceId, "workspaceId")])),
    readSnapshot: async (input) => parseWorkspaceRecoveryReadResult(await call("readSnapshot", [parseWorkspaceRecoverySnapshotReadInput(input) as unknown as JsonValue])),
    prepareCombinedRecovery: async (input) => parseWorkspaceCombinedRecoveryPrepareResult(await call("prepareCombinedRecovery", [parseWorkspaceCombinedRecoveryPrepareInput(input) as unknown as JsonValue])),
    prepareCombinedUndo: async (operationId) => parseWorkspaceCombinedRecoveryPrepareResult(await call("prepareCombinedUndo", [text(operationId, "operationId")])),
    prepareRestore: async (input) => parseWorkspaceRestorePrepareResult(await call("prepareRestore", [parseWorkspaceRestorePrepareInput(input) as unknown as JsonValue])),
    recordTurnSettled: async (input) => parseWorkspaceRecoveryTurnBindingResult(await call("recordTurnSettled", [parseWorkspaceRecoveryTurnSettledInput(input) as unknown as JsonValue])),
    recordTurnStart: async (input) => parseWorkspaceRecoveryTurnBindingResult(await call("recordTurnStart", [parseWorkspaceRecoveryTurnStartInput(input) as unknown as JsonValue])),
    resolveEntry: async (input) => parseWorkspaceRecoveryEntryBindingResult(await call("resolveEntry", [parseWorkspaceRecoveryEntryTarget(input) as unknown as JsonValue])),
    setDefaultStorageLocation: async (location) => parseRecoveryStorageStatusResult(await call("setDefaultStorageLocation", [parseRecoveryStorageLocation(location) as unknown as JsonValue])),
    setStorageLocation: async (input) => parseRecoveryStorageMoveResult(await call("setStorageLocation", [parseSetRecoveryStorageLocationInput(input) as unknown as JsonValue])),
    status: async (workspaceId) => parseWorkspaceRecoveryStatusResult(await call("status", [text(workspaceId, "workspaceId")])),
    storageStatus: async (workspaceId) => parseRecoveryStorageStatusResult(await call("storageStatus", [workspaceId === undefined ? null : text(workspaceId, "workspaceId")])),
  };
};
