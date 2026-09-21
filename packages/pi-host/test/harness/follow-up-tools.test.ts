import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HostServicesBridge } from "../../src/harness/host-services-bridge.js";
import { createFollowUpTool } from "../../src/harness/follow-up-tools.js";
import { selectHarnessTools } from "../../src/harness/select-tools.js";
import { DEFAULT_HARNESS_SETTINGS, type HarnessRequestData } from "@varin/protocol";

const SESSION = "session-1";
const isError = (result: unknown) => (result as { isError?: boolean }).isError;

function scriptedBridge(handlers: Record<string, (params: never) => unknown>) {
  const requests: HarnessRequestData[] = [];
  const bridge = new HostServicesBridge({
    emit: (_event, data) => {
      const request = data as HarnessRequestData;
      requests.push(request);
      queueMicrotask(() => {
        const handler = handlers[request.method];
        if (!handler) {
          bridge.respond(SESSION, request.requestId, {
            ok: false,
            error: { code: "unavailable", message: `no handler for ${request.method}` },
          });
          return;
        }
        try {
          bridge.respond(SESSION, request.requestId, { ok: true, result: handler(request.params as never) });
        } catch (error) {
          bridge.respond(SESSION, request.requestId, {
            ok: false,
            error: { code: "failed", message: error instanceof Error ? error.message : String(error) },
          });
        }
      });
    },
    sessionId: SESSION,
    defaultTimeoutMs: 5_000,
  });
  return { bridge, requests };
}

const view = (over: Record<string, unknown> = {}) => ({
  createdAt: 1,
  id: "fu-1",
  instruction: "handle the result",
  pausedGoal: false,
  revision: "1",
  sessionId: SESSION,
  source: { at: 1_700_000_000_000, kind: "time" },
  status: "waiting",
  updatedAt: 1,
  waitingSummary: "Waiting for a time",
  workspaceId: "ws",
  ...over,
});

const execute = (tool: ReturnType<typeof createFollowUpTool>, params: Record<string, unknown>) =>
  tool.execute("call-1", params as never, undefined, undefined, undefined as never);

describe("follow_up tool", () => {
  it("registers a durable wait and reports the armed source", async () => {
    const { bridge, requests } = scriptedBridge({
      "followup.register": (params: { instruction: string; source: { kind: string } }) => ({
        firedImmediately: false,
        followUp: view({ source: params.source }),
      }),
    });
    const tool = createFollowUpTool(bridge);
    const result = await execute(tool, {
      action: "register",
      instruction: "when done, summarise",
      source: { attemptId: "attempt-9", fallbackAt: 123, kind: "experiment" },
    });
    assert.equal(isError(result), undefined);
    assert.equal(requests.length, 1);
    assert.equal(requests[0]!.method, "followup.register");
    assert.deepEqual(requests[0]!.params, {
      instruction: "when done, summarise",
      source: { attemptId: "attempt-9", fallbackAt: 123, kind: "experiment" },
    });
    assert.match(JSON.stringify(result.content), /fu-1/);
    assert.match(JSON.stringify(result.content), /attempt-9/);
  });

  it("rejects register without instruction or source before any host call", async () => {
    const { bridge, requests } = scriptedBridge({});
    const tool = createFollowUpTool(bridge);
    const missing = await execute(tool, { action: "register", instruction: "x" });
    assert.equal(isError(missing), true);
    assert.match(JSON.stringify(missing.content), /source/);
    const missingInstruction = await execute(tool, { action: "register", source: { kind: "manual" } });
    assert.equal(isError(missingInstruction), true);
    assert.equal(requests.length, 0);
  });

  it("maps check/fire/cancel to their host methods with the id", async () => {
    const seen: string[] = [];
    const { bridge, requests } = scriptedBridge({
      "followup.cancel": () => ({ followUp: view({ status: "cancelled" }), occurrences: [] }),
      "followup.check": () => ({ fired: false, followUp: view(), observed: { due: false } }),
      "followup.fire": (params: { id: string; reason?: string }) => {
        seen.push(params.reason ?? "");
        return { followUp: view({ status: "delivered" }), occurrences: [] };
      },
    });
    const tool = createFollowUpTool(bridge);
    for (const action of ["check", "fire", "cancel"] as const) {
      const result = await execute(tool, { action, id: "fu-1", ...(action === "fire" ? { reason: "user asked" } : {}) });
      assert.equal(isError(result), undefined);
    }
    assert.deepEqual(requests.map((request) => request.method), ["followup.check", "followup.fire", "followup.cancel"]);
    assert.deepEqual(seen, ["user asked"]);
  });

  it("requires id for point actions", async () => {
    const { bridge, requests } = scriptedBridge({});
    const tool = createFollowUpTool(bridge);
    for (const action of ["get", "update", "cancel", "check", "fire"] as const) {
      const result = await execute(tool, { action, ...(action === "update" ? { instruction: "x" } : {}) });
      assert.equal(isError(result), true);
    }
    assert.equal(requests.length, 0);
  });

  it("surfaces host errors without leaking internals", async () => {
    const { bridge } = scriptedBridge({
      "followup.list": () => {
        throw new Error("record store unavailable");
      },
    });
    const tool = createFollowUpTool(bridge);
    const result = await execute(tool, { action: "list" });
    assert.equal(isError(result), true);
    assert.match(JSON.stringify(result.content), /failed/);
  });
});

describe("follow_up tool selection", () => {
  const deps = {
    bridge: undefined as never,
    cwd: "C:/workspace",
    isOpenAIFamily: true,
    sessionId: SESSION,
    workspaceMutationJournal: undefined,
  };

  it("is gated on the host follow-up capability", () => {
    const without = selectHarnessTools(DEFAULT_HARNESS_SETTINGS, { ...deps, followUpAvailable: false });
    const withIt = selectHarnessTools(DEFAULT_HARNESS_SETTINGS, { ...deps, followUpAvailable: true });
    assert.equal(without.some((tool) => tool.name === "follow_up"), false);
    assert.equal(withIt.some((tool) => tool.name === "follow_up"), true);
  });

  it("respects tools.follow_up = false", () => {
    const tools = selectHarnessTools(
      { ...DEFAULT_HARNESS_SETTINGS, tools: { follow_up: false } },
      { ...deps, followUpAvailable: true },
    );
    assert.equal(tools.some((tool) => tool.name === "follow_up"), false);
  });
});
