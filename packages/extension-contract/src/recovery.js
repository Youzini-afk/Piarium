import { PIARIUM_WORKSPACE_RECOVERY_SERVICE_ID, PIARIUM_WORKSPACE_RECOVERY_SERVICE_VERSION, } from "./services.js";
export const PIARIUM_WORKSPACE_RECOVERY_CONTRACT_VERSION = 5;
export class WorkspaceRecoveryContractError extends Error {
    constructor(message) { super(message); this.name = "WorkspaceRecoveryContractError"; }
}
const record = (value, label) => {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new WorkspaceRecoveryContractError(`${label} must be an object`);
    return value;
};
const text = (value, label) => {
    if (typeof value !== "string" || !value.trim())
        throw new WorkspaceRecoveryContractError(`${label} must be a non-empty string`);
    return value;
};
const optionalText = (value, label) => value === undefined ? undefined : text(value, label);
const count = (value, label) => {
    if (!Number.isSafeInteger(value) || value < 0)
        throw new WorkspaceRecoveryContractError(`${label} must be a non-negative safe integer`);
    return value;
};
const nullableCount = (value, label) => (value === null ? null : count(value, label));
const positive = (value, label) => {
    const parsed = count(value, label);
    if (parsed === 0)
        throw new WorkspaceRecoveryContractError(`${label} must be positive`);
    return parsed;
};
const isoTimestamp = (value, label) => {
    const parsed = text(value, label);
    if (!Number.isFinite(Date.parse(parsed)))
        throw new WorkspaceRecoveryContractError(`${label} must be an ISO timestamp`);
    return parsed;
};
const oneOf = (value, allowed, label) => {
    if (typeof value !== "string" || !allowed.includes(value))
        throw new WorkspaceRecoveryContractError(`${label} is unsupported`);
    return value;
};
const bool = (value, label) => {
    if (typeof value !== "boolean")
        throw new WorkspaceRecoveryContractError(`${label} must be boolean`);
    return value;
};
const stringList = (value, label) => {
    if (!Array.isArray(value))
        throw new WorkspaceRecoveryContractError(`${label} must be an array`);
    return value.map((item, index) => text(item, `${label}[${index}]`));
};
const FAILURE_CODES = [
    "invalid-request", "workspace-not-found", "workspace-untrusted", "checkpoint-unavailable", "checkpoint-missing",
    "checkpoint-incomplete", "checkpoint-corrupt", "object-missing", "object-corrupt", "storage-malformed",
    "storage-move-failed", "storage-schema-newer", "storage-schema-retired", "storage-overlap", "operation-not-found",
    "stale-plan", "path-conflict", "dirty-buffers", "dirty-state-unavailable", "lease-unavailable", "locked-path",
    "unsupported-metadata", "navigation-conflict", "recovery-in-progress", "needs-attention", "unavailable", "internal",
];
const FAILURE_ORIGINS = [
    "provider", "coverage", "storage", "conflict", "navigation", "concurrency", "internal",
];
export const parseWorkspaceRecoveryFailure = (value) => {
    const raw = record(value, "Workspace recovery failure");
    if (raw.details !== undefined && (!raw.details || typeof raw.details !== "object" || Array.isArray(raw.details))) {
        throw new WorkspaceRecoveryContractError("failure.details must be an object");
    }
    return {
        code: oneOf(raw.code, FAILURE_CODES, "failure.code"), message: text(raw.message, "failure.message"),
        retryable: bool(raw.retryable, "failure.retryable"),
        ...(raw.details === undefined ? {} : { details: raw.details }),
        ...(optionalText(raw.operationId, "failure.operationId") ? { operationId: raw.operationId } : {}),
        ...(raw.origin === undefined ? {} : { origin: oneOf(raw.origin, FAILURE_ORIGINS, "failure.origin") }),
    };
};
export const parseWorkspaceRecoveryIdentity = (value) => {
    const raw = record(value, "Workspace recovery identity");
    return { authorityId: text(raw.authorityId, "identity.authorityId"), canonicalRoot: text(raw.canonicalRoot, "identity.canonicalRoot"), filesystemProfile: text(raw.filesystemProfile, "identity.filesystemProfile"), workspaceId: text(raw.workspaceId, "identity.workspaceId") };
};
export const parseWorkspaceRecoveryCheckpointSummary = (value) => {
    const raw = record(value, "Workspace recovery checkpoint");
    return {
        byteLength: count(raw.byteLength, "checkpoint.byteLength"), changedPathCount: count(raw.changedPathCount, "checkpoint.changedPathCount"),
        createdAt: isoTimestamp(raw.createdAt, "checkpoint.createdAt"), id: text(raw.id, "checkpoint.id"),
        sequence: positive(raw.sequence, "checkpoint.sequence"), source: oneOf(raw.source, ["turn", "named", "restore"], "checkpoint.source"),
        state: oneOf(raw.state, ["pending", "ready", "incomplete"], "checkpoint.state"), workspaceId: text(raw.workspaceId, "checkpoint.workspaceId"),
        ...(optionalText(raw.entryId, "checkpoint.entryId") ? { entryId: raw.entryId } : {}),
        ...(optionalText(raw.executionId, "checkpoint.executionId") ? { executionId: raw.executionId } : {}),
        ...(optionalText(raw.label, "checkpoint.label") ? { label: raw.label } : {}),
        ...(optionalText(raw.sessionId, "checkpoint.sessionId") ? { sessionId: raw.sessionId } : {}),
    };
};
export const parseWorkspaceRecoveryCheckpointInput = (value) => {
    const raw = record(value, "Workspace checkpoint input");
    return { name: text(raw.name, "checkpoint.name"), workspaceId: text(raw.workspaceId, "checkpoint.workspaceId") };
};
export const parseWorkspaceRecoveryCheckpointQuery = (value) => {
    const raw = record(value, "Workspace checkpoint query");
    return { workspaceId: text(raw.workspaceId, "query.workspaceId"), ...(raw.cursor === undefined ? {} : { cursor: positive(raw.cursor, "query.cursor") }), ...(raw.limit === undefined ? {} : { limit: positive(raw.limit, "query.limit") }) };
};
const TURN_PROVENANCE = ["caused-by", "observed-during", "overlapped"];
export const parseWorkspaceRecoveryTurnStartInput = (value) => {
    const raw = record(value, "Workspace recovery turn start");
    return {
        activeWriterScopes: stringList(raw.activeWriterScopes, "turn.activeWriterScopes"), executionId: text(raw.executionId, "turn.executionId"),
        provenance: oneOf(raw.provenance, TURN_PROVENANCE, "turn.provenance"), runtimeGeneration: positive(raw.runtimeGeneration, "turn.runtimeGeneration"),
        sessionId: text(raw.sessionId, "turn.sessionId"), userEntryId: text(raw.userEntryId, "turn.userEntryId"), workerId: text(raw.workerId, "turn.workerId"), workspaceId: text(raw.workspaceId, "turn.workspaceId"),
        ...(raw.failure === undefined ? {} : { failure: parseWorkspaceRecoveryFailure(raw.failure) }),
    };
};
const parseMutationBase = (raw) => ({
    executionId: text(raw.executionId, "mutation.executionId"), mutationId: text(raw.mutationId, "mutation.mutationId"), path: text(raw.path, "mutation.path"),
    toolCallId: text(raw.toolCallId, "mutation.toolCallId"), toolName: oneOf(raw.toolName, ["write", "edit"], "mutation.toolName"), workspaceId: text(raw.workspaceId, "mutation.workspaceId"),
});
export const parseWorkspaceRecoveryMutationBeforeInput = (value) => parseMutationBase(record(value, "Workspace mutation before"));
export const parseWorkspaceRecoveryMutationAfterInput = (value) => {
    const raw = record(value, "Workspace mutation after");
    return { ...parseMutationBase(raw), succeeded: bool(raw.succeeded, "mutation.succeeded") };
};
export const parseWorkspaceRecoveryTurnSettledInput = (value) => {
    const raw = record(value, "Workspace recovery turn settlement");
    return {
        activeWriterScopes: stringList(raw.activeWriterScopes, "turn.activeWriterScopes"), executionId: text(raw.executionId, "turn.executionId"),
        mutationObserved: bool(raw.mutationObserved, "turn.mutationObserved"), observationComplete: bool(raw.observationComplete, "turn.observationComplete"),
        observedResourceIds: stringList(raw.observedResourceIds, "turn.observedResourceIds"), provenance: oneOf(raw.provenance, TURN_PROVENANCE, "turn.provenance"), workspaceId: text(raw.workspaceId, "turn.workspaceId"),
        ...(optionalText(raw.assistantEntryId, "turn.assistantEntryId") ? { assistantEntryId: raw.assistantEntryId } : {}),
        ...(raw.failure === undefined ? {} : { failure: parseWorkspaceRecoveryFailure(raw.failure) }),
    };
};
export const parseWorkspaceRecoveryTurnBinding = (value) => {
    const raw = record(value, "Workspace recovery turn binding");
    return {
        activeWriterScopes: stringList(raw.activeWriterScopes, "binding.activeWriterScopes"), checkpointId: text(raw.checkpointId, "binding.checkpointId"),
        executionId: text(raw.executionId, "binding.executionId"), provenance: oneOf(raw.provenance, TURN_PROVENANCE, "binding.provenance"),
        runtimeGeneration: positive(raw.runtimeGeneration, "binding.runtimeGeneration"), runtimeKey: text(raw.runtimeKey, "binding.runtimeKey"),
        sessionId: text(raw.sessionId, "binding.sessionId"), startedAt: isoTimestamp(raw.startedAt, "binding.startedAt"),
        status: oneOf(raw.status, ["pending", "ready", "incomplete"], "binding.status"), unrecordedResourceIds: stringList(raw.unrecordedResourceIds, "binding.unrecordedResourceIds"),
        userEntryId: text(raw.userEntryId, "binding.userEntryId"), workerId: text(raw.workerId, "binding.workerId"), workspaceId: text(raw.workspaceId, "binding.workspaceId"),
        ...(optionalText(raw.assistantEntryId, "binding.assistantEntryId") ? { assistantEntryId: raw.assistantEntryId } : {}),
        ...(raw.failure === undefined ? {} : { failure: parseWorkspaceRecoveryFailure(raw.failure) }),
        ...(optionalText(raw.settledAt, "binding.settledAt") ? { settledAt: raw.settledAt } : {}),
    };
};
export const parseWorkspaceRecoveryEntryTarget = (value) => {
    const raw = record(value, "Workspace recovery entry target");
    return { entryId: text(raw.entryId, "target.entryId"), sessionId: text(raw.sessionId, "target.sessionId"), workspaceId: text(raw.workspaceId, "target.workspaceId") };
};
export const parseWorkspaceCombinedRecoveryPrepareInput = (value) => parseWorkspaceRecoveryEntryTarget(value);
export const parseWorkspaceRecoveryConflict = (value) => {
    const raw = record(value, "Workspace recovery conflict");
    return { fingerprint: text(raw.fingerprint, "conflict.fingerprint"), kind: oneOf(raw.kind, ["content-changed", "dirty-buffer", "unsupported"], "conflict.kind"), message: text(raw.message, "conflict.message"), path: text(raw.path, "conflict.path") };
};
export const parseWorkspaceRecoveryConfirmedConflict = (value) => {
    const raw = record(value, "Confirmed workspace recovery conflict");
    return { fingerprint: text(raw.fingerprint, "confirmedConflict.fingerprint"), path: text(raw.path, "confirmedConflict.path") };
};
export const parseWorkspaceCombinedRecoveryPlan = (value) => {
    const raw = record(value, "Combined recovery plan");
    if (!Array.isArray(raw.conflicts))
        throw new WorkspaceRecoveryContractError("plan.conflicts must be an array");
    return {
        affectedPaths: stringList(raw.affectedPaths, "plan.affectedPaths"), changedBytes: count(raw.changedBytes, "plan.changedBytes"), conflicts: raw.conflicts.map(parseWorkspaceRecoveryConflict),
        coverage: oneOf(raw.coverage, ["ready", "incomplete"], "plan.coverage"), createdAt: isoTimestamp(raw.createdAt, "plan.createdAt"), entryId: text(raw.entryId, "plan.entryId"),
        expectedLeafId: raw.expectedLeafId === null ? null : text(raw.expectedLeafId, "plan.expectedLeafId"), id: text(raw.id, "plan.id"), removedEntryIds: stringList(raw.removedEntryIds, "plan.removedEntryIds"),
        revision: text(raw.revision, "plan.revision"), sessionId: text(raw.sessionId, "plan.sessionId"), targetLeafId: raw.targetLeafId === null ? null : text(raw.targetLeafId, "plan.targetLeafId"),
        workspaceId: text(raw.workspaceId, "plan.workspaceId"), ...(optionalText(raw.undoOf, "plan.undoOf") ? { undoOf: raw.undoOf } : {}),
    };
};
export const parseWorkspaceCombinedRecoveryApplyInput = (value) => {
    const raw = record(value, "Combined recovery apply input");
    if (!Array.isArray(raw.confirmedConflicts))
        throw new WorkspaceRecoveryContractError("apply.confirmedConflicts must be an array");
    const conflictPolicy = oneOf(raw.conflictPolicy, ["abort", "overwrite-confirmed"], "apply.conflictPolicy");
    const confirmedConflicts = raw.confirmedConflicts.map(parseWorkspaceRecoveryConfirmedConflict);
    if (conflictPolicy === "abort" && confirmedConflicts.length > 0)
        throw new WorkspaceRecoveryContractError("abort cannot confirm conflicts");
    if (conflictPolicy === "overwrite-confirmed" && confirmedConflicts.length === 0)
        throw new WorkspaceRecoveryContractError("overwrite-confirmed requires at least one confirmed conflict");
    return { confirmedConflicts, conflictPolicy, expectedRevision: text(raw.expectedRevision, "apply.expectedRevision"), operationId: text(raw.operationId, "apply.operationId") };
};
const parseEditorImages = (value) => {
    if (!Array.isArray(value))
        throw new WorkspaceRecoveryContractError("operation.editorImages must be an array");
    return value.map((item, index) => { const raw = record(item, `operation.editorImages[${index}]`); return { data: text(raw.data, `operation.editorImages[${index}].data`), mimeType: text(raw.mimeType, `operation.editorImages[${index}].mimeType`) }; });
};
export const parseWorkspaceCombinedRecoveryOperation = (value) => {
    const raw = record(value, "Combined recovery operation");
    return {
        affectedPathCount: count(raw.affectedPathCount, "operation.affectedPathCount"), appliedPathCount: count(raw.appliedPathCount, "operation.appliedPathCount"),
        conversationState: oneOf(raw.conversationState, ["unchanged", "navigated", "diverged"], "operation.conversationState"), createdAt: isoTimestamp(raw.createdAt, "operation.createdAt"),
        entryId: text(raw.entryId, "operation.entryId"), expectedLeafId: raw.expectedLeafId === null ? null : text(raw.expectedLeafId, "operation.expectedLeafId"),
        fileState: oneOf(raw.fileState, ["unchanged", "restored", "compensated", "needs-attention"], "operation.fileState"), id: text(raw.id, "operation.id"),
        revision: text(raw.revision, "operation.revision"), sessionId: text(raw.sessionId, "operation.sessionId"),
        state: oneOf(raw.state, ["planned", "applying-files", "files-restored", "navigating-conversation", "compensating-files", "compensated", "complete", "aborted", "needs-attention"], "operation.state"),
        targetLeafId: raw.targetLeafId === null ? null : text(raw.targetLeafId, "operation.targetLeafId"), updatedAt: isoTimestamp(raw.updatedAt, "operation.updatedAt"), workspaceId: text(raw.workspaceId, "operation.workspaceId"),
        ...(raw.editorImages === undefined ? {} : { editorImages: parseEditorImages(raw.editorImages) }),
        ...(raw.editorText === undefined ? {} : { editorText: text(raw.editorText, "operation.editorText") }),
        ...(raw.failure === undefined ? {} : { failure: parseWorkspaceRecoveryFailure(raw.failure) }),
        ...(optionalText(raw.navigationMarkerId, "operation.navigationMarkerId") ? { navigationMarkerId: raw.navigationMarkerId } : {}),
        ...(optionalText(raw.undoOf, "operation.undoOf") ? { undoOf: raw.undoOf } : {}),
    };
};
export const parseRecoveryStorageLocation = (value) => {
    const raw = record(value, "Recovery storage location");
    const mode = oneOf(raw.mode, ["application-data", "workspace-local", "workspace-adjacent", "custom"], "location.mode");
    if (mode === "custom")
        return { customRoot: text(raw.customRoot, "location.customRoot"), mode };
    if (raw.customRoot !== undefined)
        throw new WorkspaceRecoveryContractError("location.customRoot is only valid for custom mode");
    return { mode };
};
export const parseRecoveryCatalogStatus = (value) => {
    const raw = record(value, "Recovery catalog status");
    return {
        currentSchemaVersion: count(raw.currentSchemaVersion, "catalog.currentSchemaVersion"),
        retiredCatalogCount: count(raw.retiredCatalogCount, "catalog.retiredCatalogCount"),
        state: oneOf(raw.state, ["missing", "ready", "migrated", "retired-history"], "catalog.state"),
        ...(raw.migratedFrom === undefined ? {} : { migratedFrom: positive(raw.migratedFrom, "catalog.migratedFrom") }),
    };
};
export const parseSetRecoveryStorageLocationInput = (value) => {
    const raw = record(value, "Set recovery storage location input");
    return { location: parseRecoveryStorageLocation(raw.location), workspaceId: text(raw.workspaceId, "storage.workspaceId") };
};
export const parseRecoveryStorageCleanupInput = (value) => {
    const raw = record(value, "Recovery storage cleanup input");
    return { workspaceId: text(raw.workspaceId, "cleanup.workspaceId") };
};
export const parseRecoveryRetentionPolicy = (value) => {
    const raw = record(value, "Recovery retention policy");
    const policy = {
        maxAgeDays: nullableCount(raw.maxAgeDays, "retention.maxAgeDays"),
        maxByteLength: nullableCount(raw.maxByteLength, "retention.maxByteLength"),
        maxCheckpointCount: nullableCount(raw.maxCheckpointCount, "retention.maxCheckpointCount"),
        maxOperationCount: nullableCount(raw.maxOperationCount, "retention.maxOperationCount"),
    };
    if (policy.maxAgeDays !== null && !Number.isSafeInteger(policy.maxAgeDays * 86_400_000)) {
        throw new WorkspaceRecoveryContractError("retention.maxAgeDays exceeds the supported timestamp range");
    }
    return policy;
};
export const parseRecoveryRetentionPolicyInput = (value) => {
    const raw = record(value, "Recovery retention policy input");
    return {
        policy: parseRecoveryRetentionPolicy(raw.policy),
        workspaceId: text(raw.workspaceId, "retention.workspaceId"),
    };
};
export const parseRecoveryRetentionStatus = (value) => {
    const raw = record(value, "Recovery retention status");
    return {
        eligibleCheckpointCount: count(raw.eligibleCheckpointCount, "retention.eligibleCheckpointCount"),
        lastRunAt: raw.lastRunAt === null ? null : isoTimestamp(raw.lastRunAt, "retention.lastRunAt"),
        oldestProtectedOperationAt: raw.oldestProtectedOperationAt === null
            ? null
            : isoTimestamp(raw.oldestProtectedOperationAt, "retention.oldestProtectedOperationAt"),
        policy: parseRecoveryRetentionPolicy(raw.policy),
        protectedCheckpointCount: count(raw.protectedCheckpointCount, "retention.protectedCheckpointCount"),
        protectedOperationCount: count(raw.protectedOperationCount, "retention.protectedOperationCount"),
        retainedByteLength: count(raw.retainedByteLength, "retention.retainedByteLength"),
        terminalOperationCount: count(raw.terminalOperationCount, "retention.terminalOperationCount"),
        workspaceId: text(raw.workspaceId, "retention.workspaceId"),
    };
};
export const parseRecoveryStorageStatus = (value) => {
    const raw = record(value, "Recovery storage status");
    const encryption = record(raw.encryption, "storage.encryption");
    return {
        authorityId: text(raw.authorityId, "storage.authorityId"), byteLength: count(raw.byteLength, "storage.byteLength"), catalog: parseRecoveryCatalogStatus(raw.catalog), checkpointCount: count(raw.checkpointCount, "storage.checkpointCount"),
        encryption: { available: bool(encryption.available, "storage.encryption.available"), enabled: bool(encryption.enabled, "storage.encryption.enabled") },
        location: parseRecoveryStorageLocation(raw.location), locationSource: oneOf(raw.locationSource, ["global", "workspace"], "storage.locationSource"),
        objectCount: count(raw.objectCount, "storage.objectCount"), readyCheckpointCount: count(raw.readyCheckpointCount, "storage.readyCheckpointCount"), registryRevision: count(raw.registryRevision, "storage.registryRevision"),
        state: oneOf(raw.state, ["missing", "ready", "incomplete", "malformed", "corrupt"], "storage.state"), ...(optionalText(raw.workspaceId, "storage.workspaceId") ? { workspaceId: raw.workspaceId } : {}),
    };
};
export const parseRecoveryStorageWorkspaceSummary = (value) => {
    const raw = record(value, "Recovery storage workspace summary");
    return {
        byteLength: count(raw.byteLength, "workspace.byteLength"), canonicalRoot: text(raw.canonicalRoot, "workspace.canonicalRoot"), catalog: parseRecoveryCatalogStatus(raw.catalog), checkpointCount: count(raw.checkpointCount, "workspace.checkpointCount"),
        lastActivityAt: raw.lastActivityAt === null ? null : isoTimestamp(raw.lastActivityAt, "workspace.lastActivityAt"), location: parseRecoveryStorageLocation(raw.location),
        locationSource: oneOf(raw.locationSource, ["global", "workspace"], "workspace.locationSource"), migrationRequired: bool(raw.migrationRequired, "workspace.migrationRequired"),
        objectCount: count(raw.objectCount, "workspace.objectCount"), state: oneOf(raw.state, ["missing", "ready", "incomplete", "malformed", "corrupt", "unavailable"], "workspace.state"),
        storageAvailable: bool(raw.storageAvailable, "workspace.storageAvailable"), workspaceAvailable: bool(raw.workspaceAvailable, "workspace.workspaceAvailable"), workspaceId: text(raw.workspaceId, "workspace.workspaceId"),
        ...(raw.failure === undefined ? {} : { failure: parseWorkspaceRecoveryFailure(raw.failure) }),
    };
};
export const parseRecoveryStorageMoveOperation = (value) => {
    const raw = record(value, "Recovery storage move operation");
    return { byteLength: count(raw.byteLength, "move.byteLength"), from: parseRecoveryStorageLocation(raw.from), id: text(raw.id, "move.id"), startedAt: isoTimestamp(raw.startedAt, "move.startedAt"), state: oneOf(raw.state, ["copying", "verifying", "switching", "complete", "failed"], "move.state"), to: parseRecoveryStorageLocation(raw.to), updatedAt: isoTimestamp(raw.updatedAt, "move.updatedAt"), workspaceId: text(raw.workspaceId, "move.workspaceId"), ...(raw.failure === undefined ? {} : { failure: parseWorkspaceRecoveryFailure(raw.failure) }) };
};
export const parseRecoveryStorageCleanupResult = (value) => {
    const raw = record(value, "Recovery storage cleanup result");
    if (!Array.isArray(raw.failures))
        throw new WorkspaceRecoveryContractError("cleanup.failures must be an array");
    return { byteLengthReclaimed: count(raw.byteLengthReclaimed, "cleanup.byteLengthReclaimed"), failures: raw.failures.map(parseWorkspaceRecoveryFailure), objectsDeleted: count(raw.objectsDeleted, "cleanup.objectsDeleted"), operationId: text(raw.operationId, "cleanup.operationId"), recordsDeleted: count(raw.recordsDeleted, "cleanup.recordsDeleted"), status: oneOf(raw.status, ["complete", "failed"], "cleanup.status"), workspaceId: text(raw.workspaceId, "cleanup.workspaceId") };
};
const failed = (value) => {
    const raw = record(value, "Workspace recovery result");
    if (raw.status !== "failed")
        throw new WorkspaceRecoveryContractError("result.status must be failed");
    return { failure: parseWorkspaceRecoveryFailure(raw.failure), status: "failed" };
};
export const parseWorkspaceRecoveryCheckpointResult = (value) => {
    const raw = record(value, "Workspace checkpoint result");
    return raw.status === "failed" ? failed(raw) : { checkpoint: parseWorkspaceRecoveryCheckpointSummary(raw.checkpoint), status: oneOf(raw.status, ["ready"], "checkpoint result.status") };
};
export const parseWorkspaceRecoveryCheckpointListResult = (value) => {
    const raw = record(value, "Workspace checkpoint list result");
    if (raw.status === "failed")
        return failed(raw);
    const page = record(raw.page, "checkpoint list.page");
    if (!Array.isArray(page.checkpoints))
        throw new WorkspaceRecoveryContractError("checkpoint list must be an array");
    return { page: { checkpoints: page.checkpoints.map(parseWorkspaceRecoveryCheckpointSummary), nextCursor: page.nextCursor === null ? null : positive(page.nextCursor, "checkpoint list.nextCursor") }, status: oneOf(raw.status, ["ready"], "checkpoint list.status") };
};
export const parseWorkspaceRecoveryTurnBindingResult = (value) => {
    const raw = record(value, "Workspace turn binding result");
    return raw.status === "failed" ? failed(raw) : { binding: parseWorkspaceRecoveryTurnBinding(raw.binding), status: oneOf(raw.status, ["ready"], "turn binding result.status") };
};
export const parseWorkspaceRecoveryMutationResult = (value) => {
    const raw = record(value, "Workspace mutation result");
    return raw.status === "failed" ? failed(raw) : { recorded: bool(raw.recorded, "mutation result.recorded"), status: oneOf(raw.status, ["ready"], "mutation result.status") };
};
export const parseWorkspaceRecoveryEntryBindingResult = (value) => {
    const raw = record(value, "Workspace entry binding result");
    if (raw.status === "failed")
        return failed(raw);
    const status = oneOf(raw.status, ["ready", "unbound", "incomplete"], "entry binding.status");
    if (status === "ready")
        return { binding: parseWorkspaceRecoveryTurnBinding(raw.binding), checkpoint: parseWorkspaceRecoveryCheckpointSummary(raw.checkpoint), position: oneOf(raw.position, ["before", "after"], "entry binding.position"), status };
    return { reason: oneOf(raw.reason, ["entry-unbound", "session-unbound", "checkpoint-incomplete"], "entry binding.reason"), status, ...(raw.binding === undefined ? {} : { binding: parseWorkspaceRecoveryTurnBinding(raw.binding) }) };
};
export const parseWorkspaceCombinedRecoveryPrepareResult = (value) => {
    const raw = record(value, "Combined recovery prepare result");
    return raw.status === "failed" ? failed(raw) : { plan: parseWorkspaceCombinedRecoveryPlan(raw.plan), status: oneOf(raw.status, ["ready"], "combined prepare.status") };
};
export const parseWorkspaceCombinedRecoveryOperationResult = (value) => {
    const raw = record(value, "Combined recovery operation result");
    return raw.status === "failed" ? failed(raw) : { operation: parseWorkspaceCombinedRecoveryOperation(raw.operation), status: oneOf(raw.status, ["ready"], "combined operation.status") };
};
export const parseWorkspaceCombinedRecoveryListResult = (value) => {
    const raw = record(value, "Combined recovery operation list");
    if (raw.status === "failed")
        return failed(raw);
    if (!Array.isArray(raw.operations))
        throw new WorkspaceRecoveryContractError("combined operations must be an array");
    return { operations: raw.operations.map(parseWorkspaceCombinedRecoveryOperation), status: oneOf(raw.status, ["ready"], "combined operations.status") };
};
export const parseWorkspaceRecoveryStatusResult = (value) => {
    const raw = record(value, "Workspace recovery status result");
    if (raw.status === "failed")
        return failed(raw);
    const capabilities = record(raw.capabilities, "status.capabilities");
    if (!Array.isArray(raw.failures))
        throw new WorkspaceRecoveryContractError("status.failures must be an array");
    return {
        capabilities: { bindings: bool(capabilities.bindings, "status.capabilities.bindings"), catalogLifecycle: bool(capabilities.catalogLifecycle, "status.capabilities.catalogLifecycle"), checkpoints: bool(capabilities.checkpoints, "status.capabilities.checkpoints"), combined: bool(capabilities.combined, "status.capabilities.combined"), conflictConfirmation: bool(capabilities.conflictConfirmation, "status.capabilities.conflictConfirmation"), dirtyStateBarrier: bool(capabilities.dirtyStateBarrier, "status.capabilities.dirtyStateBarrier"), journal: bool(capabilities.journal, "status.capabilities.journal"), redo: bool(capabilities.redo, "status.capabilities.redo"), retention: bool(capabilities.retention, "status.capabilities.retention"), storageManagement: bool(capabilities.storageManagement, "status.capabilities.storageManagement"), workspaceLease: bool(capabilities.workspaceLease, "status.capabilities.workspaceLease") },
        failures: raw.failures.map(parseWorkspaceRecoveryFailure),
        identity: parseWorkspaceRecoveryIdentity(raw.identity),
        retention: parseRecoveryRetentionStatus(raw.retention),
        status: oneOf(raw.status, ["ready"], "status.status"),
        storage: parseRecoveryStorageStatus(raw.storage),
    };
};
export const parseRecoveryStorageStatusResult = (value) => {
    const raw = record(value, "Recovery storage result");
    return raw.status === "failed" ? failed(raw) : { status: oneOf(raw.status, ["ready"], "storage result.status"), storage: parseRecoveryStorageStatus(raw.storage) };
};
export const parseRecoveryStorageMoveResult = (value) => {
    const raw = record(value, "Recovery storage move result");
    return raw.status === "failed" ? failed(raw) : { operation: parseRecoveryStorageMoveOperation(raw.operation), status: oneOf(raw.status, ["ready"], "move result.status") };
};
export const parseRecoveryStorageCleanupOperationResult = (value) => {
    const raw = record(value, "Recovery cleanup result");
    return raw.status === "failed" ? failed(raw) : { result: parseRecoveryStorageCleanupResult(raw.result), status: oneOf(raw.status, ["ready"], "cleanup result.status") };
};
export const parseRecoveryStorageWorkspaceListResult = (value) => {
    const raw = record(value, "Recovery storage workspace list");
    if (raw.status === "failed")
        return failed(raw);
    if (!Array.isArray(raw.workspaces))
        throw new WorkspaceRecoveryContractError("Recovery storage workspaces must be an array");
    return { status: oneOf(raw.status, ["ready"], "workspace list.status"), workspaces: raw.workspaces.map(parseRecoveryStorageWorkspaceSummary) };
};
export const parseRecoveryRetentionStatusResult = (value) => {
    const raw = record(value, "Recovery retention result");
    return raw.status === "failed"
        ? failed(raw)
        : {
            retention: parseRecoveryRetentionStatus(raw.retention),
            status: oneOf(raw.status, ["ready"], "retention result.status"),
        };
};
export const createWorkspaceRecoveryAPI = (invokeService) => {
    const call = (method, args) => invokeService({ args, method, serviceId: PIARIUM_WORKSPACE_RECOVERY_SERVICE_ID, version: PIARIUM_WORKSPACE_RECOVERY_SERVICE_VERSION });
    return {
        applyCombinedRecovery: async (input) => parseWorkspaceCombinedRecoveryOperationResult(await call("applyCombinedRecovery", [parseWorkspaceCombinedRecoveryApplyInput(input)])),
        cancelCombinedOperation: async (id) => parseWorkspaceCombinedRecoveryOperationResult(await call("cancelCombinedOperation", [text(id, "operationId")])),
        clearStorageLocationOverride: async (id) => parseRecoveryStorageMoveResult(await call("clearStorageLocationOverride", [text(id, "workspaceId")])),
        cleanupStorage: async (input) => parseRecoveryStorageCleanupOperationResult(await call("cleanupStorage", [parseRecoveryStorageCleanupInput(input)])),
        createCheckpoint: async (input) => parseWorkspaceRecoveryCheckpointResult(await call("createCheckpoint", [parseWorkspaceRecoveryCheckpointInput(input)])),
        deleteWorkspaceHistory: async (id) => parseRecoveryStorageCleanupOperationResult(await call("deleteWorkspaceHistory", [text(id, "workspaceId")])),
        getCombinedOperation: async (id) => parseWorkspaceCombinedRecoveryOperationResult(await call("getCombinedOperation", [text(id, "operationId")])),
        getStorageMove: async (id) => parseRecoveryStorageMoveResult(await call("getStorageMove", [text(id, "operationId")])),
        listCheckpoints: async (input) => parseWorkspaceRecoveryCheckpointListResult(await call("listCheckpoints", [parseWorkspaceRecoveryCheckpointQuery(input)])),
        listCombinedOperations: async (id) => parseWorkspaceCombinedRecoveryListResult(await call("listCombinedOperations", [text(id, "workspaceId")])),
        listStorageWorkspaces: async () => parseRecoveryStorageWorkspaceListResult(await call("listStorageWorkspaces", [])),
        prepareCombinedRecovery: async (input) => parseWorkspaceCombinedRecoveryPrepareResult(await call("prepareCombinedRecovery", [parseWorkspaceCombinedRecoveryPrepareInput(input)])),
        prepareCombinedUndo: async (id) => parseWorkspaceCombinedRecoveryPrepareResult(await call("prepareCombinedUndo", [text(id, "operationId")])),
        recordMutationAfter: async (input) => parseWorkspaceRecoveryMutationResult(await call("recordMutationAfter", [parseWorkspaceRecoveryMutationAfterInput(input)])),
        recordMutationBefore: async (input) => parseWorkspaceRecoveryMutationResult(await call("recordMutationBefore", [parseWorkspaceRecoveryMutationBeforeInput(input)])),
        recordTurnSettled: async (input) => parseWorkspaceRecoveryTurnBindingResult(await call("recordTurnSettled", [parseWorkspaceRecoveryTurnSettledInput(input)])),
        recordTurnStart: async (input) => parseWorkspaceRecoveryTurnBindingResult(await call("recordTurnStart", [parseWorkspaceRecoveryTurnStartInput(input)])),
        retentionStatus: async (id) => parseRecoveryRetentionStatusResult(await call("retentionStatus", [text(id, "workspaceId")])),
        resolveEntry: async (input) => parseWorkspaceRecoveryEntryBindingResult(await call("resolveEntry", [parseWorkspaceRecoveryEntryTarget(input)])),
        setDefaultStorageLocation: async (location) => parseRecoveryStorageStatusResult(await call("setDefaultStorageLocation", [parseRecoveryStorageLocation(location)])),
        setRetentionPolicy: async (input) => parseRecoveryRetentionStatusResult(await call("setRetentionPolicy", [parseRecoveryRetentionPolicyInput(input)])),
        setStorageLocation: async (input) => parseRecoveryStorageMoveResult(await call("setStorageLocation", [parseSetRecoveryStorageLocationInput(input)])),
        status: async (id) => parseWorkspaceRecoveryStatusResult(await call("status", [text(id, "workspaceId")])),
        storageStatus: async (id) => parseRecoveryStorageStatusResult(await call("storageStatus", [id === undefined ? null : text(id, "workspaceId")])),
    };
};
//# sourceMappingURL=recovery.js.map