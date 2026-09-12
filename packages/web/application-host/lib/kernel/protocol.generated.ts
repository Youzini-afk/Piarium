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
  | "storage.putBlob"
  | "storage.getBlob"
  | "branch.create"
  | "branch.read"
  | "branch.write"
  | "branch.publish"
  | "branch.pin"
  | "branch.unpin"
  | "branch.diff"
  | "recovery.operation.begin"
  | "recovery.operation.update"
  | "recovery.operation.get"
  | "storage.gc";

export interface KernelRequest {
  v: typeof KERNEL_PROTOCOL_VERSION;
  kind: "request" | "cancel";
  id: string;
  method?: KernelMethod;
  params?: Record<string, unknown>;
  epoch?: string;
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
  kernelVersion: string;
  kernelEpoch: string;
  hostId: string;
  storageRoot: string;
  capabilities: string[];
}

export interface KernelBranchState {
  kind: string;
  byteLength?: number;
  mode?: number;
  objectHash?: string;
  symlinkTarget?: string;
  [key: string]: unknown;
}

export interface KernelEntry {
  path: string;
  state: KernelBranchState;
}

export interface KernelBranchReadResult {
  branchId: string;
  workspaceId: string;
  root: string;
  revision: number;
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
  blobs: number;
  storageRoot: string;
}
