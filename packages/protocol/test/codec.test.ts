import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createEvent,
  createRequest,
  createSuccessResponse,
  decodeEnvelope,
  encodeEnvelope,
  JsonLineDecoder,
  PIARIUM_PROTOCOL_VERSION,
  ProtocolDecodeError,
} from "../src/index.js";

describe("protocol envelopes", () => {
  it("round-trips typed requests", () => {
    const request = createRequest("req-1", "host.handshake", {
      clientName: "test",
      clientVersion: "0.0.0",
      mode: "test",
      protocolVersions: [PIARIUM_PROTOCOL_VERSION],
    });

    assert.deepEqual(decodeEnvelope(encodeEnvelope(request).trimEnd()), request);
  });

  it("round-trips responses and events", () => {
    const response = createSuccessResponse<"agent.abort">("req-2", { aborted: true });
    const event = createEvent(4, "session.closed", { sessionId: "session-1" });

    assert.deepEqual(decodeEnvelope(encodeEnvelope(response).trimEnd()), response);
    assert.deepEqual(decodeEnvelope(encodeEnvelope(event).trimEnd()), event);
  });

  it("rejects malformed and unsupported envelopes", () => {
    assert.throws(
      () => decodeEnvelope("{"),
      (error: unknown) => {
        assert.ok(error instanceof ProtocolDecodeError);
        assert.equal(error.code, "invalid_json");
        return true;
      },
    );
    assert.throws(
      () => decodeEnvelope('{"v":999,"kind":"request","id":"x","method":"x","params":{}}'),
      /Unsupported protocol version/,
    );
    assert.throws(
      () =>
        decodeEnvelope(
          JSON.stringify({
            data: {},
            event: "x",
            kind: "event",
            seq: -1,
            v: PIARIUM_PROTOCOL_VERSION,
          }),
        ),
      /event.seq/,
    );
  });
});

describe("JsonLineDecoder", () => {
  it("decodes split UTF-8 and CRLF frames", () => {
    const decoder = new JsonLineDecoder();
    const first = encodeEnvelope(
      createRequest("req-3", "command.execute", { command: "/检查", sessionId: "s" }),
    ).replace("\n", "\r\n");
    const second = encodeEnvelope(createEvent(5, "session.closed", { sessionId: "s" }));
    const bytes = new TextEncoder().encode(first + second);
    const split = bytes.indexOf(230) + 1;

    assert.deepEqual(decoder.push(bytes.slice(0, split)), []);
    const envelopes = decoder.push(bytes.slice(split));

    assert.equal(envelopes.length, 2);
    assert.equal(envelopes[0]?.kind, "request");
    assert.equal(envelopes[1]?.kind, "event");
    assert.deepEqual(decoder.finish(), []);
  });

  it("decodes a final frame without a newline", () => {
    const decoder = new JsonLineDecoder();
    const frame = encodeEnvelope(createEvent(6, "session.closed", { sessionId: "s" })).trimEnd();

    assert.deepEqual(decoder.push(frame), []);
    assert.equal(decoder.finish().length, 1);
  });

  it("rejects oversized frames and clears buffered data", () => {
    const decoder = new JsonLineDecoder({ maxFrameBytes: 16 });

    assert.throws(
      () => decoder.push("x".repeat(17)),
      (error: unknown) => {
        assert.ok(error instanceof ProtocolDecodeError);
        assert.equal(error.code, "frame_too_large");
        return true;
      },
    );
    assert.deepEqual(decoder.finish(), []);
  });
});
