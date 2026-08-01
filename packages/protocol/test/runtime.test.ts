import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createRuntimeEvent,
  createRuntimeRequest,
  decodeRuntimeEnvelope,
  encodeRuntimeEnvelope,
  isRuntimeMethod,
  ProtocolDecodeError,
} from "../src/index.js";

describe("surface runtime protocol", () => {
  it("round-trips session-scoped requests", () => {
    const request = createRuntimeRequest("req-1", "provider.list", {
      sessionId: "session-1",
    });

    assert.deepEqual(decodeRuntimeEnvelope(encodeRuntimeEnvelope(request)), request);
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
          '{"v":1,"kind":"request","id":"x","method":"host.shutdown","params":{}}',
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
          '{"v":1,"kind":"event","seq":0,"event":"session.closed","data":{"sessionId":"s"}}',
        ),
      /event.source/,
    );
    assert.throws(
      () =>
        decodeRuntimeEnvelope(
          '{"v":1,"kind":"event","seq":0,"event":"unknown","data":{},"source":{"role":"catalog","workerId":"w"}}',
        ),
      (error: unknown) => {
        assert.ok(error instanceof ProtocolDecodeError);
        assert.equal(error.code, "unsupported_event");
        return true;
      },
    );
  });
});
