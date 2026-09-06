import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Context } from "@earendil-works/pi-ai";
import { createMemoryAgentExtension } from "../../src/harness/memory-agent-extension.js";

const waitFor = async (predicate: () => boolean): Promise<void> => {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for memory shadow update");
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
};

describe("memory agent extension", () => {
  it("runs in the background and applies model-produced ops through the Host", async () => {
    const handlers = new Map<string, (event: never, ctx: never) => unknown>();
    const applyRequests: unknown[] = [];
    let modelContext: Context | null = null;
    const bridge = {
      request: async (method: string, params: unknown) => {
        if (method === "memory.blocks.get") {
          return { blocks: [{ label: "progress", content: "old", updatedBy: "agent", revision: 7 }] };
        }
        if (method === "memory.blocks.apply") {
          applyRequests.push(params);
          return { applied: 1, rejected: 0, errors: [], changedBlocks: true };
        }
        throw new Error(`Unexpected method: ${method}`);
      },
    };
    createMemoryAgentExtension({
      bridge: bridge as never,
      getMode: () => "assist",
      settings: {
        interval: 100,
        blockBudgetTokens: 2_000,
        totalBudgetTokens: 12_000,
        minContextTokens: 0,
        cooldownMs: 0,
        maxInterval: 20_000,
      },
      callModel: async (_model, context) => {
        modelContext = context;
        return [{ op: "replace", block: "progress", content: "current" }];
      },
      getBranchEntryIds: () => ["entry-1", "entry-2"],
      getContextEntryIds: () => ["entry-1"],
    })({
      on: (event: string, handler: (event: never, ctx: never) => unknown) => {
        handlers.set(event, handler);
      },
    } as never);

    handlers.get("context")?.({
      messages: [{ role: "user", content: "work", timestamp: 1 }],
    } as never, {} as never);
    handlers.get("turn_end")?.({
      turnIndex: 2,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
      },
      toolResults: [],
    } as never, {
      getContextUsage: () => ({ tokens: 12_000, contextWindow: 100_000, percent: 12 }),
      getSystemPrompt: () => "stable system",
    } as never);

    await waitFor(() => applyRequests.length === 1);
    const captured = modelContext as unknown as Context;
    assert.equal(captured.systemPrompt, "stable system");
    assert.equal(captured.tools?.[0]?.name, "memory_edit");
    assert.match(JSON.stringify(captured.messages), /\[progress\].*old/);
    assert.deepEqual(applyRequests[0], {
      cursorTurn: 2,
      ops: [{ op: "replace", block: "progress", content: "current", expectedRevision: 7 }],
      branchEntryIds: ["entry-1", "entry-2"],
      coveredEntryIds: ["entry-1"],
    });

    const turnEnd = handlers.get("turn_end")!;
    turnEnd({
      turnIndex: 3,
      message: { role: "assistant", content: [{ type: "text", text: "after compact" }] },
      toolResults: [],
    } as never, {
      getContextUsage: () => ({ tokens: 50, contextWindow: 100_000, percent: 1 }),
      getSystemPrompt: () => "stable system",
    } as never);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    assert.equal(applyRequests.length, 1, "a lower post-compaction estimate must only rebase the counter");
    turnEnd({
      turnIndex: 4,
      message: { role: "assistant", content: [{ type: "text", text: "grown again" }] },
      toolResults: [],
    } as never, {
      getContextUsage: () => ({ tokens: 150, contextWindow: 100_000, percent: 1 }),
      getSystemPrompt: () => "stable system",
    } as never);
    await waitFor(() => applyRequests.length === 2);
  });

  it("stays installed but captures and calls nothing while mode is off", () => {
    let registrations = 0;
    let calls = 0;
    const handlers = new Map<string, (event: never, ctx: never) => unknown>();
    createMemoryAgentExtension({
      bridge: {} as never,
      getMode: () => "off",
      callModel: async () => { calls += 1; return null; },
    })({
      on: (event: string, handler: (event: never, ctx: never) => unknown) => {
        registrations += 1;
        handlers.set(event, handler);
      },
    } as never);
    handlers.get("context")?.({ messages: [{ role: "user", content: "secret" }] } as never, {} as never);
    handlers.get("turn_end")?.({
      turnIndex: 1,
      message: { role: "assistant", content: [] },
      toolResults: [],
    } as never, { getContextUsage: () => ({ tokens: 50_000 }) } as never);
    assert.equal(registrations, 3);
    assert.equal(calls, 0);
  });

  it("does not apply a model result after a live switch to off", async () => {
    const handlers = new Map<string, (event: never, ctx: never) => unknown>();
    const applyRequests: unknown[] = [];
    let mode: "takeover" | "off" = "takeover";
    let finishModel!: (ops: [{ op: "create"; block: string; content: string }]) => void;
    const modelResult = new Promise<[{ op: "create"; block: string; content: string }]>((resolve) => {
      finishModel = resolve;
    });
    createMemoryAgentExtension({
      bridge: {
        request: async (method: string, params: unknown) => {
          if (method === "memory.blocks.get") return { blocks: [] };
          applyRequests.push(params);
          return { applied: 1, rejected: 0, errors: [], changedBlocks: true };
        },
      } as never,
      getMode: () => mode,
      settings: { interval: 1, blockBudgetTokens: 2_000, totalBudgetTokens: 12_000, minContextTokens: 0, cooldownMs: 0, maxInterval: 20_000 },
      callModel: async () => modelResult,
    })({ on: (event: string, handler: (event: never, ctx: never) => unknown) => handlers.set(event, handler) } as never);
    handlers.get("context")?.({ messages: [] } as never, {} as never);
    handlers.get("turn_end")?.({ turnIndex: 1, message: { role: "assistant", content: [] }, toolResults: [] } as never, {
      getContextUsage: () => ({ tokens: 100 }),
      getSystemPrompt: () => "system",
    } as never);
    await new Promise<void>((resolve) => setImmediate(resolve));
    mode = "off";
    finishModel([{ op: "create", block: "progress", content: "late" }]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(applyRequests, []);
  });

  it("projects rejected applies and clears that failure after a healthy no-op run", async () => {
    const handlers = new Map<string, (event: never, ctx: never) => unknown>();
    const failures: string[] = [];
    let successes = 0;
    let modelCalls = 0;
    createMemoryAgentExtension({
      bridge: {
        request: async (method: string) => method === "memory.blocks.get"
          ? { blocks: [] }
          : { applied: 0, rejected: 1, errors: ["conflict"], changedBlocks: false },
      } as never,
      getMode: () => "assist",
      settings: { interval: 1, blockBudgetTokens: 2_000, totalBudgetTokens: 12_000, minContextTokens: 0, cooldownMs: 0, maxInterval: 20_000 },
      callModel: async () => {
        modelCalls += 1;
        return modelCalls === 1 ? [{ op: "create", block: "progress", content: "state" }] : null;
      },
      onFailure: (message) => failures.push(message),
      onSuccess: () => { successes += 1; },
    })({ on: (event: string, handler: (event: never, ctx: never) => unknown) => handlers.set(event, handler) } as never);
    const turnEnd = handlers.get("turn_end")!;
    const context = { getContextUsage: () => ({ tokens: modelCalls === 0 ? 100 : 200 }), getSystemPrompt: () => "system" } as never;
    turnEnd({ turnIndex: 1, message: { role: "assistant", content: [] }, toolResults: [] } as never, context);
    await waitFor(() => failures.length === 1);
    turnEnd({ turnIndex: 2, message: { role: "assistant", content: [] }, toolResults: [] } as never, context);
    await waitFor(() => successes === 1);
    assert.deepEqual(failures, ["conflict"]);
  });
});
