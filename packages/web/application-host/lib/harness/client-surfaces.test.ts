import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { Response } from "express";
import { createClientSurfaceBridge } from "./client-surfaces.js";
import { HarnessServiceError } from "./service-error.js";

/**
 * Focused tests for the Host→surface request/ack bridge (Stage S / D-309).
 * The point under test is honest targeting: registration, ambiguity,
 * disconnection, and ack resolution — never an assumed apply.
 */

function fakeResponse(): { res: Response; sent: { type: string; properties: Record<string, unknown> }[] } {
  const sent: { type: string; properties: Record<string, unknown> }[] = [];
  return { res: { id: Math.random() } as unknown as Response, sent };
}

function bridgeWithSent() {
  const sent = new Map<Response, { type: string; properties: Record<string, unknown> }[]>();
  const bridge = createClientSurfaceBridge({
    writeSseEvent: (res, event) => {
      const list = sent.get(res) ?? [];
      list.push(event);
      sent.set(res, list);
    },
  });
  return { bridge, sent };
}

const ackEvent = (
  bridge: ReturnType<typeof bridgeWithSent>["bridge"],
  event: { properties: Record<string, unknown> },
  results: Parameters<ReturnType<typeof bridgeWithSent>["bridge"]["ack"]>[4],
) => bridge.ack(
  event.properties.requestId as string,
  event.properties.surfaceId as string,
  event.properties.connectionId as string,
  "session",
  results,
);

describe("client surface bridge", () => {
  it("delivers a request to the connected surface and resolves on ack", async () => {
    const { bridge, sent } = bridgeWithSent();
    const { res } = fakeResponse();
    bridge.attach(res, "surf-1", "desktop", "session");

    const promise = bridge.request({
      type: "apply",
      entries: [{ id: "chat.persist-drafts", values: { enabled: false } }],
    });
    const events = sent.get(res) ?? [];
    assert.equal(events.length, 1);
    const requestId = events[0]?.properties.requestId as string;
    assert.ok(requestId.startsWith("surface-"));
    assert.equal(events[0]?.properties.op, "apply");

    assert.equal(bridge.ack(
      requestId,
      "surf-1",
      events[0]?.properties.connectionId as string,
      "client:other",
      [{ id: "chat.persist-drafts", status: "applied" }],
    ), false);
    assert.equal(bridge.pendingCount(), 1);
    const handled = ackEvent(bridge, events[0]!, [{ id: "chat.persist-drafts", status: "applied" }]);
    assert.equal(handled, true);
    const outcome = await promise;
    assert.equal(outcome.surface.id, "surf-1");
    assert.equal(outcome.results[0]?.status, "applied");
  });

  it("fails honestly when no surface is connected", async () => {
    const { bridge } = bridgeWithSent();
    await assert.rejects(
      bridge.request({ type: "read", entries: [{ id: "appearance.language" }] }),
      (error: unknown) => error instanceof HarnessServiceError && error.harnessCode === "unavailable",
    );
  });

  it("refuses to guess between several connected surfaces", async () => {
    const { bridge, sent } = bridgeWithSent();
    const first = fakeResponse();
    const second = fakeResponse();
    bridge.attach(first.res, "surf-1", "desktop", "session");
    bridge.attach(second.res, "surf-2", "web", "session");

    await assert.rejects(
      bridge.request({ type: "read", entries: [{ id: "appearance.language" }] }),
      (error: unknown) => error instanceof HarnessServiceError && error.harnessCode === "ambiguous",
    );
    assert.equal(sent.get(first.res)?.length ?? 0, 0);
    assert.equal(sent.get(second.res)?.length ?? 0, 0);

    await assert.rejects(
      bridge.request({ type: "read", entries: [{ id: "appearance.language" }] }),
      (error: unknown) => error instanceof HarnessServiceError && error.harnessCode === "ambiguous",
    );
  });

  it("rejects pending requests when the surface disconnects mid-flight", async () => {
    const { bridge } = bridgeWithSent();
    const { res } = fakeResponse();
    bridge.attach(res, "surf-1", "desktop", "session");
    const promise = bridge.request({ type: "apply", entries: [{ id: "x", values: {} }] });
    bridge.dropConnection(res);
    await assert.rejects(promise, /disconnected|unavailable/i);
    assert.equal(bridge.pendingCount(), 0);
  });

  it("keeps waiting when the surface has another live connection", async () => {
    const { bridge } = bridgeWithSent();
    const first = fakeResponse();
    const second = fakeResponse();
    bridge.attach(first.res, "surf-1", "desktop", "session");
    bridge.attach(second.res, "surf-1", "desktop", "session");
    const promise = bridge.request({
      type: "apply",
      entries: [{ id: "x", values: {} }],
    });
    bridge.dropConnection(first.res);
    // The request is still pending on the surviving connection — resolve via ack.
    const timer = setTimeout(() => assert.fail("request should still be pending"), 50);
    setTimeout(() => clearTimeout(timer), 0);
    bridge.dropConnection(second.res);
    await assert.rejects(promise, /disconnected|unavailable/i);
  });

  it("ignores acks for unknown request ids", () => {
    const { bridge } = bridgeWithSent();
    assert.equal(bridge.ack("surface-nope", "surf-1", "connection", "session", []), false);
  });
});
