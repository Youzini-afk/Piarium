import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createRuntimeEvent,
  createRuntimeRequest,
  decodeRuntimeEnvelope,
  encodeRuntimeEnvelope,
  isRuntimeMethod,
  PIARIUM_PROTOCOL_VERSION,
  ProtocolDecodeError,
} from "../src/index.js";

describe("surface runtime protocol", () => {
  it("round-trips session-scoped requests", () => {
    const request = createRuntimeRequest("req-1", "provider.list", {
      sessionId: "session-1",
    });

    assert.deepEqual(decodeRuntimeEnvelope(encodeRuntimeEnvelope(request)), request);
    assert.equal(isRuntimeMethod("session.tree"), true);
    assert.equal(isRuntimeMethod("session.archive"), true);
    assert.equal(isRuntimeMethod("session.unarchive"), true);
    assert.equal(isRuntimeMethod("session.delete"), true);
    assert.equal(isRuntimeMethod("thinking.select"), true);
    assert.equal(isRuntimeMethod("recovery.status"), true);
    assert.equal(isRuntimeMethod("recovery.navigate"), true);
    assert.equal(isRuntimeMethod("recovery.repair"), true);
    assert.equal(isRuntimeMethod("recovery.apply"), false);
  });

  it("carries an explicit worker source on events", () => {
    const event = createRuntimeEvent(
      { role: "session", sessionId: "session-1", workerId: "worker-1" },
      12,
      "session.closed",
      { sessionId: "session-1" },
    );

    assert.deepEqual(decodeRuntimeEnvelope(encodeRuntimeEnvelope(event)), event);
  });

  it("rejects worker-only methods and unrouted events", () => {
    assert.equal(isRuntimeMethod("host.shutdown"), false);
    assert.throws(
      () =>
        decodeRuntimeEnvelope(
          JSON.stringify({
            id: "x",
            kind: "request",
            method: "host.shutdown",
            params: {},
            v: PIARIUM_PROTOCOL_VERSION,
          }),
        ),
      (error: unknown) => {
        assert.ok(error instanceof ProtocolDecodeError);
        assert.equal(error.code, "unsupported_method");
        return true;
      },
    );
    assert.throws(
      () =>
        decodeRuntimeEnvelope(
          JSON.stringify({
            data: { sessionId: "s" },
            event: "session.closed",
            kind: "event",
            seq: 0,
            v: PIARIUM_PROTOCOL_VERSION,
          }),
        ),
      /event.source/,
    );
    assert.throws(
      () =>
        decodeRuntimeEnvelope(
          JSON.stringify({
            data: {},
            event: "unknown",
            kind: "event",
            seq: 0,
            source: { role: "catalog", workerId: "w" },
            v: PIARIUM_PROTOCOL_VERSION,
          }),
        ),
      (error: unknown) => {
        assert.ok(error instanceof ProtocolDecodeError);
        assert.equal(error.code, "unsupported_event");
        return true;
      },
    );
  });
});
