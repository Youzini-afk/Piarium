import {
  PIARIUM_WORKSPACE_RECOVERY_SERVICE_ID,
  PIARIUM_WORKSPACE_RECOVERY_SERVICE_VERSION,
} from "./services.js";
import type {
  JsonObject,
  JsonValue,
  PiariumExtensionServiceInvocationRequest,
} from "./types.js";

export const PIARIUM_WORKSPACE_RECOVERY_CONTRACT_VERSION = 1 as const;

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
  source?: WorkspaceRecoverySnapshotSource;
  workspaceId: string;
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
    capture: boolean;
    diff: boolean;
    read: boolean;
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
  | { snapshot: WorkspaceRecoverySnapshotSummary; status: "captured" }
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

const optionalText = (value: unknown, label: string): string | undefined => (
  value === undefined ? undefined : text(value, label)
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
  return {
    workspaceId: text(raw.workspaceId, "capture.workspaceId"),
    ...(optionalText(raw.label, "capture.label") ? { label: raw.label as string } : {}),
    ...(raw.source === undefined ? {} : { source: oneOf(raw.source, SOURCES, "capture.source") }),
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
    objectCount: count(raw.objectCount, "storage.objectCount"),
    readySnapshotCount: count(raw.readySnapshotCount, "storage.readySnapshotCount"),
    registryRevision: count(raw.registryRevision, "storage.registryRevision"),
    snapshotCount: count(raw.snapshotCount, "storage.snapshotCount"),
    state: oneOf(raw.state, ["missing", "ready", "incomplete", "malformed", "corrupt"] as const, "storage.state"),
    ...(optionalText(raw.workspaceId, "storage.workspaceId") ? { workspaceId: raw.workspaceId as string } : {}),
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

export const parseWorkspaceRecoveryCaptureResult = (value: unknown): WorkspaceRecoveryCaptureResult => {
  const raw = record(value, "Workspace recovery capture result");
  return raw.status === "failed" ? failed(raw) : {
    snapshot: parseWorkspaceRecoverySnapshotSummary(raw.snapshot),
    status: oneOf(raw.status, ["captured"] as const, "capture.status"),
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
  for (const key of ["capture", "diff", "read", "storageManagement"] as const) {
    if (typeof capabilities[key] !== "boolean") throw new WorkspaceRecoveryContractError(`status.capabilities.${key} must be boolean`);
  }
  return {
    capabilities: {
      capture: capabilities.capture as boolean,
      diff: capabilities.diff as boolean,
      read: capabilities.read as boolean,
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

export interface WorkspaceRecoveryAPI {
  captureSnapshot(input: WorkspaceRecoveryCaptureInput): Promise<WorkspaceRecoveryCaptureResult>;
  cleanupStorage(input: RecoveryStorageCleanupInput): Promise<RecoveryStorageCleanupOperationResult>;
  deleteWorkspaceHistory(workspaceId: string): Promise<RecoveryStorageCleanupOperationResult>;
  diffSnapshots(input: WorkspaceRecoverySnapshotDiffInput): Promise<WorkspaceRecoveryDiffResult>;
  getStorageMove(operationId: string): Promise<RecoveryStorageMoveResult>;
  listSnapshots(input: WorkspaceRecoverySnapshotQuery): Promise<WorkspaceRecoveryListResult>;
  readSnapshot(input: WorkspaceRecoverySnapshotReadInput): Promise<WorkspaceRecoveryReadResult>;
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
    captureSnapshot: async (input) => parseWorkspaceRecoveryCaptureResult(await call("captureSnapshot", [parseWorkspaceRecoveryCaptureInput(input) as unknown as JsonValue])),
    cleanupStorage: async (input) => parseRecoveryStorageCleanupOperationResult(await call("cleanupStorage", [parseRecoveryStorageCleanupInput(input) as unknown as JsonValue])),
    deleteWorkspaceHistory: async (workspaceId) => parseRecoveryStorageCleanupOperationResult(await call("deleteWorkspaceHistory", [text(workspaceId, "workspaceId")])),
    diffSnapshots: async (input) => parseWorkspaceRecoveryDiffResult(await call("diffSnapshots", [parseWorkspaceRecoverySnapshotDiffInput(input) as unknown as JsonValue])),
    getStorageMove: async (operationId) => parseRecoveryStorageMoveResult(await call("getStorageMove", [text(operationId, "operationId")])),
    listSnapshots: async (input) => parseWorkspaceRecoveryListResult(await call("listSnapshots", [parseWorkspaceRecoverySnapshotQuery(input) as unknown as JsonValue])),
    readSnapshot: async (input) => parseWorkspaceRecoveryReadResult(await call("readSnapshot", [parseWorkspaceRecoverySnapshotReadInput(input) as unknown as JsonValue])),
    setStorageLocation: async (input) => parseRecoveryStorageMoveResult(await call("setStorageLocation", [parseSetRecoveryStorageLocationInput(input) as unknown as JsonValue])),
    status: async (workspaceId) => parseWorkspaceRecoveryStatusResult(await call("status", [text(workspaceId, "workspaceId")])),
    storageStatus: async (workspaceId) => parseRecoveryStorageStatusResult(await call("storageStatus", [workspaceId === undefined ? null : text(workspaceId, "workspaceId")])),
  };
};
