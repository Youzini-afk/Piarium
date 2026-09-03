import type { HostServicesBridge } from "./host-services-bridge.js";

/**
 * Acquires a path lock via the host's `fs.lock` service, executes the
 * function, and releases the lock in a finally block.
 *
 * The lock is per-session, per-path. Concurrent calls to the same path
 * from the same session will queue. Different paths acquire independently.
 */
export async function withPathLock<T>(
  bridge: HostServicesBridge,
  sessionId: string,
  paths: string[],
  fn: () => Promise<T>,
  options?: { timeoutMs?: number },
): Promise<T> {
  if (paths.length === 0) return fn();

  // Acquire all locks in order
  const acquired: string[] = [];
  try {
    for (const path of paths) {
      const result = await bridge.request("fs.lock", {
        path,
        action: "acquire",
        ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      });
      if (!result.held) {
        throw new Error(`Failed to acquire lock for path: ${path}`);
      }
      acquired.push(path);
    }
    return await fn();
  } finally {
    // Release all acquired locks in reverse order
    for (let i = acquired.length - 1; i >= 0; i--) {
      try {
        await bridge.request("fs.lock", { path: acquired[i]!, action: "release" });
      } catch {
        // Best-effort release; ignore errors
      }
    }
  }
}
