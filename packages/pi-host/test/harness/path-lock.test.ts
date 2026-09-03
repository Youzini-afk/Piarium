import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { withPathLock } from "../../src/harness/path-lock.js";
import type { HostServicesBridge } from "../../src/harness/host-services-bridge.js";

function createFakeBridge(acquired: string[], released: string[], failOn?: string): Pick<HostServicesBridge, "request"> {
  return {
    request: async (method: string, params: Record<string, unknown>) => {
      if (method !== "fs.lock") throw new Error(`unexpected method: ${method}`);
      const path = params.path as string;
      const action = params.action as string;
      if (action === "acquire") {
        if (failOn === path) return { held: false };
        acquired.push(path);
        return { held: true };
      }
      if (action === "release") {
        released.push(path);
        return { held: false };
      }
      throw new Error(`unknown action: ${action}`);
    },
  } as unknown as Pick<HostServicesBridge, "request">;
}

describe("withPathLock", () => {
  it("acquires and releases a single path lock", async () => {
    const acquired: string[] = [];
    const released: string[] = [];
    const bridge = createFakeBridge(acquired, released);

    const result = await withPathLock(bridge as HostServicesBridge, "s1", ["/file.txt"], async () => 42);
    assert.equal(result, 42);
    assert.deepEqual(acquired, ["/file.txt"]);
    assert.deepEqual(released, ["/file.txt"]);
  });

  it("acquires and releases multiple paths in order", async () => {
    const acquired: string[] = [];
    const released: string[] = [];
    const bridge = createFakeBridge(acquired, released);

    await withPathLock(bridge as HostServicesBridge, "s1", ["/a.txt", "/b.txt"], async () => "ok");
    assert.deepEqual(acquired, ["/a.txt", "/b.txt"]);
    // Released in reverse order
    assert.deepEqual(released, ["/b.txt", "/a.txt"]);
  });

  it("releases locks even when fn throws", async () => {
    const acquired: string[] = [];
    const released: string[] = [];
    const bridge = createFakeBridge(acquired, released);

    await assert.rejects(
      withPathLock(bridge as HostServicesBridge, "s1", ["/file.txt"], async () => { throw new Error("boom"); }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, "boom");
        return true;
      },
    );
    assert.deepEqual(acquired, ["/file.txt"]);
    assert.deepEqual(released, ["/file.txt"]);
  });

  it("throws when acquire fails", async () => {
    const acquired: string[] = [];
    const released: string[] = [];
    const bridge = createFakeBridge(acquired, released, "/locked.txt");

    await assert.rejects(
      withPathLock(bridge as HostServicesBridge, "s1", ["/locked.txt"], async () => "should not run"),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /Failed to acquire lock/);
        return true;
      },
    );
    // Nothing acquired, nothing released
    assert.deepEqual(acquired, []);
    assert.deepEqual(released, []);
  });

  it("releases already-acquired locks when a later acquire fails", async () => {
    const acquired: string[] = [];
    const released: string[] = [];
    const bridge = createFakeBridge(acquired, released, "/second.txt");

    await assert.rejects(
      withPathLock(bridge as HostServicesBridge, "s1", ["/first.txt", "/second.txt"], async () => "should not run"),
    );
    // First was acquired, second failed
    assert.deepEqual(acquired, ["/first.txt"]);
    // First should be released
    assert.deepEqual(released, ["/first.txt"]);
  });

  it("skips locking for empty paths array", async () => {
    const acquired: string[] = [];
    const released: string[] = [];
    const bridge = createFakeBridge(acquired, released);

    const result = await withPathLock(bridge as HostServicesBridge, "s1", [], async () => "no locks");
    assert.equal(result, "no locks");
    assert.deepEqual(acquired, []);
    assert.deepEqual(released, []);
  });
});
