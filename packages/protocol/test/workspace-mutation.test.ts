import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createEvent,
  createRequest,
  decodeEnvelope,
  decodeRuntimeEnvelope,
  encodeEnvelope,
  isHostEvent,
  isRuntimeMethod,
  PIARIUM_PROTOCOL_VERSION,
  ProtocolDecodeError,
} from "../src/index.js";

describe("workspace mutation journal protocol", () => {
  it("round-trips the negotiated capability, blocking event, and worker response", () => {
    const handshake = createRequest("handshake", "host.handshake", {
      capabilities: { workspaceMutationJournal: true },
      clientName: "web-host",
      clientVersion: "0.1.0",
      mode: "web",
      protocolVersions: [PIARIUM_PROTOCOL_VERSION],
    });
    const before = createEvent(1, "workspace.mutation.request", {
      path: "C:\\workspace\\src\\index.ts",
      phase: "before",
      requestId: "mutation-1",
      sessionId: "session-1",
      toolCallId: "tool-1",
      toolName: "edit",
    });
    const after = createEvent(2, "workspace.mutation.request", {
      path: "C:\\workspace\\src\\index.ts",
      phase: "after",
      requestId: "mutation-2",
      sessionId: "session-1",
      succeeded: true,
      toolCallId: "tool-1",
      toolName: "edit",
    });
    const response = createRequest("respond", "workspace.mutation.respond", {
      accepted: false,
      requestId: "mutation-1",
      sessionId: "session-1",
    });

    for (const envelope of [handshake, before, after, response]) {
      assert.deepEqual(decodeEnvelope(encodeEnvelope(envelope).trimEnd()), envelope);
    }
    assert.equal(isHostEvent("workspace.mutation.request"), true);
  });

  it("keeps the response method off the browser runtime contract", () => {
    assert.equal(isRuntimeMethod("workspace.mutation.respond"), false);
    assert.throws(
      () => decodeRuntimeEnvelope(JSON.stringify({
        id: "respond",
        kind: "request",
        method: "workspace.mutation.respond",
        params: {
          accepted: true,
          requestId: "mutation-1",
          sessionId: "session-1",
        },
        v: PIARIUM_PROTOCOL_VERSION,
      })),
      (error: unknown) => {
        assert.ok(error instanceof ProtocolDecodeError);
        assert.equal(error.code, "unsupported_method");
        return true;
      },
    );
  });
});
