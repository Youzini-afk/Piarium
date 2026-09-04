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
          return { blocks: [{ label: "progress", content: "old", updatedBy: "agent" }] };
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
      enabled: true,
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
      ops: [{ op: "replace", block: "progress", content: "current" }],
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

  it("registers no hooks while shadow mode is disabled", () => {
    let registrations = 0;
    createMemoryAgentExtension({
      bridge: {} as never,
      enabled: false,
      callModel: async () => null,
    })({
      on: () => { registrations += 1; },
    } as never);
    assert.equal(registrations, 0);
  });
});
