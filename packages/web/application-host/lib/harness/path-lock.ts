import { resolve } from "node:path";

interface LockQueue {
  queue: Array<{
    resolve: () => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout> | undefined;
  }>;
  held: boolean;
}

const DEFAULT_TIMEOUT_MS = 30_000;

function normalizePath(path: string): string {
  const resolved = resolve(path);
  // On Windows: lowercase drive letter and convert backslashes to forward slashes
  if (process.platform === "win32") {
    return resolved.replace(/\\/g, "/").replace(/^([a-z]):/i, (_, drive) => drive.toLowerCase() + ":");
  }
  return resolved;
}

export interface PathLockService {
  acquire(sessionId: string, path: string, timeoutMs?: number): Promise<boolean>;
  release(sessionId: string, path: string): boolean;
  dropSession(sessionId: string): void;
  dispose(): void;
}

export function createPathLockService(): PathLockService {
  // Map<sessionId, Map<normalizedPath, LockQueue>>
  const sessions = new Map<string, Map<string, LockQueue>>();
  let disposed = false;

  const getOrCreateQueue = (sessionId: string, normalizedPath: string): LockQueue => {
    let session = sessions.get(sessionId);
    if (!session) {
      session = new Map();
      sessions.set(sessionId, session);
    }
    let queue = session.get(normalizedPath);
    if (!queue) {
      queue = { queue: [], held: false };
      session.set(normalizedPath, queue);
    }
    return queue;
  };

  return {
    async acquire(sessionId: string, path: string, timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<boolean> {
      if (disposed) return false;
      const normalizedPath = normalizePath(path);
      const lockQueue = getOrCreateQueue(sessionId, normalizedPath);

      if (!lockQueue.held) {
        lockQueue.held = true;
        return true;
      }

      // Queue this request
      return new Promise<boolean>((resolvePromise, rejectPromise) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const entry = {
          resolve: () => resolvePromise(true),
          reject: (error: Error) => rejectPromise(error),
          timer: undefined as ReturnType<typeof setTimeout> | undefined,
        };
        timer = setTimeout(() => {
          const idx = lockQueue.queue.indexOf(entry);
          if (idx !== -1) lockQueue.queue.splice(idx, 1);
          rejectPromise(new Error(`Lock timeout after ${timeoutMs}ms for path: ${normalizedPath}`));
        }, timeoutMs);
        entry.timer = timer;
        lockQueue.queue.push(entry);
      });
    },

    release(sessionId: string, path: string): boolean {
      const normalizedPath = normalizePath(path);
      const session = sessions.get(sessionId);
      if (!session) return false;
      const lockQueue = session.get(normalizedPath);
      if (!lockQueue || !lockQueue.held) return false;

      // Dequeue next waiter
      const next = lockQueue.queue.shift();
      if (next) {
        if (next.timer) clearTimeout(next.timer);
        next.resolve();
        // Lock remains held by the next waiter
      } else {
        lockQueue.held = false;
      }
      return true;
    },

    dropSession(sessionId: string): void {
      const session = sessions.get(sessionId);
      if (!session) return;
      for (const lockQueue of session.values()) {
        for (const entry of lockQueue.queue) {
          if (entry.timer) clearTimeout(entry.timer);
          entry.reject(new Error("Session dropped"));
        }
        lockQueue.queue.length = 0;
        lockQueue.held = false;
      }
      sessions.delete(sessionId);
    },

    dispose(): void {
      disposed = true;
      for (const session of sessions.values()) {
        for (const lockQueue of session.values()) {
          for (const entry of lockQueue.queue) {
            if (entry.timer) clearTimeout(entry.timer);
            entry.reject(new Error("Disposed"));
          }
        }
      }
      sessions.clear();
    },
  };
}
