import { describe, expect, it } from "vitest";
import { createPathLockService, type PathLockResource, type PathLockService } from "./path-lock.js";
import { createFsLockService } from "./harness-services.js";
import type { HarnessServiceContext } from "./router.js";

const RESOURCE: PathLockResource = {
  authorityId: "host-1",
  workspaceId: "workspace-1",
  canonicalResourceId: "d:/workspace/file.txt",
};

describe("path lock service", () => {
  it("de-duplicates and globally orders an authorized batch before acquiring", async () => {
    const acquired: string[] = [];
    const fake = {
      acquire: async (_ownerId: string, resource: PathLockResource) => {
        acquired.push(resource.canonicalResourceId);
        return `lease-${acquired.length}`;
      },
      release: () => true,
      dropSession: () => {},
      dispose: () => {},
    } satisfies PathLockService;
    const service = createFsLockService(fake);
    const context: HarnessServiceContext = {
      actor: {
        authorityInstanceId: "broker",
        sessionId: "session-1",
        workerId: "worker",
        workerGeneration: 1,
        workspaceId: "workspace-1",
        grantedCapabilities: ["write.document"],
      },
      authorizedPaths: [
        { ...RESOURCE, canonicalResourceId: "b", inputPath: "b", resourceId: "b" },
        { ...RESOURCE, canonicalResourceId: "a", inputPath: "a", resourceId: "a" },
        { ...RESOURCE, canonicalResourceId: "a", inputPath: "alias-a", resourceId: "a" },
      ],
      sessionId: "session-1",
      workspaceId: "workspace-1",
      signal: new AbortController().signal,
    };
    await expect(service.handle({ action: "acquire", paths: ["b", "a", "alias-a"] }, context)).resolves.toEqual({
      held: true,
      leaseIds: ["lease-1", "lease-2"],
    });
    expect(acquired).toEqual(["a", "b"]);
  });

  it("uses an opaque owner-bound lease for release", async () => {
    const locks = createPathLockService();
    const lease = await locks.acquire("session-1", RESOURCE);
    expect(lease).toMatch(/^lease-/);
    expect(locks.release("session-2", lease)).toBe(false);
    expect(locks.release("session-1", lease)).toBe(true);
    expect(locks.release("session-1", lease)).toBe(false);
    locks.dispose();
  });

  it("serializes two sessions targeting the same canonical resource", async () => {
    const locks = createPathLockService();
    const first = await locks.acquire("session-1", RESOURCE);
    let secondGranted = false;
    const secondPromise = locks.acquire("session-2", RESOURCE).then((lease) => {
      secondGranted = true;
      return lease;
    });
    await Promise.resolve();
    expect(secondGranted).toBe(false);
    locks.release("session-1", first);
    const second = await secondPromise;
    expect(secondGranted).toBe(true);
    expect(locks.release("session-1", second)).toBe(false);
    expect(locks.release("session-2", second)).toBe(true);
    locks.dispose();
  });

  it("does not couple different workspaces or Host authorities", async () => {
    const locks = createPathLockService();
    const leases = await Promise.all([
      locks.acquire("session-1", RESOURCE),
      locks.acquire("session-2", { ...RESOURCE, workspaceId: "workspace-2" }),
      locks.acquire("session-3", { ...RESOURCE, authorityId: "host-2" }),
    ]);
    expect(new Set(leases).size).toBe(3);
    expect(locks.release("session-1", leases[0]!)).toBe(true);
    expect(locks.release("session-2", leases[1]!)).toBe(true);
    expect(locks.release("session-3", leases[2]!)).toBe(true);
    locks.dispose();
  });

  it("removes a timed-out waiter without disturbing the holder", async () => {
    const locks = createPathLockService();
    const holder = await locks.acquire("session-1", RESOURCE);
    await expect(locks.acquire("session-2", RESOURCE, 25)).rejects.toThrow("Lock timeout");
    expect(locks.release("session-1", holder)).toBe(true);
    const next = await locks.acquire("session-3", RESOURCE);
    expect(locks.release("session-3", next)).toBe(true);
    locks.dispose();
  });

  it("dropping an owner rejects its waiters and hands held resources to the next session", async () => {
    const locks = createPathLockService();
    await locks.acquire("session-1", RESOURCE);
    const ownWaiter = locks.acquire("session-1", RESOURCE, 10_000);
    const nextWaiter = locks.acquire("session-2", RESOURCE, 10_000);
    locks.dropSession("session-1");
    await expect(ownWaiter).rejects.toThrow("Session dropped");
    const next = await nextWaiter;
    expect(locks.release("session-2", next)).toBe(true);
    locks.dispose();
  });

  it("dispose rejects pending waiters", async () => {
    const locks = createPathLockService();
    await locks.acquire("session-1", RESOURCE);
    const pending = locks.acquire("session-2", RESOURCE, 10_000);
    locks.dispose();
    await expect(pending).rejects.toThrow("disposed");
  });
});
