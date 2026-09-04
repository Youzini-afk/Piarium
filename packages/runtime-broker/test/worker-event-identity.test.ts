import assert from "node:assert/strict";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { createEvent, type EventEnvelope } from "@piarium/protocol";
import { PiHostClient } from "../src/host-client.js";
import { classifyWorkerEventIdentity } from "../src/runtime-broker.js";

const snapshotEvent = (sessionId: string): EventEnvelope => createEvent(
  0,
  "session.snapshot",
  { sessionId } as never,
);

const harnessEvent = (sessionId: string): EventEnvelope => createEvent(
  0,
  "harness.request",
  {
    method: "output.read",
    params: { handle: "out_example" },
    requestId: "request-1",
    sessionId,
  },
);

describe("broker-owned worker session identity", () => {
  it("changes a client session only through an explicit broker pin", () => {
    const client = new PiHostClient({
      handshake: {
        clientName: "identity-test",
        clientVersion: "0.1.0",
        mode: "test",
      },
      hostEntry: resolve(import.meta.filename),
    });

    assert.equal(client.sessionId, undefined);
    client.pinSession("session-1");
    assert.equal(client.sessionId, "session-1");

    const finishTransition = client.beginSessionTransition();
    assert.equal(client.sessionTransitioning, true);
    finishTransition();
    finishTransition();
    assert.equal(client.sessionTransitioning, false);

    client.pinSession("session-2");
    assert.equal(client.sessionId, "session-2");
  });

  it("ignores bootstrap snapshots until a method response pins the worker", () => {
    assert.equal(classifyWorkerEventIdentity({
      envelope: snapshotEvent("session-1"),
      pinnedSessionId: undefined,
      role: "session",
      transitioning: false,
    }), "ignore-unbound-snapshot");
  });

  it("accepts matching session events and rejects a mismatched claim", () => {
    assert.equal(classifyWorkerEventIdentity({
      envelope: harnessEvent("session-1"),
      pinnedSessionId: "session-1",
      role: "session",
      transitioning: false,
    }), "accept");
    assert.equal(classifyWorkerEventIdentity({
      envelope: harnessEvent("session-2"),
      pinnedSessionId: "session-1",
      role: "session",
      transitioning: false,
    }), "reject");
  });

  it("rejects an unpinned harness request", () => {
    assert.equal(classifyWorkerEventIdentity({
      envelope: harnessEvent("session-forged"),
      pinnedSessionId: undefined,
      role: "session",
      transitioning: false,
    }), "reject");
  });

  it("ignores only a transition snapshot while a broker-issued switch is pending", () => {
    assert.equal(classifyWorkerEventIdentity({
      envelope: snapshotEvent("session-2"),
      pinnedSessionId: "session-1",
      role: "session",
      transitioning: true,
    }), "ignore-transition-snapshot");
    assert.equal(classifyWorkerEventIdentity({
      envelope: harnessEvent("session-2"),
      pinnedSessionId: "session-1",
      role: "session",
      transitioning: true,
    }), "reject");
  });

  it("does not impose session pinning on catalog and package workers", () => {
    assert.equal(classifyWorkerEventIdentity({
      envelope: harnessEvent("catalog-context"),
      pinnedSessionId: undefined,
      role: "catalog",
      transitioning: false,
    }), "accept");
  });
});
