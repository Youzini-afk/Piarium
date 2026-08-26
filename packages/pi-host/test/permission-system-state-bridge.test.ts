import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { HostEvent, HostEventData } from "@piarium/protocol";
import {
  createPermissionSystemStateBridgeExtension,
  PERMISSION_SYSTEM_STATUS_CHANNEL,
} from "../src/permission-system-state-bridge.js";

describe("permission-system state bridge", () => {
  it("projects readiness, pending prompts, decisions, and teardown without owning approval", async () => {
    const channelHandlers = new Map<string, (value: unknown) => void>();
    const lifecycleHandlers = new Map<string, (event: unknown, context: ExtensionContext) => unknown>();
    const events: Array<{ data: HostEventData<HostEvent>; event: HostEvent }> = [];
    const pi = {
      events: {
        emit: (channel: string, value: unknown) => channelHandlers.get(channel)?.(value),
        on: (channel: string, handler: (value: unknown) => void) => {
          channelHandlers.set(channel, handler);
          return () => channelHandlers.delete(channel);
        },
      },
      on: (event: string, handler: (value: unknown, context: ExtensionContext) => unknown) => {
        lifecycleHandlers.set(event, handler);
      },
    } as unknown as ExtensionAPI;
    await createPermissionSystemStateBridgeExtension((event, data) => {
      events.push({ data, event });
    })(pi);

    pi.events.emit("permissions:ready", { adjudicatesLocally: true, sessionId: "session-a" });
    assert.equal(events.length, 0);

    const context = {
      sessionManager: { getSessionId: () => "session-a" },
    } as unknown as ExtensionContext;
    await lifecycleHandlers.get("session_start")?.({}, context);
    assert.equal(events.length, 1);
    pi.events.emit("permissions:ui_prompt", {
      agentName: "reviewer",
      forwarding: null,
      requestId: "permission-1",
      request: {},
      source: "tool_call",
      surface: "bash",
      value: "git status",
    });

    assert.deepEqual(events.at(-1), {
      event: "extension.state",
      data: {
        channel: PERMISSION_SYSTEM_STATUS_CHANNEL,
        sessionId: "session-a",
        value: {
          adjudicatesLocally: true,
          lastDecision: null,
          pending: [{
            agentName: "reviewer",
            forwarding: null,
            requestId: "permission-1",
            source: "tool_call",
            surface: "bash",
            value: "git status",
          }],
          ready: true,
          version: 1,
        },
      },
    });

    pi.events.emit("permissions:decision", {
      agentName: "reviewer",
      matchedPattern: "git status",
      origin: "global",
      requestId: "permission-1",
      resolution: "user_approved",
      result: "allow",
      surface: "bash",
      value: "git status",
    });
    const decisionSnapshot = events.at(-1)?.data as HostEventData<"extension.state">;
    assert.equal(decisionSnapshot.channel, PERMISSION_SYSTEM_STATUS_CHANNEL);
    assert.deepEqual((decisionSnapshot.value as { pending: unknown[] }).pending, []);
    assert.equal((decisionSnapshot.value as { lastDecision: { result: string } }).lastDecision.result, "allow");

    await lifecycleHandlers.get("session_shutdown")?.({}, context);
    assert.deepEqual(events.at(-1), {
      event: "extension.state",
      data: {
        channel: PERMISSION_SYSTEM_STATUS_CHANNEL,
        sessionId: "session-a",
        value: null,
      },
    });
    const eventCount = events.length;
    pi.events.emit("permissions:ui_prompt", {
      requestId: "late",
      source: "tool_call",
    });
    assert.equal(events.length, eventCount);
  });

  it("ignores malformed and other-session ready events", async () => {
    const channelHandlers = new Map<string, (value: unknown) => void>();
    const lifecycleHandlers = new Map<string, (event: unknown, context: ExtensionContext) => unknown>();
    const events: unknown[] = [];
    const pi = {
      events: {
        on: (channel: string, handler: (value: unknown) => void) => {
          channelHandlers.set(channel, handler);
          return () => channelHandlers.delete(channel);
        },
      },
      on: (event: string, handler: (value: unknown, context: ExtensionContext) => unknown) => {
        lifecycleHandlers.set(event, handler);
      },
    } as unknown as ExtensionAPI;
    await createPermissionSystemStateBridgeExtension((_event, data) => events.push(data))(pi);
    const context = {
      sessionManager: { getSessionId: () => "session-a" },
    } as unknown as ExtensionContext;
    await lifecycleHandlers.get("session_start")?.({}, context);

    channelHandlers.get("permissions:ready")?.({ adjudicatesLocally: true, sessionId: "session-b" });
    channelHandlers.get("permissions:decision")?.({ requestId: "broken" });
    assert.deepEqual(events, []);
  });
});
