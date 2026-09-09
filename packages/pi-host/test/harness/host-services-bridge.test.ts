import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  HostServicesBridge,
  HarnessRequestError,
} from "../../src/harness/host-services-bridge.js";
import type { HarnessCancelData, HarnessRequestData } from "@piarium/protocol";

describe("HostServicesBridge", () => {
  it("correlates request and response by requestId", async () => {
    const emitted: HarnessRequestData[] = [];
    const bridge = new HostServicesBridge({
      emit: (_event, data) => { emitted.push(data); },
      sessionId: "session-1",
    });
    const resultPromise = bridge.request("output.store", { text: "hello" });
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0]!.method, "output.store");
    assert.ok(!("sessionId" in emitted[0]!));
    const requestId = emitted[0]!.requestId;
    bridge.respond("session-1", requestId, { ok: true, result: { ref: { durability: "ephemeral", generation: "g", handle: "out_abc" }, total: 5 } });
    const result = await resultPromise;
    assert.deepEqual(result, { ref: { durability: "ephemeral", generation: "g", handle: "out_abc" }, total: 5 });
    bridge.dispose();
  });

  it("rejects on timeout", async () => {
    const emitted: Array<{ event: string; data: HarnessRequestData | HarnessCancelData }> = [];
    const bridge = new HostServicesBridge({
      emit: (event, data) => { emitted.push({ event, data }); },
      sessionId: "session-1",
      defaultTimeoutMs: 50,
    });
    const resultPromise = bridge.request("shell.exec", { command: "echo hi" });
    await assert.rejects(resultPromise, (error: unknown) => {
      assert.ok(error instanceof HarnessRequestError);
      assert.equal(error.code, "timeout");
      return true;
    });
    const request = emitted.find((item) => item.event === "harness.request")?.data as HarnessRequestData;
    assert.ok(emitted.some((item) => item.event === "harness.cancel" && (item.data as HarnessCancelData).requestId === request.requestId));
    bridge.dispose();
  });

  it("rejects on abort signal", async () => {
    const bridge = new HostServicesBridge({
      emit: () => {},
      sessionId: "session-1",
      defaultTimeoutMs: 10_000,
    });
    const controller = new AbortController();
    const resultPromise = bridge.request("shell.exec", { command: "echo hi" }, { signal: controller.signal });
    controller.abort();
    await assert.rejects(resultPromise, (error: unknown) => {
      assert.ok(error instanceof HarnessRequestError);
      assert.equal(error.code, "failed");
      assert.equal(error.message, "aborted");
      return true;
    });
    bridge.dispose();
  });

  it("rejects all pending on dispose", async () => {
    const emitted: Array<{ event: string; data: HarnessRequestData | HarnessCancelData }> = [];
    const bridge = new HostServicesBridge({
      emit: (event, data) => { emitted.push({ event, data }); },
      sessionId: "session-1",
      defaultTimeoutMs: 10_000,
    });
    const p1 = bridge.request("shell.exec", { command: "a" });
    const p2 = bridge.request("shell.exec", { command: "b" });
    bridge.dispose();
    await assert.rejects(p1, (error: unknown) => {
      assert.ok(error instanceof HarnessRequestError);
      assert.equal(error.code, "failed");
      assert.equal(error.message, "disposed");
      return true;
    });
    await assert.rejects(p2, (error: unknown) => {
      assert.ok(error instanceof HarnessRequestError);
      return true;
    });
    const requestIds = emitted
      .filter((item) => item.event === "harness.request")
      .map((item) => (item.data as HarnessRequestData).requestId);
    const cancelled = new Set(emitted
      .filter((item) => item.event === "harness.cancel")
      .map((item) => (item.data as HarnessCancelData).requestId));
    assert.ok(requestIds.every((requestId) => cancelled.has(requestId)));
  });

  it("handles 50 concurrent requests each receiving their own result", async () => {
    const emitted: HarnessRequestData[] = [];
    const bridge = new HostServicesBridge({
      emit: (_event, data) => { emitted.push(data); },
      sessionId: "session-1",
      defaultTimeoutMs: 5_000,
    });
    const promises: Promise<unknown>[] = [];
    for (let i = 0; i < 50; i++) {
      promises.push(bridge.request("output.store", { text: `item-${i}` }));
    }
    // Wait for all emits to be collected
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(emitted.length, 50);
    // Respond to each with its own result
    for (let i = 0; i < 50; i++) {
      const data = emitted[i]!;
      bridge.respond("session-1", data.requestId, { ok: true, result: { ref: { durability: "ephemeral", generation: "g", handle: `out_${i}` }, total: i } });
    }
    const results = await Promise.all(promises);
    for (let i = 0; i < 50; i++) {
      assert.deepEqual(results[i], { ref: { durability: "ephemeral", generation: "g", handle: `out_${i}` }, total: i });
    }
    bridge.dispose();
  });

  it("emits harness.cancel on abort and does not start an already-aborted request", async () => {
    const emitted: Array<{ event: string; data: unknown }> = [];
    const bridge = new HostServicesBridge({
      emit: (event, data) => { emitted.push({ event, data }); },
      sessionId: "session-1",
      defaultTimeoutMs: 10_000,
    });
    const controller = new AbortController();
    const pending = bridge.request("explore.query.views", { queryId: "eq_1" }, { signal: controller.signal });
    controller.abort();
    await assert.rejects(pending);
    assert.ok(emitted.some((item) => item.event === "harness.cancel"));

    const late = new AbortController();
    late.abort();
    const before = emitted.length;
    await assert.rejects(bridge.request("explore.query.views", { queryId: "eq_1" }, { signal: late.signal }));
    assert.equal(emitted.slice(before).some((item) => item.event === "harness.request"), false);
    bridge.dispose();
  });

  it("ignores respond for wrong sessionId", async () => {
    const bridge = new HostServicesBridge({
      emit: () => {},
      sessionId: "session-1",
      defaultTimeoutMs: 10_000,
    });
    const resultPromise = bridge.request("output.store", { text: "hello" });
    // Wrong sessionId → should not resolve
    bridge.respond("session-wrong", "any-id", { ok: true, result: {} });
    // Correct respond still works (we need the requestId, but we can test with a fake one)
    // The wrong-sessionId respond should return false
    const accepted = bridge.respond("session-wrong", "fake-id", { ok: true, result: {} });
    assert.equal(accepted, false);
    // Clean up
    bridge.dispose();
    await assert.rejects(resultPromise);
  });
});
