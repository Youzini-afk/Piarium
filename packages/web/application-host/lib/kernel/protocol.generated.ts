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
  | "branch.create"
  | "branch.read"
  | "branch.write"
  | "branch.publish"
  | "branch.pin"
  | "branch.unpin"
  | "branch.diff"
  | "branch.delete"
  | "pin.read"
  | "recovery.operation.begin"
  | "recovery.operation.update"
  | "recovery.operation.get"
  | "operation.get"
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
  ownerId?: string;
  operationId?: string;
  workspaceId?: string;
}

export interface KernelGetBlobParams {
  hash: string;
  offset?: number;
  length?: number;
}

export interface KernelCreateBranchParams {
  operationId: string;
  branchId: string;
  workspaceId: string;
  entries: KernelCreateEntry[];
  baseRef?: string;
}

export interface KernelCreateEntry {
  path: string;
  state: KernelBranchState;
}

export interface KernelBranchReadParams {
  branchId: string;
  revision?: number;
  paths?: string[];
  includeEntries?: boolean;
}

export interface KernelBranchWriteParams {
  operationId: string;
  branchId: string;
  expectedWriteRevision: number;
  changes: KernelBranchChange[];
}

export interface KernelBranchChange {
  path: string;
  state: KernelBranchState;
}

export interface KernelBranchPublishParams {
  operationId: string;
  branchId: string;
  expectedWriteRevision?: number;
  expectedRoot?: string;
}

export interface KernelBranchPinParams {
  operationId: string;
  branchId: string;
  revision?: number;
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
  includeEntries?: boolean;
}

export interface KernelRecoveryParams {
  operationId: string;
  recordId?: string;
  workspaceId?: string;
  state?: string;
  data?: unknown;
}

export interface KernelRecoveryGetParams {
  recordId?: string;
  operationId?: string;
}

export interface KernelOperationGetParams {
  operationId: string;
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
  nodePayloadBytes?: number;
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
  "branch.create": KernelCreateBranchParams;
  "branch.read": KernelBranchReadParams;
  "branch.write": KernelBranchWriteParams;
  "branch.publish": KernelBranchPublishParams;
  "branch.pin": KernelBranchPinParams;
  "branch.unpin": KernelBranchUnpinParams;
  "branch.diff": KernelBranchDiffParams;
  "branch.delete": KernelBranchDeleteParams;
  "pin.read": KernelPinReadParams;
  "recovery.operation.begin": KernelRecoveryParams;
  "recovery.operation.update": KernelRecoveryParams;
  "recovery.operation.get": KernelRecoveryGetParams;
  "operation.get": KernelOperationGetParams;
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
      method: "branch.create";
      params: KernelCreateBranchParams;
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
      method: "branch.write";
      params: KernelBranchWriteParams;
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
      method: "recovery.operation.begin";
      params: KernelRecoveryParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "recovery.operation.update";
      params: KernelRecoveryParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "recovery.operation.get";
      params: KernelRecoveryGetParams;
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
      method: "storage.gc";
      params: KernelGcParams;
      epoch?: string;
      grantId?: string;
    }
  | { v: typeof KERNEL_PROTOCOL_VERSION; kind: "cancel"; id: string; epoch?: string; grantId?: string; }
  | { v: typeof KERNEL_PROTOCOL_VERSION; kind: "data"; id: string; streamId: string; sequence: number; bytesBase64: string; epoch: string; grantId: string; };
