import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { defaultRules } from "@piarium/protocol";
import { createPermissionGateExtension } from "../../src/harness/permission-gate-extension.js";

const SERVICES_KEY = Symbol.for("@gotgenes/pi-permission-system:session-services");
const previousServices = (globalThis as Record<symbol, unknown>)[SERVICES_KEY];

afterEach(() => {
  if (previousServices === undefined) delete (globalThis as Record<symbol, unknown>)[SERVICES_KEY];
  else (globalThis as Record<symbol, unknown>)[SERVICES_KEY] = previousServices;
});

const harness = (options: Parameters<typeof createPermissionGateExtension>[0]) => {
  let ready: ((value: unknown) => void) | undefined;
  let toolCall: ((event: { toolName: string; input: unknown }, ctx: unknown) => Promise<unknown>) | undefined;
  const extension = createPermissionGateExtension(options);
  extension({
    events: {
      on: (event: string, handler: (value: unknown) => void) => {
        if (event === "permissions:ready") ready = handler;
        return () => {};
      },
    },
    on: (event: string, handler: typeof toolCall) => {
      if (event === "tool_call") toolCall = handler;
    },
  } as never);
  if (!toolCall) throw new Error("tool_call handler was not registered");
  return { ready, toolCall };
};

const ui = (choice: string | undefined = "Allow once") => {
  const state = {
    selectCalls: 0,
    context: { ui: { select: async () => choice } },
  };
  state.context.ui.select = async () => {
    state.selectCalls += 1;
    return choice;
  };
  return state;
};

describe("native permission gate integration", () => {
  it("yields to a published permission-system service instead of prompting twice", async () => {
    const sessionId = "coexist-session";
    (globalThis as Record<symbol, unknown>)[SERVICES_KEY] = new Map([[sessionId, {}]]);
    let detected = 0;
    const gate = harness({
      policy: { mode: "normal", rules: defaultRules("normal") },
      sessionId,
      onExternalGateDetected: () => { detected += 1; },
    });
    gate.ready?.({ sessionId });
    const result = ui();
    const decision = await gate.toolCall({ toolName: "bash", input: { command: "echo ok" } }, result.context as never);
    assert.equal(decision, undefined);
    assert.equal(result.selectCalls, 0);
    assert.equal(detected, 1);
  });

  it("uses Smart mode for ordinary asks but never for a high-risk call", async () => {
    let judged = 0;
    const gate = harness({
      policy: { mode: "smart", rules: defaultRules("smart") },
      sessionId: "smart-session",
      smartJudge: async () => { judged += 1; return "allow"; },
    });
    const result = ui();
    assert.equal(await gate.toolCall(
      { toolName: "edit", input: { path: "src/a.ts" } },
      result.context as never,
    ), undefined);
    assert.equal(judged, 1);
    assert.equal(result.selectCalls, 0);

    await gate.toolCall(
      { toolName: "bash", input: { command: "rm -rf build" } },
      result.context as never,
    );
    assert.equal(judged, 1);
    assert.equal(result.selectCalls, 1);
  });

  it("does not yield to another session and observes service removal without a reload", async () => {
    const services = new Map<string, unknown>([["other-session", {}]]);
    (globalThis as Record<symbol, unknown>)[SERVICES_KEY] = services;
    const gate = harness({
      policy: { mode: "normal", rules: defaultRules("normal") },
      sessionId: "owned-session",
    });
    gate.ready?.({ sessionId: "other-session" });
    const result = ui();
    await gate.toolCall({ toolName: "bash", input: { command: "echo first" } }, result.context as never);
    assert.equal(result.selectCalls, 1);

    services.set("owned-session", {});
    await gate.toolCall({ toolName: "bash", input: { command: "echo second" } }, result.context as never);
    assert.equal(result.selectCalls, 1);

    services.delete("owned-session");
    await gate.toolCall({ toolName: "bash", input: { command: "echo third" } }, result.context as never);
    assert.equal(result.selectCalls, 2);
  });

  it("recognizes the session-local ready signal from pre-locator plugin releases", async () => {
    delete (globalThis as Record<symbol, unknown>)[SERVICES_KEY];
    const gate = harness({
      policy: { mode: "normal", rules: defaultRules("normal") },
      sessionId: "legacy-session",
    });
    gate.ready?.({ sessionId: "legacy-session" });
    const result = ui();
    await gate.toolCall({ toolName: "bash", input: { command: "echo legacy" } }, result.context as never);
    assert.equal(result.selectCalls, 0);
  });
});
