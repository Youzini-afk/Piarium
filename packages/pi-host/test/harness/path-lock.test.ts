import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { withPathLock } from "../../src/harness/path-lock.js";
import type { HostServicesBridge } from "../../src/harness/host-services-bridge.js";

function createFakeBridge(options: { failAcquire?: boolean } = {}) {
  const acquisitions: string[][] = [];
  const releases: string[] = [];
  const bridge = {
    request: async (method: string, params: Record<string, unknown>) => {
      if (method !== "fs.lock") throw new Error(`unexpected method: ${method}`);
      if (params.action === "acquire") {
        const paths = params.paths as string[];
        acquisitions.push(paths);
        if (options.failAcquire) return { held: false, released: false };
        return { held: true, leaseIds: paths.map((_, index) => `lease-${index + 1}`) };
      }
      releases.push(params.leaseId as string);
      return { held: false, released: true };
    },
  } as unknown as HostServicesBridge;
  return { bridge, acquisitions, releases };
}

describe("withPathLock", () => {
  it("acquires a path set in one Host request and releases opaque leases", async () => {
    const harness = createFakeBridge();
    const result = await withPathLock(harness.bridge, ["/a.txt", "/b.txt"], async () => 42);
    assert.equal(result, 42);
    assert.deepEqual(harness.acquisitions, [["/a.txt", "/b.txt"]]);
    assert.deepEqual(harness.releases, ["lease-2", "lease-1"]);
  });

  it("releases every lease when the protected operation throws", async () => {
    const harness = createFakeBridge();
    await assert.rejects(
      withPathLock(harness.bridge, ["/a.txt", "/b.txt"], async () => { throw new Error("boom"); }),
      /boom/,
    );
    assert.deepEqual(harness.releases, ["lease-2", "lease-1"]);
  });

  it("does not run the operation or release invented leases when acquire fails", async () => {
    const harness = createFakeBridge({ failAcquire: true });
    let ran = false;
    await assert.rejects(withPathLock(harness.bridge, ["/locked.txt"], async () => {
      ran = true;
    }), /Failed to acquire/);
    assert.equal(ran, false);
    assert.deepEqual(harness.releases, []);
  });

  it("skips the Host round trip for an empty path set", async () => {
    const harness = createFakeBridge();
    const result = await withPathLock(harness.bridge, [], async () => "ok");
    assert.equal(result, "ok");
    assert.deepEqual(harness.acquisitions, []);
  });
});
