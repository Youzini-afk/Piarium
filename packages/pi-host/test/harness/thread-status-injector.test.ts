import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createThreadStatusInjector } from "../../src/harness/thread-status-injector.js";
import { attachContextRequestBoundary } from "../../src/harness/context-request-boundary.js";
import type { HostServicesBridge } from "../../src/harness/host-services-bridge.js";
import type { ContextModelRequest } from "../../src/harness/context-request-boundary.js";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { StreamFn } from "@earendil-works/pi-agent-core";

const request = (): ContextModelRequest => ({
  model: { provider: "p", id: "m" } as ContextModelRequest["model"],
  context: { messages: [] },
  options: {},
  inputTokens: 10,
  reserveTokens: 5,
  needsSpace: false,
});

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const bridge = (statusResult: unknown, calls: Array<{ method: string; params: unknown }> = []): HostServicesBridge => ({
  request: async (method: string, params: unknown) => {
    calls.push({ method, params });
    if (method === "zone2.status") return statusResult;
    if (method === "zone2.statusDelivered") return { committed: true };
    throw new Error(`unexpected method ${method}`);
  },
}) as unknown as HostServicesBridge;

describe("thread status injector", () => {
  it("appends the status trailer and confirms only the returned ref", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const b = bridge({ content: "thread · task · state · progress\nt-1 · alpha · working · …", observationRef: "ref-1" }, calls);
    const inject = createThreadStatusInjector(b);
    const outcome = await inject(request());
    assert.equal(outcome?.request?.context.messages.length, 1);
    const trailer = outcome!.request!.context.messages[0]!;
    assert.ok(JSON.stringify(trailer).includes("t-1 · alpha · working"));
    outcome?.confirm?.();
    await flush();
    assert.deepEqual(calls.filter((c) => c.method === "zone2.statusDelivered"), [
      { method: "zone2.statusDelivered", params: { observationRef: "ref-1" } },
    ]);
  });

  it("leaves the request untouched when nothing changed", async () => {
    const b = bridge({ content: null });
    const inject = createThreadStatusInjector(b);
    assert.equal(await inject(request()), undefined);
  });

  it("never blocks the request when the status service is unavailable", async () => {
    const b = {
      request: async () => { throw new Error("unavailable"); },
    } as unknown as HostServicesBridge;
    const inject = createThreadStatusInjector(b);
    assert.equal(await inject(request()), undefined);
  });
});

// The request boundary owns the confirm signal: it fires only after the
// provider request was actually dispatched, so a failed send cannot claim
// the status delta was delivered.
describe("context request boundary inject seam", () => {
  const MODEL = { provider: "faux", id: "faux-1", api: "faux", contextWindow: 100_000, maxTokens: 400 };

  const session = (stream: StreamFn): AgentSession => {
    const agent = {
      streamFunction: stream,
      transformContext: undefined,
      convertToLlm: async (messages: unknown) => messages,
      state: { systemPrompt: "sys", tools: [], thinkingLevel: "off", messages: [] },
      transport: undefined,
      thinkingBudgets: undefined,
      signal: undefined,
      prepareNextTurnWithContext: undefined,
    };
    return {
      agent,
      model: MODEL,
      sessionId: "s-1",
      sessionManager: {
        buildSessionContext: () => ({ messages: [] }),
        getBranch: () => [],
        getLeafId: () => null,
      },
    } as unknown as AgentSession;
  };

  const dispatchedResult = () => ({
    result: async () => ({
      role: "assistant",
      stopReason: "stop",
      content: [],
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    }),
  });

  it("confirms the injection after the provider request is dispatched", async () => {
    const calls: string[] = [];
    const stream: StreamFn = async () => {
      calls.push("dispatch");
      return dispatchedResult() as never;
    };
    const bound = session(stream);
    const boundary = attachContextRequestBoundary(bound, {
      getCompactionSettings: () => ({ enabled: true, reserveTokens: 100, keepRecentTokens: 50 }),
      observe: () => undefined,
      compact: async () => { throw new Error("unexpected"); },
      inject: async (req) => ({
        request: { ...req, context: { ...req.context, messages: [...req.context.messages, { role: "user", content: "status", timestamp: Date.now() } as never] } },
        confirm: () => { calls.push("confirm"); },
      }),
    });
    await bound.agent.streamFunction(MODEL as never, { messages: [] } as never, {});
    boundary.dispose();
    assert.deepEqual(calls, ["dispatch", "confirm"]);
  });

  it("does not confirm when the provider request fails", async () => {
    const calls: string[] = [];
    const stream: StreamFn = async () => {
      calls.push("dispatch");
      throw new Error("provider down");
    };
    const bound = session(stream);
    const boundary = attachContextRequestBoundary(bound, {
      getCompactionSettings: () => ({ enabled: true, reserveTokens: 100, keepRecentTokens: 50 }),
      observe: () => undefined,
      compact: async () => { throw new Error("unexpected"); },
      inject: async () => ({ confirm: () => { calls.push("confirm"); } }),
    });
    await assert.rejects(async () => {
      await bound.agent.streamFunction(MODEL as never, { messages: [] } as never, {});
    }, /provider down/);
    boundary.dispose();
    assert.deepEqual(calls, ["dispatch"]);
  });
});
