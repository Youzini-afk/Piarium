import { randomUUID } from "node:crypto";
import type { PathLockResource, PathLockService } from "../harness/path-lock.js";
import type { KernelScopedClient } from "./kernel-client.js";
import type { KernelStorageAdapter } from "./storage-adapter.js";

interface KernelLockBinding {
  ownerId: string;
  workspaceId: string;
  rootId: string;
  client: KernelScopedClient;
}

export interface KernelPathLockServiceOptions {
  resolveOwningWorkspaceId(ownerId: string, executionWorkspaceId: string): Promise<string>;
  resolveWorkspaceRoot(workspaceId: string): Promise<string>;
  retryDelayMs?: number;
}

const normalizedResourceId = (resource: PathLockResource): string => {
  const candidate = resource.resourceId?.replace(/\\/g, "/").replace(/^\.\//, "");
  if (candidate !== undefined) return candidate;
  throw new Error("Kernel path lock requires a Documents-authorized relative resource id");
};

/**
 * Production fs.lock implementation. The local map owns only opaque lease
 * receipts; overlap admission itself lives in the Rust kernel.
 */
export class KernelPathLockService implements PathLockService {
  private readonly leases = new Map<string, KernelLockBinding>();
  private readonly retryDelayMs: number;
  private disposed = false;

  constructor(
    private readonly adapter: KernelStorageAdapter,
    private readonly options: KernelPathLockServiceOptions,
  ) {
    this.retryDelayMs = options.retryDelayMs ?? 5;
  }

  async acquire(ownerId: string, resource: PathLockResource, timeoutMs = 30_000): Promise<string> {
    if (this.disposed) throw new Error("Path lock service is disposed");
    const executionWorkspaceId = resource.workspaceId;
    const owningWorkspaceId = await this.options.resolveOwningWorkspaceId(ownerId, executionWorkspaceId);
    const canonicalRoot = await this.options.resolveWorkspaceRoot(executionWorkspaceId);
    const resourceId = normalizedResourceId(resource);
    const authority = await this.adapter.fileAuthorityContext({
      owningWorkspaceId,
      executionWorkspaceId,
      canonicalRoot,
      purpose: "file-writer-lock",
      actor: {
        owningWorkspace: owningWorkspaceId,
        executionWorkspace: executionWorkspaceId,
        sessionId: ownerId,
        pathScopes: [resourceId],
      },
    });
    const leaseId = `file-lock:${randomUUID()}`;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (this.disposed) throw new Error("Path lock service is disposed");
      const result = await authority.client.fileLeaseAcquire({
        workspaceId: owningWorkspaceId,
        rootId: authority.rootId,
        leaseId,
        resources: [{ path: resourceId, scope: "exact" }],
      });
      if (result.status === "acquired") {
        this.leases.set(leaseId, {
          ownerId,
          workspaceId: owningWorkspaceId,
          rootId: authority.rootId,
          client: authority.client,
        });
        return leaseId;
      }
      if (result.status !== "busy") throw new Error("Kernel returned an invalid file lease result");
      if (Date.now() >= deadline) {
        throw new Error(`Lock timeout after ${timeoutMs}ms for resource: ${resource.canonicalResourceId}`);
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(this.retryDelayMs, Math.max(1, deadline - Date.now()))));
    }
  }

  async release(ownerId: string, leaseId: string): Promise<boolean> {
    const binding = this.leases.get(leaseId);
    if (!binding || binding.ownerId !== ownerId) return false;
    const result = await binding.client.fileLeaseRelease({
      workspaceId: binding.workspaceId,
      rootId: binding.rootId,
      leaseId,
    }).catch(() => ({ released: false }));
    this.leases.delete(leaseId);
    return result.released === true;
  }

  async dropSession(ownerId: string): Promise<void> {
    const leaseIds = [...this.leases.entries()]
      .filter(([, binding]) => binding.ownerId === ownerId)
      .map(([leaseId]) => leaseId);
    await Promise.all(leaseIds.map((leaseId) => this.release(ownerId, leaseId).catch(() => false)));
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const entries = [...this.leases.entries()];
    await Promise.all(entries.map(([leaseId, binding]) => (
      this.release(binding.ownerId, leaseId).catch(() => false)
    )));
    this.leases.clear();
  }
}
