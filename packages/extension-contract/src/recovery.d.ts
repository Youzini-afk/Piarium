import type { JsonObject, JsonValue, PiariumExtensionServiceInvocationRequest } from "./types.js";
export declare const PIARIUM_WORKSPACE_RECOVERY_CONTRACT_VERSION: 5;
export type WorkspaceRecoveryFailureCode = "invalid-request" | "workspace-not-found" | "workspace-untrusted" | "checkpoint-unavailable" | "checkpoint-missing" | "checkpoint-incomplete" | "checkpoint-corrupt" | "object-missing" | "object-corrupt" | "storage-malformed" | "storage-move-failed" | "storage-schema-newer" | "storage-schema-retired" | "storage-overlap" | "operation-not-found" | "stale-plan" | "path-conflict" | "dirty-buffers" | "dirty-state-unavailable" | "lease-unavailable" | "locked-path" | "unsupported-metadata" | "navigation-conflict" | "recovery-in-progress" | "needs-attention" | "unavailable" | "internal";
export type WorkspaceRecoveryFailureOrigin = "provider" | "coverage" | "storage" | "conflict" | "navigation" | "concurrency" | "internal";
export interface WorkspaceRecoveryFailure {
    code: WorkspaceRecoveryFailureCode;
    details?: JsonObject;
    message: string;
    operationId?: string;
    origin?: WorkspaceRecoveryFailureOrigin;
    retryable: boolean;
}
export interface WorkspaceRecoveryIdentity {
    authorityId: string;
    canonicalRoot: string;
    filesystemProfile: string;
    workspaceId: string;
}
export type WorkspaceRecoveryCheckpointSource = "turn" | "named" | "restore";
export type WorkspaceRecoveryCheckpointState = "pending" | "ready" | "incomplete";
export interface WorkspaceRecoveryCheckpointSummary {
    byteLength: number;
    changedPathCount: number;
    createdAt: string;
    entryId?: string;
    executionId?: string;
    id: string;
    label?: string;
    sequence: number;
    sessionId?: string;
    source: WorkspaceRecoveryCheckpointSource;
    state: WorkspaceRecoveryCheckpointState;
    workspaceId: string;
}
export interface WorkspaceRecoveryCheckpointInput {
    name: string;
    workspaceId: string;
}
export interface WorkspaceRecoveryCheckpointQuery {
    cursor?: number;
    limit?: number;
    workspaceId: string;
}
export interface WorkspaceRecoveryCheckpointPage {
    checkpoints: WorkspaceRecoveryCheckpointSummary[];
    nextCursor: number | null;
}
export type WorkspaceRecoveryTurnProvenance = "caused-by" | "observed-during" | "overlapped";
export interface WorkspaceRecoveryTurnStartInput {
    activeWriterScopes: string[];
    executionId: string;
    failure?: WorkspaceRecoveryFailure;
    provenance: WorkspaceRecoveryTurnProvenance;
    runtimeGeneration: number;
    sessionId: string;
    userEntryId: string;
    workerId: string;
    workspaceId: string;
}
export interface WorkspaceRecoveryMutationBeforeInput {
    executionId: string;
    mutationId: string;
    path: string;
    toolCallId: string;
    toolName: "write" | "edit";
    workspaceId: string;
}
export interface WorkspaceRecoveryMutationAfterInput extends WorkspaceRecoveryMutationBeforeInput {
    succeeded: boolean;
}
export interface WorkspaceRecoveryTurnSettledInput {
    activeWriterScopes: string[];
    assistantEntryId?: string;
    executionId: string;
    failure?: WorkspaceRecoveryFailure;
    mutationObserved: boolean;
    observationComplete: boolean;
    observedResourceIds: string[];
    provenance: WorkspaceRecoveryTurnProvenance;
    workspaceId: string;
}
export interface WorkspaceRecoveryTurnBinding {
    activeWriterScopes: string[];
    assistantEntryId?: string;
    checkpointId: string;
    executionId: string;
    failure?: WorkspaceRecoveryFailure;
    provenance: WorkspaceRecoveryTurnProvenance;
    runtimeGeneration: number;
    runtimeKey: string;
    sessionId: string;
    settledAt?: string;
    startedAt: string;
    status: WorkspaceRecoveryCheckpointState;
    unrecordedResourceIds: string[];
    userEntryId: string;
    workerId: string;
    workspaceId: string;
}
export interface WorkspaceRecoveryEntryTarget {
    entryId: string;
    sessionId: string;
    workspaceId: string;
}
export type WorkspaceRecoveryEntryBindingResult = {
    binding: WorkspaceRecoveryTurnBinding;
    checkpoint: WorkspaceRecoveryCheckpointSummary;
    position: "before" | "after";
    status: "ready";
} | {
    binding?: WorkspaceRecoveryTurnBinding;
    reason: "entry-unbound" | "session-unbound" | "checkpoint-incomplete";
    status: "unbound" | "incomplete";
} | WorkspaceRecoveryFailedResult;
export type WorkspaceRecoveryConflictKind = "content-changed" | "dirty-buffer" | "unsupported";
export interface WorkspaceRecoveryConflict {
    fingerprint: string;
    kind: WorkspaceRecoveryConflictKind;
    message: string;
    path: string;
}
export interface WorkspaceRecoveryConfirmedConflict {
    fingerprint: string;
    path: string;
}
export interface WorkspaceCombinedRecoveryPrepareInput {
    entryId: string;
    sessionId: string;
    workspaceId: string;
}
export interface WorkspaceCombinedRecoveryPlan {
    affectedPaths: string[];
    changedBytes: number;
    conflicts: WorkspaceRecoveryConflict[];
    coverage: "ready" | "incomplete";
    createdAt: string;
    entryId: string;
    expectedLeafId: string | null;
    id: string;
    removedEntryIds: string[];
    revision: string;
    sessionId: string;
    targetLeafId: string | null;
    undoOf?: string;
    workspaceId: string;
}
export type WorkspaceRecoveryConflictPolicy = "abort" | "overwrite-confirmed";
export interface WorkspaceCombinedRecoveryApplyInput {
    confirmedConflicts: WorkspaceRecoveryConfirmedConflict[];
    conflictPolicy: WorkspaceRecoveryConflictPolicy;
    expectedRevision: string;
    operationId: string;
}
export type WorkspaceCombinedRecoveryOperationState = "planned" | "applying-files" | "files-restored" | "navigating-conversation" | "compensating-files" | "compensated" | "complete" | "aborted" | "needs-attention";
export interface WorkspaceRecoveryEditorImage {
    data: string;
    mimeType: string;
}
export interface WorkspaceCombinedRecoveryOperation {
    affectedPathCount: number;
    appliedPathCount: number;
    conversationState: "unchanged" | "navigated" | "diverged";
    createdAt: string;
    editorImages?: WorkspaceRecoveryEditorImage[];
    editorText?: string;
    entryId: string;
    expectedLeafId: string | null;
    failure?: WorkspaceRecoveryFailure;
    fileState: "unchanged" | "restored" | "compensated" | "needs-attention";
    id: string;
    navigationMarkerId?: string;
    revision: string;
    sessionId: string;
    state: WorkspaceCombinedRecoveryOperationState;
    targetLeafId: string | null;
    undoOf?: string;
    updatedAt: string;
    workspaceId: string;
}
export type RecoveryStorageMode = "application-data" | "workspace-local" | "workspace-adjacent" | "custom";
export type RecoveryStorageLocation = {
    mode: Exclude<RecoveryStorageMode, "custom">;
} | {
    customRoot: string;
    mode: "custom";
};
export type RecoveryCatalogState = "missing" | "ready" | "migrated" | "retired-history";
export interface RecoveryCatalogStatus {
    currentSchemaVersion: number;
    migratedFrom?: number;
    retiredCatalogCount: number;
    state: RecoveryCatalogState;
}
export interface RecoveryStorageStatus {
    authorityId: string;
    byteLength: number;
    catalog: RecoveryCatalogStatus;
    checkpointCount: number;
    encryption: {
        available: boolean;
        enabled: boolean;
    };
    location: RecoveryStorageLocation;
    locationSource: "global" | "workspace";
    objectCount: number;
    readyCheckpointCount: number;
    registryRevision: number;
    state: "missing" | "ready" | "incomplete" | "malformed" | "corrupt";
    workspaceId?: string;
}
export interface SetRecoveryStorageLocationInput {
    location: RecoveryStorageLocation;
    workspaceId: string;
}
export interface RecoveryStorageWorkspaceSummary {
    byteLength: number;
    catalog: RecoveryCatalogStatus;
    canonicalRoot: string;
    checkpointCount: number;
    failure?: WorkspaceRecoveryFailure;
    lastActivityAt: string | null;
    location: RecoveryStorageLocation;
    locationSource: "global" | "workspace";
    migrationRequired: boolean;
    objectCount: number;
    state: RecoveryStorageStatus["state"] | "unavailable";
    storageAvailable: boolean;
    workspaceAvailable: boolean;
    workspaceId: string;
}
export type RecoveryStorageMoveState = "copying" | "verifying" | "switching" | "complete" | "failed";
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
    objectsDeleted: number;
    operationId: string;
    recordsDeleted: number;
    status: "complete" | "failed";
    workspaceId: string;
}
export interface RecoveryRetentionPolicy {
    maxAgeDays: number | null;
    maxByteLength: number | null;
    maxCheckpointCount: number | null;
    maxOperationCount: number | null;
}
export interface RecoveryRetentionPolicyInput {
    policy: RecoveryRetentionPolicy;
    workspaceId: string;
}
export interface RecoveryRetentionStatus {
    eligibleCheckpointCount: number;
    lastRunAt: string | null;
    oldestProtectedOperationAt: string | null;
    policy: RecoveryRetentionPolicy;
    protectedCheckpointCount: number;
    protectedOperationCount: number;
    retainedByteLength: number;
    terminalOperationCount: number;
    workspaceId: string;
}
export interface WorkspaceRecoveryStatus {
    capabilities: {
        bindings: boolean;
        catalogLifecycle: boolean;
        checkpoints: boolean;
        combined: boolean;
        conflictConfirmation: boolean;
        dirtyStateBarrier: boolean;
        journal: boolean;
        redo: boolean;
        retention: boolean;
        storageManagement: boolean;
        workspaceLease: boolean;
    };
    failures: WorkspaceRecoveryFailure[];
    identity: WorkspaceRecoveryIdentity;
    retention: RecoveryRetentionStatus;
    status: "ready";
    storage: RecoveryStorageStatus;
}
export interface WorkspaceRecoveryFailedResult {
    failure: WorkspaceRecoveryFailure;
    status: "failed";
}
export type WorkspaceRecoveryCheckpointResult = {
    checkpoint: WorkspaceRecoveryCheckpointSummary;
    status: "ready";
} | WorkspaceRecoveryFailedResult;
export type WorkspaceRecoveryCheckpointListResult = {
    page: WorkspaceRecoveryCheckpointPage;
    status: "ready";
} | WorkspaceRecoveryFailedResult;
export type WorkspaceRecoveryTurnBindingResult = {
    binding: WorkspaceRecoveryTurnBinding;
    status: "ready";
} | WorkspaceRecoveryFailedResult;
export type WorkspaceRecoveryMutationResult = {
    recorded: boolean;
    status: "ready";
} | WorkspaceRecoveryFailedResult;
export type WorkspaceCombinedRecoveryPrepareResult = {
    plan: WorkspaceCombinedRecoveryPlan;
    status: "ready";
} | WorkspaceRecoveryFailedResult;
export type WorkspaceCombinedRecoveryOperationResult = {
    operation: WorkspaceCombinedRecoveryOperation;
    status: "ready";
} | WorkspaceRecoveryFailedResult;
export type WorkspaceCombinedRecoveryListResult = {
    operations: WorkspaceCombinedRecoveryOperation[];
    status: "ready";
} | WorkspaceRecoveryFailedResult;
export type WorkspaceRecoveryStatusResult = WorkspaceRecoveryStatus | WorkspaceRecoveryFailedResult;
export type RecoveryStorageStatusResult = {
    status: "ready";
    storage: RecoveryStorageStatus;
} | WorkspaceRecoveryFailedResult;
export type RecoveryStorageMoveResult = {
    operation: RecoveryStorageMoveOperation;
    status: "ready";
} | WorkspaceRecoveryFailedResult;
export type RecoveryStorageCleanupOperationResult = {
    result: RecoveryStorageCleanupResult;
    status: "ready";
} | WorkspaceRecoveryFailedResult;
export type RecoveryStorageWorkspaceListResult = {
    status: "ready";
    workspaces: RecoveryStorageWorkspaceSummary[];
} | WorkspaceRecoveryFailedResult;
export type RecoveryRetentionStatusResult = {
    retention: RecoveryRetentionStatus;
    status: "ready";
} | WorkspaceRecoveryFailedResult;
export declare class WorkspaceRecoveryContractError extends Error {
    constructor(message: string);
}
export declare const parseWorkspaceRecoveryFailure: (value: unknown) => WorkspaceRecoveryFailure;
export declare const parseWorkspaceRecoveryIdentity: (value: unknown) => WorkspaceRecoveryIdentity;
export declare const parseWorkspaceRecoveryCheckpointSummary: (value: unknown) => WorkspaceRecoveryCheckpointSummary;
export declare const parseWorkspaceRecoveryCheckpointInput: (value: unknown) => WorkspaceRecoveryCheckpointInput;
export declare const parseWorkspaceRecoveryCheckpointQuery: (value: unknown) => WorkspaceRecoveryCheckpointQuery;
export declare const parseWorkspaceRecoveryTurnStartInput: (value: unknown) => WorkspaceRecoveryTurnStartInput;
export declare const parseWorkspaceRecoveryMutationBeforeInput: (value: unknown) => WorkspaceRecoveryMutationBeforeInput;
export declare const parseWorkspaceRecoveryMutationAfterInput: (value: unknown) => WorkspaceRecoveryMutationAfterInput;
export declare const parseWorkspaceRecoveryTurnSettledInput: (value: unknown) => WorkspaceRecoveryTurnSettledInput;
export declare const parseWorkspaceRecoveryTurnBinding: (value: unknown) => WorkspaceRecoveryTurnBinding;
export declare const parseWorkspaceRecoveryEntryTarget: (value: unknown) => WorkspaceRecoveryEntryTarget;
export declare const parseWorkspaceCombinedRecoveryPrepareInput: (value: unknown) => WorkspaceCombinedRecoveryPrepareInput;
export declare const parseWorkspaceRecoveryConflict: (value: unknown) => WorkspaceRecoveryConflict;
export declare const parseWorkspaceRecoveryConfirmedConflict: (value: unknown) => WorkspaceRecoveryConfirmedConflict;
export declare const parseWorkspaceCombinedRecoveryPlan: (value: unknown) => WorkspaceCombinedRecoveryPlan;
export declare const parseWorkspaceCombinedRecoveryApplyInput: (value: unknown) => WorkspaceCombinedRecoveryApplyInput;
export declare const parseWorkspaceCombinedRecoveryOperation: (value: unknown) => WorkspaceCombinedRecoveryOperation;
export declare const parseRecoveryStorageLocation: (value: unknown) => RecoveryStorageLocation;
export declare const parseRecoveryCatalogStatus: (value: unknown) => RecoveryCatalogStatus;
export declare const parseSetRecoveryStorageLocationInput: (value: unknown) => SetRecoveryStorageLocationInput;
export declare const parseRecoveryStorageCleanupInput: (value: unknown) => RecoveryStorageCleanupInput;
export declare const parseRecoveryRetentionPolicy: (value: unknown) => RecoveryRetentionPolicy;
export declare const parseRecoveryRetentionPolicyInput: (value: unknown) => RecoveryRetentionPolicyInput;
export declare const parseRecoveryRetentionStatus: (value: unknown) => RecoveryRetentionStatus;
export declare const parseRecoveryStorageStatus: (value: unknown) => RecoveryStorageStatus;
export declare const parseRecoveryStorageWorkspaceSummary: (value: unknown) => RecoveryStorageWorkspaceSummary;
export declare const parseRecoveryStorageMoveOperation: (value: unknown) => RecoveryStorageMoveOperation;
export declare const parseRecoveryStorageCleanupResult: (value: unknown) => RecoveryStorageCleanupResult;
export declare const parseWorkspaceRecoveryCheckpointResult: (value: unknown) => WorkspaceRecoveryCheckpointResult;
export declare const parseWorkspaceRecoveryCheckpointListResult: (value: unknown) => WorkspaceRecoveryCheckpointListResult;
export declare const parseWorkspaceRecoveryTurnBindingResult: (value: unknown) => WorkspaceRecoveryTurnBindingResult;
export declare const parseWorkspaceRecoveryMutationResult: (value: unknown) => WorkspaceRecoveryMutationResult;
export declare const parseWorkspaceRecoveryEntryBindingResult: (value: unknown) => WorkspaceRecoveryEntryBindingResult;
export declare const parseWorkspaceCombinedRecoveryPrepareResult: (value: unknown) => WorkspaceCombinedRecoveryPrepareResult;
export declare const parseWorkspaceCombinedRecoveryOperationResult: (value: unknown) => WorkspaceCombinedRecoveryOperationResult;
export declare const parseWorkspaceCombinedRecoveryListResult: (value: unknown) => WorkspaceCombinedRecoveryListResult;
export declare const parseWorkspaceRecoveryStatusResult: (value: unknown) => WorkspaceRecoveryStatusResult;
export declare const parseRecoveryStorageStatusResult: (value: unknown) => RecoveryStorageStatusResult;
export declare const parseRecoveryStorageMoveResult: (value: unknown) => RecoveryStorageMoveResult;
export declare const parseRecoveryStorageCleanupOperationResult: (value: unknown) => RecoveryStorageCleanupOperationResult;
export declare const parseRecoveryStorageWorkspaceListResult: (value: unknown) => RecoveryStorageWorkspaceListResult;
export declare const parseRecoveryRetentionStatusResult: (value: unknown) => RecoveryRetentionStatusResult;
export interface WorkspaceRecoveryAPI {
    applyCombinedRecovery(input: WorkspaceCombinedRecoveryApplyInput): Promise<WorkspaceCombinedRecoveryOperationResult>;
    cancelCombinedOperation(operationId: string): Promise<WorkspaceCombinedRecoveryOperationResult>;
    clearStorageLocationOverride(workspaceId: string): Promise<RecoveryStorageMoveResult>;
    cleanupStorage(input: RecoveryStorageCleanupInput): Promise<RecoveryStorageCleanupOperationResult>;
    createCheckpoint(input: WorkspaceRecoveryCheckpointInput): Promise<WorkspaceRecoveryCheckpointResult>;
    deleteWorkspaceHistory(workspaceId: string): Promise<RecoveryStorageCleanupOperationResult>;
    getCombinedOperation(operationId: string): Promise<WorkspaceCombinedRecoveryOperationResult>;
    getStorageMove(operationId: string): Promise<RecoveryStorageMoveResult>;
    listCheckpoints(input: WorkspaceRecoveryCheckpointQuery): Promise<WorkspaceRecoveryCheckpointListResult>;
    listCombinedOperations(workspaceId: string): Promise<WorkspaceCombinedRecoveryListResult>;
    listStorageWorkspaces(): Promise<RecoveryStorageWorkspaceListResult>;
    prepareCombinedRecovery(input: WorkspaceCombinedRecoveryPrepareInput): Promise<WorkspaceCombinedRecoveryPrepareResult>;
    prepareCombinedUndo(operationId: string): Promise<WorkspaceCombinedRecoveryPrepareResult>;
    recordMutationAfter(input: WorkspaceRecoveryMutationAfterInput): Promise<WorkspaceRecoveryMutationResult>;
    recordMutationBefore(input: WorkspaceRecoveryMutationBeforeInput): Promise<WorkspaceRecoveryMutationResult>;
    recordTurnSettled(input: WorkspaceRecoveryTurnSettledInput): Promise<WorkspaceRecoveryTurnBindingResult>;
    recordTurnStart(input: WorkspaceRecoveryTurnStartInput): Promise<WorkspaceRecoveryTurnBindingResult>;
    retentionStatus(workspaceId: string): Promise<RecoveryRetentionStatusResult>;
    resolveEntry(input: WorkspaceRecoveryEntryTarget): Promise<WorkspaceRecoveryEntryBindingResult>;
    setDefaultStorageLocation(location: RecoveryStorageLocation): Promise<RecoveryStorageStatusResult>;
    setRetentionPolicy(input: RecoveryRetentionPolicyInput): Promise<RecoveryRetentionStatusResult>;
    setStorageLocation(input: SetRecoveryStorageLocationInput): Promise<RecoveryStorageMoveResult>;
    status(workspaceId: string): Promise<WorkspaceRecoveryStatusResult>;
    storageStatus(workspaceId?: string): Promise<RecoveryStorageStatusResult>;
}
export type WorkspaceRecoveryServiceInvoker = (request: PiariumExtensionServiceInvocationRequest) => Promise<JsonValue>;
export declare const createWorkspaceRecoveryAPI: (invokeService: WorkspaceRecoveryServiceInvoker) => WorkspaceRecoveryAPI;
//# sourceMappingURL=recovery.d.ts.map