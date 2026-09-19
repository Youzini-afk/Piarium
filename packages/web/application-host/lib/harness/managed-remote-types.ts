import type { ExperimentResourceRequest, ResourceMachineView } from "@piarium/protocol";
import type { GpuAllocation } from "./gpu-resources.js";
import type { KernelBranchState } from "../kernel/protocol.generated.js";

export const MANAGED_REMOTE_PROTOCOL_VERSION = 1;

export interface ManagedRemoteIdentity {
  protocolVersion: typeof MANAGED_REMOTE_PROTOCOL_VERSION;
  hostId: string;
  capabilities: string[];
  machine: ResourceMachineView;
}

export interface ManagedRemoteMaterialEntry {
  path: string;
  state: KernelBranchState;
}

export interface ManagedRemoteMaterialManifest {
  coordinatorHostId: string;
  materialId: string;
  cwd?: string;
  entries: ManagedRemoteMaterialEntry[];
}

export interface ManagedRemoteMaterialProbe {
  ready: boolean;
  missingObjects: Array<{ objectHash: string; byteLength: number }>;
  rootId?: string;
  canonicalRoot?: string;
  cwd?: string;
}

export interface ManagedRemoteMaterialReceipt {
  materialId: string;
  root: string;
  rootId: string;
  canonicalRoot: string;
  cwd: string;
  reused: boolean;
}

export interface ManagedRemoteJobSubmit {
  coordinatorHostId: string;
  sourceWorkspaceId: string;
  attemptId: string;
  backendJobId: string;
  materialId: string;
  cwd: string;
  command: string;
  args: string[];
  env: Array<{ name: string; value: string }>;
  gpuAllocation?: GpuAllocation;
}

export interface ManagedRemoteJobObservation {
  status: "starting" | "running" | "exited" | "failed" | "cancelled" | "unknown" | "released";
  writerActive: boolean;
  exitCode?: number | null;
  signal?: string | null;
  reason?: string;
  executionRootId?: string;
  executionCanonicalRoot?: string;
  executionCwd?: string;
}

export interface ManagedRemoteJobReceipt {
  backendJobId: string;
  observation: ManagedRemoteJobObservation;
  kernelEpoch?: string;
  pid?: number;
  executionRootId: string;
  executionCanonicalRoot: string;
  executionCwd: string;
}

export interface ManagedRemoteReadReceipt {
  chunks: Array<{ channel: "stdout" | "stderr"; bytesBase64: string }>;
  nextCursor: number;
  endCursor: number;
  observation: ManagedRemoteJobObservation;
}

export interface ManagedRemoteOutputReceipt {
  outputId: string;
  path: string;
  objectHash: string;
  byteLength: number;
}

export interface ManagedRemoteAdmissionRequest {
  coordinatorHostId: string;
  workspaceId: string;
  machineId: string;
  attemptId: string;
  resources: ExperimentResourceRequest;
}

export interface ManagedRemoteAdmissionReceipt {
  status: "confirmed" | "insufficient";
  commitmentId?: string;
  remaining?: ExperimentResourceRequest;
  gpuAllocation?: GpuAllocation;
  reason?: string;
}
