import type { HostServicesBridge } from "./host-services-bridge.js";

/**
 * Acquires a path lock via the host's `fs.lock` service, executes the
 * function, and releases the lock in a finally block.
 *
 * The Host canonicalizes, de-duplicates, and orders the whole path set before
 * granting opaque leases. Session identity comes from the broker actor.
 */
export async function withPathLock<T>(
  bridge: HostServicesBridge,
  paths: string[],
  fn: () => Promise<T>,
  options?: { timeoutMs?: number },
): Promise<T> {
  if (paths.length === 0) return fn();

  let leaseIds: string[] = [];
  try {
    const result = await bridge.request("fs.lock", {
      paths,
      action: "acquire",
      ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    });
    if (
      !result.held
      || result.leaseIds.length === 0
      || result.leaseIds.some((leaseId) => typeof leaseId !== "string" || leaseId.length === 0)
      || new Set(result.leaseIds).size !== result.leaseIds.length
    ) {
      throw new Error("Failed to acquire path lock leases");
    }
    leaseIds = result.leaseIds;
    return await fn();
  } finally {
    for (let index = leaseIds.length - 1; index >= 0; index -= 1) {
      try {
        await bridge.request("fs.lock", { leaseId: leaseIds[index]!, action: "release" });
      } catch {
        // Best-effort release; ignore errors
      }
    }
  }
}
