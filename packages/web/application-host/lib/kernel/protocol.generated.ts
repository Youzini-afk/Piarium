/**
 * Generated from `kernel/protocol/schema.json`.
 * Do not hand-edit the wire shapes; run `node scripts/generate-kernel-protocol.mjs`.
 */

export const KERNEL_PROTOCOL_VERSION = 1 as const;
export const KERNEL_PROTOCOL_SCHEMA = "piarium.kernel.v1" as const;

export type KernelMethod =
  | "kernel.handshake"
  | "kernel.ping"
  | "kernel.shutdown"
  | "storage.health"
  | "authority.grant.issue"
  | "authority.grant.revoke"
  | "storage.snapshot"
  | "storage.putBlob.begin"
  | "storage.putBlob.finish"
  | "storage.putBlob.abort"
  | "storage.blob.release"
  | "storage.getBlob"
  | "storage.record.put"
  | "storage.record.get"
  | "storage.record.list"
  | "storage.record.release"
  | "working.result.put"
  | "working.result.get"
  | "working.result.list"
  | "working.result.release"
  | "working.draft.put"
  | "working.draft.get"
  | "working.draft.list"
  | "working.draft.release"
  | "working.verification.put"
  | "working.verification.list"
  | "working.verification.release"
  | "working.review.put"
  | "working.review.list"
  | "working.review.release"
  | "branch.create.begin"
  | "branch.create.append"
  | "branch.create.finish"
  | "branch.create.abort"
  | "branch.read"
  | "branch.write.begin"
  | "branch.write.append"
  | "branch.write.finish"
  | "branch.write.abort"
  | "branch.publish"
  | "branch.pin"
  | "branch.unpin"
  | "branch.diff"
  | "branch.delete"
  | "pin.read"
  | "recovery.operation.get"
  | "recovery.turn.start"
  | "recovery.turn.get"
  | "recovery.turn.settle"
  | "recovery.checkpoint.create"
  | "recovery.checkpoint.list"
  | "recovery.entry.resolve"
  | "recovery.change.before"
  | "recovery.change.get"
  | "recovery.change.after"
  | "recovery.operation.create"
  | "recovery.operation.file.cas"
  | "recovery.operation.complete"
  | "recovery.operation.list"
  | "recovery.operation.release"
  | "operation.get"
  | "operation.release"
  | "storage.gc";

export interface KernelEmptyParams {

}

export interface KernelHandshakeParams {
  protocolVersion: number;
  buildVersion: string;
  hostId: string;
  hostGeneration: string;
  storageRoot: string;
  capabilities: string[];
}

export interface KernelHealthParams {
  deep?: boolean;
}

export interface KernelGrantIssueParams {
  grantId: string;
  hostGeneration: string;
  authorityInstanceId?: string | null;
  workerId?: string | null;
  workerGeneration?: number | null;
  sessionId: string | null;
  threadId: string | null;
  runId: string | null;
  owningWorkspace: string | null;
  executionWorkspace: string | null;
  storageIdentity: string;
  capabilities: string[];
  pathScopes: string[];
}

export interface KernelGrantRevokeParams {
  grantId: string;
}

export interface KernelSnapshotParams {
  workspaceId: string;
}

export interface KernelPutBlobBeginParams {
  operationId: string;
  streamId: string;
  byteLength: number;
  expectedHash?: string;
  workspaceId?: string;
}

export interface KernelPutBlobFinishParams {
  operationId: string;
  streamId: string;
  expectedHash?: string;
  workspaceId?: string;
}

export interface KernelPutBlobAbortParams {
  operationId: string;
  streamId: string;
  workspaceId?: string;
}

export interface KernelBlobReleaseParams {
  ownerId: string;
  workspaceId?: string;
}

export interface KernelGetBlobParams {
  hash: string;
  branchId?: string;
  revision?: number;
  pinId?: string;
  ownerId?: string;
  recordId?: string;
  slot?: string;
  path?: string;
  offset?: number;
  length?: number;
}

export interface KernelRecordReference {
  slot: string;
  objectHash: string;
}

export interface KernelRecordPutParams {
  operationId: string;
  recordId: string;
  workspaceId: string;
  recordType: string;
  state: string;
  sessionId?: string;
  threadId?: string;
  runId?: string;
  branchId?: string;
  revision?: number;
  resultRevision?: number;
  expectedRecordRevision?: number;
  payloadJson: string;
  ownerIds: string[];
  references: KernelRecordReference[];
}

export interface KernelRecordGetParams {
  workspaceId: string;
  recordId: string;
}

export interface KernelRecordListParams {
  workspaceId: string;
  recordType?: string;
  sessionId?: string;
  threadId?: string;
  runId?: string;
  branchId?: string;
  cursor?: number;
  pageSize?: number;
}

export interface KernelRecordReleaseParams {
  operationId: string;
  workspaceId: string;
  recordId: string;
}

export interface KernelWorkingResultPutParams {
  operationId: string;
  recordId: string;
  workspaceId: string;
  branchId: string;
  resultRevision: number;
  root: string;
  parentRef?: string;
  changedPaths: string[];
  diffStats: unknown;
  createdAt: string;
  document: unknown;
  sessionId?: string;
  threadId?: string;
  runId?: string;
  expectedRecordRevision?: number;
  ownerIds: string[];
  references: KernelRecordReference[];
}

export interface KernelWorkingResultGetParams {
  workspaceId: string;
  recordId: string;
}

export interface KernelWorkingResultListParams {
  workspaceId: string;
  branchId?: string;
  cursor?: number;
  pageSize?: number;
}

export interface KernelWorkingResultReleaseParams {
  operationId: string;
  workspaceId: string;
  recordId: string;
}

export interface KernelWorkingDraftPutParams {
  operationId: string;
  recordId: string;
  workspaceId: string;
  document: unknown;
  root?: string;
  pinId?: string;
  createdAt: string;
  expectedRecordRevision?: number;
  ownerIds: string[];
  references: KernelRecordReference[];
}

export interface KernelWorkingDraftGetParams {
  workspaceId: string;
  recordId: string;
}

export interface KernelWorkingDraftListParams {
  workspaceId: string;
  cursor?: number;
  pageSize?: number;
}

export interface KernelWorkingDraftReleaseParams {
  operationId: string;
  workspaceId: string;
  recordId: string;
}

export interface KernelWorkingVerificationPutParams {
  operationId: string;
  recordId: string;
  workspaceId: string;
  kind: string;
  threadId: string;
  runId?: string;
  branchId: string;
  resultRevision: number;
  root: string;
  document: unknown;
  expectedRecordRevision?: number;
  ownerIds: string[];
  references: KernelRecordReference[];
}

export interface KernelWorkingVerificationListParams {
  workspaceId: string;
  threadId: string;
  kind: string;
}

export interface KernelWorkingVerificationReleaseParams {
  operationId: string;
  workspaceId: string;
  recordId: string;
}

export interface KernelWorkingReviewPutParams {
  operationId: string;
  recordId: string;
  workspaceId: string;
  threadId: string;
  runId?: string;
  branchId: string;
  resultRevision: number;
  root: string;
  document: unknown;
  expectedRecordRevision?: number;
  ownerIds: string[];
  references: KernelRecordReference[];
}

export interface KernelWorkingReviewListParams {
  workspaceId: string;
  threadId: string;
}

export interface KernelWorkingReviewReleaseParams {
  operationId: string;
  workspaceId: string;
  recordId: string;
}

export interface KernelCreateBranchBeginParams {
  operationId: string;
  builderId: string;
  branchId: string;
  workspaceId: string;
  baseRef?: string;
}

export interface KernelCreateBranchAppendParams {
  builderId: string;
  sequence: number;
  entries: KernelCreateEntry[];
}

export interface KernelCreateBranchFinishParams {
  operationId: string;
  builderId: string;
}

export interface KernelCreateBranchAbortParams {
  builderId: string;
}

export interface KernelCreateEntry {
  path: string;
  state: KernelBranchState;
  ownerId?: string;
  sourcePath?: string;
  sourceRecordId?: string;
  sourceSlot?: string;
}

export interface KernelBranchReadParams {
  branchId: string;
  revision?: number;
  paths?: string[];
  includeEntries?: boolean;
  cursor?: number;
  pageSize?: number;
}

export interface KernelBranchWriteBeginParams {
  operationId: string;
  builderId: string;
  branchId: string;
  expectedWriteRevision: number;
}

export interface KernelBranchWriteAppendParams {
  builderId: string;
  sequence: number;
  changes: KernelBranchChange[];
}

export interface KernelBranchWriteFinishParams {
  operationId: string;
  builderId: string;
}

export interface KernelBranchWriteAbortParams {
  builderId: string;
}

export interface KernelBranchChange {
  path: string;
  state: KernelBranchState;
  ownerId?: string;
  sourcePath?: string;
  sourceRecordId?: string;
  sourceSlot?: string;
}

export interface KernelBranchPublishParams {
  operationId: string;
  branchId: string;
  expectedWriteRevision: number;
  expectedRoot: string;
}

export interface KernelBranchPinParams {
  operationId: string;
  branchId: string;
  revision?: number;
  expectedWriteRevision?: number;
  expectedRoot?: string;
  pinId?: string;
}

export interface KernelBranchUnpinParams {
  operationId: string;
  branchId: string;
  pinId: string;
}

export interface KernelBranchDiffParams {
  leftRoot: string;
  rightRoot: string;
}

export interface KernelBranchDeleteParams {
  operationId: string;
  branchId: string;
}

export interface KernelPinReadParams {
  pinId: string;
  paths?: string[];
  includeEntries?: boolean;
  cursor?: number;
  pageSize?: number;
}

export interface KernelRecoveryReference {
  slot: string;
  objectHash: string;
  ownerId?: string;
}

export interface KernelRecoveryTurnStartParams {
  operationId: string;
  workspaceId: string;
  executionId: string;
  sessionId: string;
  userEntryId: string;
  workerId: string;
  runtimeGeneration: number;
  activeWriterScopes: string[];
  provenance: string;
  failure?: boolean;
}

export interface KernelRecoveryTurnGetParams {
  workspaceId: string;
  executionId: string;
  sessionId?: string;
}

export interface KernelRecoveryTurnSettleParams {
  operationId: string;
  workspaceId: string;
  executionId: string;
  expectedRevision: number;
  status: string;
  observedResourceIds: string[];
  observationComplete: boolean;
  assistantEntryId?: string;
  failureJson?: string;
}

export interface KernelRecoveryCheckpointCreateParams {
  operationId: string;
  workspaceId: string;
  label: string;
}

export interface KernelRecoveryCheckpointListParams {
  workspaceId: string;
  cursor?: number;
  pageSize?: number;
}

export interface KernelRecoveryEntryResolveParams {
  workspaceId: string;
  sessionId: string;
  entryId: string;
}

export interface KernelRecoveryChangeBeforeParams {
  operationId: string;
  workspaceId: string;
  sessionId: string;
  executionId: string;
  checkpointId: string;
  path: string;
  toolName: string;
  mutationId: string;
  beforeJson: string;
  references: KernelRecoveryReference[];
}

export interface KernelRecoveryChangeGetParams {
  workspaceId: string;
  checkpointId: string;
  path: string;
}

export interface KernelRecoveryChangeAfterParams {
  operationId: string;
  workspaceId: string;
  sessionId: string;
  executionId: string;
  checkpointId: string;
  path: string;
  afterJson: string;
  succeeded: boolean;
  expectedRevision: number;
  references: KernelRecoveryReference[];
}

export interface KernelRecoveryOperationFile {
  path: string;
  expectedJson?: string;
  targetJson?: string;
  safetyJson?: string;
  phase?: string;
  references?: KernelRecoveryReference[];
}

export interface KernelRecoveryOperationCreateParams {
  operationId: string;
  workspaceId: string;
  kind: string;
  state: string;
  dataJson: string;
  files: KernelRecoveryOperationFile[];
  sessionId?: string;
  threadId?: string;
  runId?: string;
}

export interface KernelRecoveryOperationFileCasParams {
  transitionId: string;
  operationId: string;
  workspaceId: string;
  path: string;
  expectedRevision: number;
  expectedPhase: string;
  phase: string;
  observedFingerprint?: string;
  expectedJson?: string;
  targetJson?: string;
  safetyJson?: string;
  references?: KernelRecoveryReference[];
}

export interface KernelRecoveryOperationCompleteParams {
  transitionId: string;
  operationId: string;
  workspaceId: string;
  expectedRevision: number;
  state: string;
  resultJson?: string;
  failureJson?: string;
}

export interface KernelRecoveryOperationGetParams {
  operationId: string;
  workspaceId: string;
}

export interface KernelRecoveryOperationListParams {
  workspaceId: string;
  kind?: string;
  cursor?: number;
  pageSize?: number;
}

export interface KernelRecoveryOperationReleaseParams {
  transitionId: string;
  operationId: string;
  workspaceId: string;
}

export interface KernelOperationGetParams {
  operationId: string;
}

export interface KernelOperationReleaseParams {
  operationId: string;
  workspaceId?: string;
}

export interface KernelGcParams {
  operationId: string;
}

export interface KernelError {
  code: string;
  message: string;
  retryable: boolean;
}

export interface KernelResponse<T = unknown> {
  v: typeof KERNEL_PROTOCOL_VERSION;
  kind: "response";
  id: string;
  ok: boolean;
  result?: T;
  error?: KernelError;
}

export interface KernelHandshakeResult {
  protocolVersion: typeof KERNEL_PROTOCOL_VERSION;
  buildVersion: string;
  applicationBuildVersion: string;
  kernelVersion: string;
  kernelBuildIdentity: string;
  targetTriple: string;
  arch: string;
  kernelEpoch: string;
  hostId: string;
  hostGeneration: string;
  storageRoot: string;
  capabilities: string[];
}

export type KernelBranchState =
  | { kind: "regular-file"; objectHash: string; byteLength: number; mode: number }
  | { kind: "directory"; mode?: number }
  | { kind: "symlink"; symlinkTarget: string; mode?: number }
  | { kind: "missing" }
  | { kind: "unsupported" };

export interface KernelEntry {
  path: string;
  state: KernelBranchState;
}

export interface KernelBranchReadResult {
  branchId: string;
  workspaceId: string;
  root: string;
  revision: number;
  view: "current" | "revision";
  currentRoot: string;
  headRevision: number;
  writeRevision: number;
  entries: KernelEntry[];
  nextCursor?: number | null;
}

export interface KernelWriteResult {
  status: "committed" | "conflict";
  writeRevision: number;
  root: string;
}

export interface KernelBlobResult {
  hash: string;
  byteLength: number;
}

export interface KernelPutBlobResult extends KernelBlobResult {
  ownerId: string;
}

export interface KernelRecordResult {
  recordId: string;
  workspaceId: string;
  recordType: string;
  state: string;
  sessionId?: string;
  threadId?: string;
  runId?: string;
  branchId?: string;
  revision?: number;
  resultRevision?: number;
  recordRevision: number;
  payloadJson: string;
  references: KernelRecordReference[];
  createdAt: number;
  updatedAt: number;
}

export interface KernelRecordListResult {
  records: KernelRecordResult[];
  nextCursor: number | null;
}

export interface KernelObjectSlice extends KernelBlobResult {
  offset: number;
  nextOffset: number;
  eof: boolean;
  bytesBase64: string;
}

export interface KernelHealthResult {
  integrity: string;
  branches: number;
  nodes: number;
  nodeJsonBytes?: number;
  catalogBytes?: number;
  walBytes?: number;
  operations?: number;
  temporaryObjectOwners?: number;
  blobs: number;
  storageRoot: string;
  pendingCleanup?: number;
  cleanupFailures?: string[];
  deep?: boolean;
  missingNodes?: string[];
  missingObjects?: string[];
  corruptObjects?: string[];
  relationshipErrors?: string[];
}

export type KernelMethodParams = {
  "kernel.handshake": KernelHandshakeParams;
  "kernel.ping": KernelEmptyParams;
  "kernel.shutdown": KernelEmptyParams;
  "storage.health": KernelHealthParams;
  "authority.grant.issue": KernelGrantIssueParams;
  "authority.grant.revoke": KernelGrantRevokeParams;
  "storage.snapshot": KernelSnapshotParams;
  "storage.putBlob.begin": KernelPutBlobBeginParams;
  "storage.putBlob.finish": KernelPutBlobFinishParams;
  "storage.putBlob.abort": KernelPutBlobAbortParams;
  "storage.blob.release": KernelBlobReleaseParams;
  "storage.getBlob": KernelGetBlobParams;
  "storage.record.put": KernelRecordPutParams;
  "storage.record.get": KernelRecordGetParams;
  "storage.record.list": KernelRecordListParams;
  "storage.record.release": KernelRecordReleaseParams;
  "working.result.put": KernelWorkingResultPutParams;
  "working.result.get": KernelWorkingResultGetParams;
  "working.result.list": KernelWorkingResultListParams;
  "working.result.release": KernelWorkingResultReleaseParams;
  "working.draft.put": KernelWorkingDraftPutParams;
  "working.draft.get": KernelWorkingDraftGetParams;
  "working.draft.list": KernelWorkingDraftListParams;
  "working.draft.release": KernelWorkingDraftReleaseParams;
  "working.verification.put": KernelWorkingVerificationPutParams;
  "working.verification.list": KernelWorkingVerificationListParams;
  "working.verification.release": KernelWorkingVerificationReleaseParams;
  "working.review.put": KernelWorkingReviewPutParams;
  "working.review.list": KernelWorkingReviewListParams;
  "working.review.release": KernelWorkingReviewReleaseParams;
  "branch.create.begin": KernelCreateBranchBeginParams;
  "branch.create.append": KernelCreateBranchAppendParams;
  "branch.create.finish": KernelCreateBranchFinishParams;
  "branch.create.abort": KernelCreateBranchAbortParams;
  "branch.read": KernelBranchReadParams;
  "branch.write.begin": KernelBranchWriteBeginParams;
  "branch.write.append": KernelBranchWriteAppendParams;
  "branch.write.finish": KernelBranchWriteFinishParams;
  "branch.write.abort": KernelBranchWriteAbortParams;
  "branch.publish": KernelBranchPublishParams;
  "branch.pin": KernelBranchPinParams;
  "branch.unpin": KernelBranchUnpinParams;
  "branch.diff": KernelBranchDiffParams;
  "branch.delete": KernelBranchDeleteParams;
  "pin.read": KernelPinReadParams;
  "recovery.operation.get": KernelRecoveryOperationGetParams;
  "recovery.turn.start": KernelRecoveryTurnStartParams;
  "recovery.turn.get": KernelRecoveryTurnGetParams;
  "recovery.turn.settle": KernelRecoveryTurnSettleParams;
  "recovery.checkpoint.create": KernelRecoveryCheckpointCreateParams;
  "recovery.checkpoint.list": KernelRecoveryCheckpointListParams;
  "recovery.entry.resolve": KernelRecoveryEntryResolveParams;
  "recovery.change.before": KernelRecoveryChangeBeforeParams;
  "recovery.change.get": KernelRecoveryChangeGetParams;
  "recovery.change.after": KernelRecoveryChangeAfterParams;
  "recovery.operation.create": KernelRecoveryOperationCreateParams;
  "recovery.operation.file.cas": KernelRecoveryOperationFileCasParams;
  "recovery.operation.complete": KernelRecoveryOperationCompleteParams;
  "recovery.operation.list": KernelRecoveryOperationListParams;
  "recovery.operation.release": KernelRecoveryOperationReleaseParams;
  "operation.get": KernelOperationGetParams;
  "operation.release": KernelOperationReleaseParams;
  "storage.gc": KernelGcParams;
};

export type KernelRequest =
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "kernel.handshake";
      params: KernelHandshakeParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "kernel.ping";
      params: KernelEmptyParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "kernel.shutdown";
      params: KernelEmptyParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "storage.health";
      params: KernelHealthParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "authority.grant.issue";
      params: KernelGrantIssueParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "authority.grant.revoke";
      params: KernelGrantRevokeParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "storage.snapshot";
      params: KernelSnapshotParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "storage.putBlob.begin";
      params: KernelPutBlobBeginParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "storage.putBlob.finish";
      params: KernelPutBlobFinishParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "storage.putBlob.abort";
      params: KernelPutBlobAbortParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "storage.blob.release";
      params: KernelBlobReleaseParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "storage.getBlob";
      params: KernelGetBlobParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "storage.record.put";
      params: KernelRecordPutParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "storage.record.get";
      params: KernelRecordGetParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "storage.record.list";
      params: KernelRecordListParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "storage.record.release";
      params: KernelRecordReleaseParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "working.result.put";
      params: KernelWorkingResultPutParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "working.result.get";
      params: KernelWorkingResultGetParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "working.result.list";
      params: KernelWorkingResultListParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "working.result.release";
      params: KernelWorkingResultReleaseParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "working.draft.put";
      params: KernelWorkingDraftPutParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "working.draft.get";
      params: KernelWorkingDraftGetParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "working.draft.list";
      params: KernelWorkingDraftListParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "working.draft.release";
      params: KernelWorkingDraftReleaseParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "working.verification.put";
      params: KernelWorkingVerificationPutParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "working.verification.list";
      params: KernelWorkingVerificationListParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "working.verification.release";
      params: KernelWorkingVerificationReleaseParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "working.review.put";
      params: KernelWorkingReviewPutParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "working.review.list";
      params: KernelWorkingReviewListParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "working.review.release";
      params: KernelWorkingReviewReleaseParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "branch.create.begin";
      params: KernelCreateBranchBeginParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "branch.create.append";
      params: KernelCreateBranchAppendParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "branch.create.finish";
      params: KernelCreateBranchFinishParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "branch.create.abort";
      params: KernelCreateBranchAbortParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "branch.read";
      params: KernelBranchReadParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "branch.write.begin";
      params: KernelBranchWriteBeginParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "branch.write.append";
      params: KernelBranchWriteAppendParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "branch.write.finish";
      params: KernelBranchWriteFinishParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "branch.write.abort";
      params: KernelBranchWriteAbortParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "branch.publish";
      params: KernelBranchPublishParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "branch.pin";
      params: KernelBranchPinParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "branch.unpin";
      params: KernelBranchUnpinParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "branch.diff";
      params: KernelBranchDiffParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "branch.delete";
      params: KernelBranchDeleteParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "pin.read";
      params: KernelPinReadParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "recovery.operation.get";
      params: KernelRecoveryOperationGetParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "recovery.turn.start";
      params: KernelRecoveryTurnStartParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "recovery.turn.get";
      params: KernelRecoveryTurnGetParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "recovery.turn.settle";
      params: KernelRecoveryTurnSettleParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "recovery.checkpoint.create";
      params: KernelRecoveryCheckpointCreateParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "recovery.checkpoint.list";
      params: KernelRecoveryCheckpointListParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "recovery.entry.resolve";
      params: KernelRecoveryEntryResolveParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "recovery.change.before";
      params: KernelRecoveryChangeBeforeParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "recovery.change.get";
      params: KernelRecoveryChangeGetParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "recovery.change.after";
      params: KernelRecoveryChangeAfterParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "recovery.operation.create";
      params: KernelRecoveryOperationCreateParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "recovery.operation.file.cas";
      params: KernelRecoveryOperationFileCasParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "recovery.operation.complete";
      params: KernelRecoveryOperationCompleteParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "recovery.operation.list";
      params: KernelRecoveryOperationListParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "recovery.operation.release";
      params: KernelRecoveryOperationReleaseParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "operation.get";
      params: KernelOperationGetParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "operation.release";
      params: KernelOperationReleaseParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "storage.gc";
      params: KernelGcParams;
      epoch?: string;
      grantId?: string;
    }
  | { v: typeof KERNEL_PROTOCOL_VERSION; kind: "cancel"; id: string; epoch?: string; grantId?: string; }
  | { v: typeof KERNEL_PROTOCOL_VERSION; kind: "data"; id: string; streamId: string; sequence: number; bytesBase64: string; epoch: string; grantId: string; };
