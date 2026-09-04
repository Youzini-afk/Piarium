import { randomUUID } from "node:crypto";

export interface PathLockResource {
  authorityId: string;
  workspaceId: string;
  canonicalResourceId: string;
}

interface LockHolder {
  leaseId: string;
  ownerId: string;
}

interface LockWaiter extends LockHolder {
  resolve: (leaseId: string) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
}

interface LockQueue {
  holder: LockHolder | null;
  waiters: LockWaiter[];
}

interface LeaseRecord extends LockHolder {
  key: string;
}

export const DEFAULT_PATH_LOCK_TIMEOUT_MS = 30_000;

const resourceKey = (resource: PathLockResource): string => (
  `${resource.authorityId}\0${resource.workspaceId}\0${resource.canonicalResourceId}`
);

export interface PathLockService {
  acquire(ownerId: string, resource: PathLockResource, timeoutMs?: number): Promise<string>;
  release(ownerId: string, leaseId: string): boolean;
  dropSession(ownerId: string): void;
  dispose(): void;
}

/**
 * In-process mutual exclusion for Harness-managed writes in one Application
 * Host authority. It does not claim to lock terminals, Git, external programs,
 * or another Host process.
 */
export function createPathLockService(): PathLockService {
  const queues = new Map<string, LockQueue>();
  const leases = new Map<string, LeaseRecord>();
  let disposed = false;

  const cleanupQueue = (key: string, queue: LockQueue): void => {
    if (!queue.holder && queue.waiters.length === 0) queues.delete(key);
  };

  const grantNext = (key: string, queue: LockQueue): void => {
    const next = queue.waiters.shift();
    if (!next) {
      queue.holder = null;
      cleanupQueue(key, queue);
      return;
    }
    if (next.timer) clearTimeout(next.timer);
    queue.holder = { leaseId: next.leaseId, ownerId: next.ownerId };
    leases.set(next.leaseId, { key, leaseId: next.leaseId, ownerId: next.ownerId });
    next.resolve(next.leaseId);
  };

  return {
    async acquire(ownerId, resource, timeoutMs = DEFAULT_PATH_LOCK_TIMEOUT_MS) {
      if (disposed) throw new Error("Path lock service is disposed");
      const key = resourceKey(resource);
      let queue = queues.get(key);
      if (!queue) {
        queue = { holder: null, waiters: [] };
        queues.set(key, queue);
      }
      const leaseId = `lease-${randomUUID()}`;
      if (!queue.holder) {
        queue.holder = { leaseId, ownerId };
        leases.set(leaseId, { key, leaseId, ownerId });
        return leaseId;
      }
      return new Promise<string>((resolve, reject) => {
        const waiter: LockWaiter = { leaseId, ownerId, resolve, reject, timer: undefined };
        waiter.timer = setTimeout(() => {
          const index = queue!.waiters.indexOf(waiter);
          if (index >= 0) queue!.waiters.splice(index, 1);
          cleanupQueue(key, queue!);
          reject(new Error(`Lock timeout after ${timeoutMs}ms for resource: ${resource.canonicalResourceId}`));
        }, timeoutMs);
        queue!.waiters.push(waiter);
      });
    },

    release(ownerId, leaseId) {
      const lease = leases.get(leaseId);
      if (!lease || lease.ownerId !== ownerId) return false;
      const queue = queues.get(lease.key);
      if (!queue || queue.holder?.leaseId !== leaseId) return false;
      leases.delete(leaseId);
      queue.holder = null;
      grantNext(lease.key, queue);
      return true;
    },

    dropSession(ownerId) {
      for (const [key, queue] of queues) {
        for (let index = queue.waiters.length - 1; index >= 0; index -= 1) {
          const waiter = queue.waiters[index]!;
          if (waiter.ownerId !== ownerId) continue;
          queue.waiters.splice(index, 1);
          if (waiter.timer) clearTimeout(waiter.timer);
          waiter.reject(new Error("Session dropped"));
        }
        if (queue.holder?.ownerId === ownerId) {
          leases.delete(queue.holder.leaseId);
          queue.holder = null;
          grantNext(key, queue);
        } else {
          cleanupQueue(key, queue);
        }
      }
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      for (const queue of queues.values()) {
        for (const waiter of queue.waiters) {
          if (waiter.timer) clearTimeout(waiter.timer);
          waiter.reject(new Error("Path lock service is disposed"));
        }
      }
      queues.clear();
      leases.clear();
    },
  };
}
