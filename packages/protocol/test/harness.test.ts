import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  HARNESS_METHOD_CAPABILITY,
  HOST_EVENTS,
  isHarnessMethod,
  isHostEvent,
  type HarnessMethod,
  type HarnessRequestData,
  type HarnessError,
  type FsLockParams,
  type FsLockResult,
} from "../src/index.js";

describe("harness protocol", () => {
  it("includes harness.request in HOST_EVENTS", () => {
    assert.ok(HOST_EVENTS.includes("harness.request" as never));
    assert.ok(isHostEvent("harness.request"));
  });

  it("isHarnessMethod recognizes all defined methods", () => {
    const expected = Object.keys(HARNESS_METHOD_CAPABILITY) as HarnessMethod[];
    for (const method of expected) {
      assert.ok(isHarnessMethod(method), `${method} should be a harness method`);
    }
  });

  it("keeps session identity out of worker request payloads", () => {
    const request = {
      method: "output.read",
      params: { handle: "out_example" },
      requestId: "request-1",
    } satisfies HarnessRequestData;
    assert.equal("sessionId" in request, false);
    assert.equal(HARNESS_METHOD_CAPABILITY[request.method], "read.output");
  });

  it("keeps authorization, expiry, absence, and service failure distinct", () => {
    const codes: HarnessError["code"][] = ["forbidden", "denied", "expired", "not-found", "unavailable", "failed"];
    assert.equal(new Set(codes).size, codes.length);
  });

  it("uses a batch acquire and lease-only release contract for path locks", () => {
    const acquire = { action: "acquire", paths: ["a.ts", "b.ts"] } satisfies FsLockParams;
    const release = { action: "release", leaseId: "lease-1" } satisfies FsLockParams;
    const acquired = { held: true, leaseIds: ["lease-1", "lease-2"] } satisfies FsLockResult;
    assert.equal(acquire.paths.length, 2);
    assert.equal(release.leaseId, "lease-1");
    assert.equal(acquired.leaseIds.length, 2);
  });

  it("isHarnessMethod rejects unknown methods", () => {
    assert.ok(!isHarnessMethod("unknown.method"));
    assert.ok(!isHarnessMethod(""));
    assert.ok(!isHarnessMethod(123 as unknown as string));
    assert.ok(!isHarnessMethod(null as unknown as string));
  });
});
