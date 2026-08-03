import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  createPiSubagentsFleetBridgeExtension,
  PI_SUBAGENTS_RPC_READY_EVENT,
  PI_SUBAGENTS_RPC_REPLY_PREFIX,
  PI_SUBAGENTS_RPC_REQUEST_EVENT,
  PiSubagentsFleetBridge,
} from "../src/pi-subagents-fleet-bridge.js";

interface FakeExtensionRuntime {
  lifecycleHandlers: Map<string, (event: unknown, context: ExtensionContext) => unknown>;
  pi: ExtensionAPI;
}

function createFakeExtensionRuntime(): FakeExtensionRuntime {
  const eventHandlers = new Map<string, Set<(value: unknown) => void>>();
  const lifecycleHandlers = new Map<string, (event: unknown, context: ExtensionContext) => unknown>();
  const events = {
    emit: (event: string, value: unknown) => {
      for (const handler of [...(eventHandlers.get(event) ?? [])]) handler(value);
    },
    on: (event: string, handler: (value: unknown) => void) => {
      const handlers = eventHandlers.get(event) ?? new Set();
      handlers.add(handler);
      eventHandlers.set(event, handlers);
      return () => {
        handlers.delete(handler);
        if (handlers.size === 0) eventHandlers.delete(event);
      };
    },
  };
  return {
    lifecycleHandlers,
    pi: {
      events,
      on: (event: string, handler: (value: unknown, context: ExtensionContext) => unknown) => {
        lifecycleHandlers.set(event, handler);
      },
    } as unknown as ExtensionAPI,
  };
}

const sessionContext = (sessionId: string): ExtensionContext => ({
  sessionManager: { getSessionId: () => sessionId },
} as unknown as ExtensionContext);

const readyPayload = (sessionId: string) => ({
  capabilities: { fleetStatus: { version: 1 } },
  methods: ["ping", "status"],
  session: { sessionId },
  version: 1,
});

describe("pi-subagents Fleet bridge", () => {
  it("distinguishes an inactive extension from an active empty Fleet", async () => {
    const bridge = new PiSubagentsFleetBridge();
    const runtime = createFakeExtensionRuntime();
    await createPiSubagentsFleetBridgeExtension(bridge)(runtime.pi);
    const context = sessionContext("session-a");
    await runtime.lifecycleHandlers.get("session_start")?.({}, context);

    assert.deepEqual(await bridge.status("session-a"), {
      entries: [],
      omitted: 0,
      providers: [{
        id: "pi-subagents",
        issue: "pi-subagents is not active in this session",
        label: "pi-subagents",
        source: "npm:pi-subagents",
        state: "unavailable",
      }],
      totalActive: 0,
    });

    runtime.pi.events.emit(PI_SUBAGENTS_RPC_READY_EVENT, readyPayload("session-a"));
    runtime.pi.events.on(PI_SUBAGENTS_RPC_REQUEST_EVENT, (value: unknown) => {
      const request = value as { requestId: string };
      runtime.pi.events.emit(`${PI_SUBAGENTS_RPC_REPLY_PREFIX}${request.requestId}`, {
        data: {
          fleet: { entries: [], omitted: 0, totalActive: 0, version: 1 },
          text: "No active delegated work",
        },
        requestId: request.requestId,
        success: true,
        version: 1,
      });
    });

    assert.deepEqual(await bridge.status("session-a"), {
      entries: [],
      omitted: 0,
      providers: [{
        bridgeVersion: 1,
        id: "pi-subagents",
        label: "pi-subagents",
        source: "npm:pi-subagents",
        state: "active",
      }],
      totalActive: 0,
    });
  });

  it("projects only the public fleetStatus v1 fields", async () => {
    const bridge = new PiSubagentsFleetBridge();
    const runtime = createFakeExtensionRuntime();
    await createPiSubagentsFleetBridgeExtension(bridge)(runtime.pi);
    const context = sessionContext("session-a");
    await runtime.lifecycleHandlers.get("session_start")?.({}, context);
    runtime.pi.events.emit(PI_SUBAGENTS_RPC_READY_EVENT, readyPayload("session-a"));
    runtime.pi.events.on(PI_SUBAGENTS_RPC_REQUEST_EVENT, (value: unknown) => {
      const request = value as { requestId: string };
      runtime.pi.events.emit(`${PI_SUBAGENTS_RPC_REPLY_PREFIX}${request.requestId}`, {
        data: {
          details: { asyncDir: "must-not-cross", runId: "must-not-cross" },
          fleet: {
            entries: [{
              agent: "reviewer",
              effort: "high",
              goal: "Review the authentication changes",
              key: "fleet-1",
              model: "anthropic/claude",
              role: "security",
              runId: "must-not-cross",
              startedAt: 1_700_000_000_000,
              tokens: { input: 120, output: 30, total: 150 },
            }],
            omitted: 2,
            totalActive: 3,
            version: 1,
          },
          text: "private textual status",
        },
        requestId: request.requestId,
        success: true,
        version: 1,
      });
    });

    assert.deepEqual(await bridge.status("session-a"), {
      entries: [{
        agent: "reviewer",
        effort: "high",
        goal: "Review the authentication changes",
        key: "fleet-1",
        model: "anthropic/claude",
        providerId: "pi-subagents",
        role: "security",
        startedAt: 1_700_000_000_000,
        tokens: { input: 120, output: 30, total: 150 },
      }],
      omitted: 2,
      providers: [{
        bridgeVersion: 1,
        id: "pi-subagents",
        label: "pi-subagents",
        source: "npm:pi-subagents",
        state: "active",
      }],
      totalActive: 3,
    });
  });

  it("reports incompatible and failed providers without inventing task state", async () => {
    const bridge = new PiSubagentsFleetBridge();
    const runtime = createFakeExtensionRuntime();
    await createPiSubagentsFleetBridgeExtension(bridge)(runtime.pi);
    const context = sessionContext("session-a");
    await runtime.lifecycleHandlers.get("session_start")?.({}, context);
    runtime.pi.events.emit(PI_SUBAGENTS_RPC_READY_EVENT, {
      ...readyPayload("session-a"),
      capabilities: {},
    });

    const incompatible = await bridge.status("session-a");
    assert.equal(incompatible.providers[0]?.state, "incompatible");
    assert.match(incompatible.providers[0]?.issue ?? "", /fleetStatus v1/);

    runtime.pi.events.emit(PI_SUBAGENTS_RPC_READY_EVENT, readyPayload("session-a"));
    runtime.pi.events.on(PI_SUBAGENTS_RPC_REQUEST_EVENT, (value: unknown) => {
      const request = value as { requestId: string };
      runtime.pi.events.emit(`${PI_SUBAGENTS_RPC_REPLY_PREFIX}${request.requestId}`, {
        error: { code: "execution_failed", message: "status storage is unreadable" },
        requestId: request.requestId,
        success: false,
        version: 1,
      });
    });

    const degraded = await bridge.status("session-a");
    assert.equal(degraded.providers[0]?.state, "degraded");
    assert.match(degraded.providers[0]?.issue ?? "", /status storage is unreadable/);
    assert.deepEqual(degraded.entries, []);
  });
});
