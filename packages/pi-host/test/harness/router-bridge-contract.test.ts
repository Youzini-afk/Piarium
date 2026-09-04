import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HostServicesBridge, HarnessRequestError } from "../../src/harness/host-services-bridge.js";
import { buildHarnessRespondParams, type HarnessRequestData, type HarnessError, type HarnessRespondParams } from "@piarium/protocol";

/**
 * Contract test: buildHarnessRespondParams (from @piarium/protocol) produces
 * a HarnessRespondParams that the host-controller's "harness.respond" handler
 * forwards to SessionHost.respondHarness, which calls bridge.respond, which
 * resolves the bridge's waiting caller.
 *
 * Real flow:
 *   web application-host: buildHarnessRespondParams(sid, rid, outcome)
 *     → piRuntimeBroker.requestForSession(sid, "harness.respond", params)
 *     → pi-host host-controller: case "harness.respond"
 *     → sessionHost.respondHarness(sid, rid, params)
 *     → bridge.respond(sid, rid, { ok, result } | { ok: false, error })
 *     → bridge waiting caller resolves/rejects
 *
 * This test exercises the params → respondHarness → bridge.respond → caller
 * path, using buildHarnessRespondParams to produce the params (same function
 * the web application-host uses).
 */
describe("harness router → bridge contract", () => {
  it("ok result: buildHarnessRespondParams → respondHarness → bridge caller resolves", async () => {
    const emitted: HarnessRequestData[] = [];
    const sessionId = "contract-1";

    const bridge = new HostServicesBridge({
      emit: (_event, data) => { emitted.push(data); },
      sessionId,
      defaultTimeoutMs: 5000,
    });

    // Simulate a session host that has this bridge registered
    const respondHarness = (
      sid: string,
      requestId: string,
      params: HarnessRespondParams,
    ): boolean => {
      if (params.ok) {
        return bridge.respond(sid, requestId, { ok: true, result: params.result });
      }
      if (!params.error) return false;
      return bridge.respond(sid, requestId, { ok: false, error: params.error });
    };

    // Make a request through the bridge
    const resultPromise = bridge.request("output.store", { text: "hello" });
    assert.equal(emitted.length, 1);
    const requestData = emitted[0]!;

    // Build params with the same function the web application-host uses
    const params = buildHarnessRespondParams(sessionId, requestData.requestId, {
      ok: true,
      result: { ref: { durability: "ephemeral", generation: "g", handle: "out_test" }, total: 5 },
    });
    assert.equal(params.ok, true);
    assert.equal(params.requestId, requestData.requestId);
    assert.equal(params.sessionId, sessionId);

    // Forward through respondHarness (mirrors host-controller's harness.respond handler)
    const accepted = respondHarness(sessionId, requestData.requestId, params);
    assert.equal(accepted, true);

    const result = await resultPromise;
    assert.deepEqual(result, { ref: { durability: "ephemeral", generation: "g", handle: "out_test" }, total: 5 });

    bridge.dispose();
  });

  it("error result: buildHarnessRespondParams → respondHarness → bridge caller rejects", async () => {
    const emitted: HarnessRequestData[] = [];
    const sessionId = "contract-2";

    const bridge = new HostServicesBridge({
      emit: (_event, data) => { emitted.push(data); },
      sessionId,
      defaultTimeoutMs: 5000,
    });

    const respondHarness = (
      sid: string,
      requestId: string,
      params: HarnessRespondParams,
    ): boolean => {
      if (params.ok) {
        return bridge.respond(sid, requestId, { ok: true, result: params.result });
      }
      if (!params.error) return false;
      return bridge.respond(sid, requestId, { ok: false, error: params.error });
    };

    const resultPromise = bridge.request("output.store", { text: "hello" });
    const requestData = emitted[0]!;

    const harnessError: HarnessError = {
      code: "failed",
      message: "service unavailable",
    };
    const params = buildHarnessRespondParams(sessionId, requestData.requestId, {
      ok: false,
      error: harnessError,
    });
    assert.equal(params.ok, false);
    assert.equal(params.error.code, "failed");

    respondHarness(sessionId, requestData.requestId, params);

    await assert.rejects(resultPromise, (error: unknown) => {
      assert.ok(error instanceof HarnessRequestError);
      assert.equal(error.code, "failed");
      assert.match(error.message, /service unavailable/);
      return true;
    });

    bridge.dispose();
  });

  it("timeout error: buildHarnessRespondParams → respondHarness → bridge rejects as retryable", async () => {
    const emitted: HarnessRequestData[] = [];
    const sessionId = "contract-3";

    const bridge = new HostServicesBridge({
      emit: (_event, data) => { emitted.push(data); },
      sessionId,
      defaultTimeoutMs: 5000,
    });

    const respondHarness = (
      sid: string,
      requestId: string,
      params: HarnessRespondParams,
    ): boolean => {
      if (params.ok) {
        return bridge.respond(sid, requestId, { ok: true, result: params.result });
      }
      if (!params.error) return false;
      return bridge.respond(sid, requestId, { ok: false, error: params.error });
    };

    const resultPromise = bridge.request("shell.exec", { command: "sleep 999" });
    const requestData = emitted[0]!;

    const params = buildHarnessRespondParams(sessionId, requestData.requestId, {
      ok: false,
      error: { code: "timeout", message: "harness request timed out", retryable: true },
    });
    assert.equal(params.ok, false);
    assert.equal(params.error.retryable, true);

    respondHarness(sessionId, requestData.requestId, params);

    await assert.rejects(resultPromise, (error: unknown) => {
      assert.ok(error instanceof HarnessRequestError);
      assert.equal(error.code, "timeout");
      assert.equal(error.retryable, true);
      return true;
    });

    bridge.dispose();
  });
});
