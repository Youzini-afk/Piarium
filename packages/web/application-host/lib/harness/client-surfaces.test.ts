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

describe("client surface bridge", () => {
  it("delivers a request to the connected surface and resolves on ack", async () => {
    const { bridge, sent } = bridgeWithSent();
    const { res } = fakeResponse();
    bridge.attach(res, "surf-1", "desktop");

    const promise = bridge.request({
      type: "apply",
      entries: [{ id: "chat.persist-drafts", values: { enabled: false } }],
    });
    const events = sent.get(res) ?? [];
    assert.equal(events.length, 1);
    const requestId = events[0]?.properties.requestId as string;
    assert.ok(requestId.startsWith("surface-"));
    assert.equal(events[0]?.properties.op, "apply");

    const handled = bridge.ack(requestId, [{ id: "chat.persist-drafts", status: "applied" }]);
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
    bridge.attach(first.res, "surf-1", "desktop");
    bridge.attach(second.res, "surf-2", "web");

    await assert.rejects(
      bridge.request({ type: "read", entries: [{ id: "appearance.language" }] }),
      (error: unknown) => error instanceof HarnessServiceError && error.harnessCode === "ambiguous",
    );
    assert.equal(sent.get(first.res)?.length ?? 0, 0);
    assert.equal(sent.get(second.res)?.length ?? 0, 0);

    const targeted = bridge.request({
      type: "read",
      entries: [{ id: "appearance.language" }],
      surfaceId: "surf-2",
    });
    const requestId = sent.get(second.res)?.[0]?.properties.requestId as string;
    bridge.ack(requestId, [{ id: "appearance.language", status: "applied", values: { locale: "fr" } }]);
    const outcome = await targeted;
    assert.equal(outcome.surface.id, "surf-2");
  });

  it("rejects pending requests when the surface disconnects mid-flight", async () => {
    const { bridge } = bridgeWithSent();
    const { res } = fakeResponse();
    bridge.attach(res, "surf-1", "desktop");
    const promise = bridge.request({ type: "apply", entries: [{ id: "x", values: {} }] });
    bridge.dropConnection(res);
    await assert.rejects(promise, /disconnected|unavailable/i);
    assert.equal(bridge.pendingCount(), 0);
  });

  it("keeps waiting when the surface has another live connection", async () => {
    const { bridge } = bridgeWithSent();
    const first = fakeResponse();
    const second = fakeResponse();
    bridge.attach(first.res, "surf-1", "desktop");
    bridge.attach(second.res, "surf-1", "desktop");
    const promise = bridge.request({
      type: "apply",
      entries: [{ id: "x", values: {} }],
      surfaceId: "surf-1",
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
    assert.equal(bridge.ack("surface-nope", []), false);
  });
});
