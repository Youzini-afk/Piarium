import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HostServicesBridge, HarnessRequestError } from "../../src/harness/host-services-bridge.js";
import type { HarnessRequestData, HarnessError } from "@piarium/protocol";

/**
 * Contract test: the respond payload format produced by HarnessRouter
 * (in @piarium/web application-host) flows through respondHarness to
 * the bridge's waiting caller.
 *
 * The router's respond callback produces:
 *   { ok: true, result } | { ok: false, error: HarnessError }
 * This test simulates that format and verifies respondHarness +
 * bridge.respond deliver it correctly.
 */
describe("harness router → bridge contract", () => {
  it("ok result reaches the bridge waiting caller", async () => {
    const emitted: HarnessRequestData[] = [];
    const sessionId = "contract-1";

    const bridge = new HostServicesBridge({
      emit: (_event, data) => { emitted.push(data); },
      sessionId,
      defaultTimeoutMs: 5000,
    });

    // Simulate the host-side respond function that calls bridge.respond
    // with the same payload format the HarnessRouter produces
    const simulateRouterRespond = (
      sid: string,
      requestId: string,
      outcome: { ok: true; result: unknown } | { ok: false; error: HarnessError },
    ) => {
      return bridge.respond(sid, requestId, outcome);
    };

    // Make a request through the bridge
    const resultPromise = bridge.request("output.store", { text: "hello" });
    assert.equal(emitted.length, 1);
    const requestData = emitted[0]!;

    // Simulate router dispatching to a service and responding
    // (in real system: router.processEvent → service.handle → respond)
    simulateRouterRespond(sessionId, requestData.requestId, {
      ok: true,
      result: { handle: "out_test", total: 5 },
    });

    const result = await resultPromise;
    assert.deepEqual(result, { handle: "out_test", total: 5 });

    bridge.dispose();
  });

  it("error result reaches the bridge waiting caller as rejection", async () => {
    const emitted: HarnessRequestData[] = [];
    const sessionId = "contract-2";

    const bridge = new HostServicesBridge({
      emit: (_event, data) => { emitted.push(data); },
      sessionId,
      defaultTimeoutMs: 5000,
    });

    const simulateRouterRespond = (
      sid: string,
      requestId: string,
      outcome: { ok: true; result: unknown } | { ok: false; error: HarnessError },
    ) => {
      return bridge.respond(sid, requestId, outcome);
    };

    const resultPromise = bridge.request("output.store", { text: "hello" });
    const requestData = emitted[0]!;

    // Simulate router responding with an error (service threw)
    const harnessError: HarnessError = {
      code: "failed",
      message: "service unavailable",
    };
    simulateRouterRespond(sessionId, requestData.requestId, {
      ok: false,
      error: harnessError,
    });

    await assert.rejects(resultPromise, (error: unknown) => {
      assert.ok(error instanceof HarnessRequestError);
      assert.equal(error.code, "failed");
      assert.match(error.message, /service unavailable/);
      return true;
    });

    bridge.dispose();
  });

  it("timeout error from router reaches bridge as retryable rejection", async () => {
    const emitted: HarnessRequestData[] = [];
    const sessionId = "contract-3";

    const bridge = new HostServicesBridge({
      emit: (_event, data) => { emitted.push(data); },
      sessionId,
      defaultTimeoutMs: 5000,
    });

    const simulateRouterRespond = (
      sid: string,
      requestId: string,
      outcome: { ok: true; result: unknown } | { ok: false; error: HarnessError },
    ) => {
      return bridge.respond(sid, requestId, outcome);
    };

    const resultPromise = bridge.request("shell.exec", { command: "sleep 999" });
    const requestData = emitted[0]!;

    // Simulate router timeout (AbortController fired)
    simulateRouterRespond(sessionId, requestData.requestId, {
      ok: false,
      error: { code: "timeout", message: "harness request timed out", retryable: true },
    });

    await assert.rejects(resultPromise, (error: unknown) => {
      assert.ok(error instanceof HarnessRequestError);
      assert.equal(error.code, "timeout");
      assert.equal(error.retryable, true);
      return true;
    });

    bridge.dispose();
  });
});
