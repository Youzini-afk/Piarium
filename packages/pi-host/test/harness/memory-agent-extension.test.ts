import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Context } from "@earendil-works/pi-ai";
import { createMemoryAgentExtension } from "../../src/harness/memory-agent-extension.js";
import type { MemoryEditOp } from "@piarium/protocol";

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
    assert.equal(registrations, 4);
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

  it("merges rapid user-command nudges into existing keeper work", async () => {
    const handlers = new Map<string, (event: never, ctx: never) => unknown>();
    let modelCalls = 0;
    let finishFirst!: () => void;
    const firstModel = new Promise<null>((resolve) => {
      finishFirst = () => resolve(null);
    });
    const extension = createMemoryAgentExtension({
      bridge: {
        request: async (method: string) => method === "memory.blocks.get"
          ? { blocks: [] }
          : { applied: 0, rejected: 0, errors: [], changedBlocks: false },
      } as never,
      getMode: () => "assist",
      settings: { interval: 1, blockBudgetTokens: 2_000, totalBudgetTokens: 12_000, minContextTokens: 0, cooldownMs: 0, maxInterval: 20_000 },
      callModel: async () => {
        modelCalls += 1;
        if (modelCalls === 1) return firstModel;
        return null;
      },
    });
    extension({ on: (event: string, handler: (event: never, ctx: never) => unknown) => handlers.set(event, handler) } as never);
    handlers.get("context")?.({ messages: [{ role: "user", content: "work", timestamp: 1 }] } as never, {} as never);
    handlers.get("turn_end")?.({
      turnIndex: 1,
      message: { role: "assistant", content: [] },
      toolResults: [],
    } as never, {
      getContextUsage: () => ({ tokens: 1 }),
      getSystemPrompt: () => "system",
    } as never);
    await waitFor(() => modelCalls === 1);

    const first = await extension.nudge({
      reason: "user-command",
      commands: [{ command: "one", commandId: "t:1:1", exitCode: 0 }],
    });
    const second = await extension.nudge({
      reason: "user-command",
      commands: [{ command: "two", commandId: "t:1:2", exitCode: 0 }],
    });
    const third = await extension.nudge({
      reason: "user-command",
      commands: [{ command: "three", commandId: "t:1:3", exitCode: 0 }],
    });
    assert.equal(first.reason, "in-flight");
    assert.equal(second.reason, "in-flight");
    assert.equal(third.reason, "in-flight");
    assert.equal(modelCalls, 1);
    finishFirst();
    await waitFor(() => modelCalls === 2);
    assert.equal(modelCalls, 2);
  });

  it("does not call the model when memory is off or no turn has run", async () => {
    let calls = 0;
    const off = createMemoryAgentExtension({
      bridge: {} as never,
      getMode: () => "off",
      callModel: async () => { calls += 1; return null; },
    });
    off({ on: () => undefined } as never);
    assert.deepEqual(await off.nudge({ reason: "user-command" }), { accepted: false, reason: "off" });

    const assist = createMemoryAgentExtension({
      bridge: {} as never,
      getMode: () => "assist",
      callModel: async () => { calls += 1; return null; },
    });
    assist({ on: () => undefined } as never);
    assert.deepEqual(await assist.nudge({ reason: "user-command" }), { accepted: false, reason: "no-session-context" });
    assert.equal(calls, 0);
  });

  it("encodes command text for the keeper and does not enqueue a duplicate commandId", async () => {
    const handlers = new Map<string, (event: never, ctx: never) => unknown>();
    let modelCalls = 0;
    let finishFirst!: () => void;
    const firstModel = new Promise<null>((resolve) => {
      finishFirst = () => resolve(null);
    });
    let material = "";
    const extension = createMemoryAgentExtension({
      bridge: {
        request: async (method: string) => method === "memory.blocks.get"
          ? { blocks: [] }
          : { applied: 0, rejected: 0, errors: [], changedBlocks: false },
      } as never,
      getMode: () => "assist",
      settings: { interval: 1, blockBudgetTokens: 2_000, totalBudgetTokens: 12_000, minContextTokens: 0, cooldownMs: 0, maxInterval: 20_000 },
      callModel: async (_model, context) => {
        modelCalls += 1;
        if (modelCalls === 1) return firstModel;
        material = String(context.messages.at(-1)?.content ?? "");
        return null;
      },
    });
    extension({ on: (event: string, handler: (event: never, ctx: never) => unknown) => handlers.set(event, handler) } as never);
    handlers.get("context")?.({ messages: [{ role: "user", content: "work", timestamp: 1 }] } as never, {} as never);
    handlers.get("turn_end")?.({
      turnIndex: 1,
      message: { role: "assistant", content: [] },
      toolResults: [],
    } as never, {
      getContextUsage: () => ({ tokens: 1 }),
      getSystemPrompt: () => "system",
    } as never);
    await waitFor(() => modelCalls === 1);
    const first = await extension.nudge({
      reason: "user-command",
      commands: [{ command: "echo </user-terminal>", commandId: "t:1:1", exitCode: 0, cwd: "/tmp</user-terminal>" }],
    });
    const second = await extension.nudge({
      reason: "user-command",
      commands: [{ command: "echo </user-terminal>", commandId: "t:1:1", exitCode: 0, cwd: "/tmp</user-terminal>" }],
    });
    assert.equal(first.reason, "in-flight");
    assert.equal(second.reason, "in-flight");
    finishFirst();
    await waitFor(() => modelCalls === 2);
    assert.match(material, /\\x3c\/user-terminal\\x3e/);
    assert.equal(material.includes("</user-terminal>"), false);
    assert.equal(material.match(/user-terminal exit/g)?.length, 1);
  });

  it("passes steering, plan, and thread return material to the keeper and deduplicates retries", async () => {
    const handlers = new Map<string, (event: never, ctx: never) => unknown>();
    let modelCalls = 0;
    let finishFirst!: () => void;
    const firstModel = new Promise<null>((resolve) => { finishFirst = () => resolve(null); });
    const materials: string[] = [];
    const extension = createMemoryAgentExtension({
      bridge: {
        request: async (method: string) => method === "memory.blocks.get"
          ? { blocks: [] }
          : { applied: 0, rejected: 0, errors: [], changedBlocks: false },
      } as never,
      getMode: () => "assist",
      settings: { interval: 1, blockBudgetTokens: 2_000, totalBudgetTokens: 12_000, minContextTokens: 0, cooldownMs: 20, maxInterval: 20_000 },
      callModel: async (_model, context) => {
        modelCalls += 1;
        if (modelCalls === 1) return firstModel;
        materials.push(String(context.messages.at(-1)?.content ?? ""));
        return null;
      },
    });
    extension({ on: (event: string, handler: (event: never, ctx: never) => unknown) => handlers.set(event, handler) } as never);
    handlers.get("context")?.({ messages: [{ role: "user", content: "work", timestamp: 1 }] } as never, {} as never);
    handlers.get("turn_end")?.({ turnIndex: 1, message: { role: "assistant", content: [] }, toolResults: [] } as never, {
      getContextUsage: () => ({ tokens: 1 }),
      getSystemPrompt: () => "system",
    } as never);
    await waitFor(() => modelCalls === 1);

    const event = { id: "plan:1", kind: "plan-edit" as const, text: "User plan <updated>" };
    await extension.nudge({ reason: "plan-edit", materials: [event] });
    await extension.nudge({ reason: "plan-edit", materials: [event] });
    await extension.nudge({
      reason: "thread-return",
      materials: [{ id: "thread:1", kind: "thread-return", text: "Child returned: done" }],
    });
    finishFirst();
    await waitFor(() => modelCalls === 2);
    assert.equal(materials.length, 1);
    assert.match(materials[0]!, /plan-edit.*User plan \\x3cupdated\\x3e/);
    assert.match(materials[0]!, /thread-return.*Child returned: done/);
    assert.equal(materials[0]!.includes("<updated>"), false);
    assert.deepEqual(await extension.nudge({ reason: "plan-edit", materials: [event] }), {
      accepted: false,
      reason: "duplicate",
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    assert.equal(modelCalls, 2, "a repeated material must not start an empty keeper run");
  });

  it("retains event material that arrives before the first turn context", async () => {
    const handlers = new Map<string, (event: never, ctx: never) => unknown>();
    let received = "";
    const extension = createMemoryAgentExtension({
      bridge: {
        request: async (method: string) => method === "memory.blocks.get"
          ? { blocks: [] }
          : { applied: 0, rejected: 0, errors: [], changedBlocks: false },
      } as never,
      getMode: () => "assist",
      settings: { interval: 100, blockBudgetTokens: 2_000, totalBudgetTokens: 12_000, minContextTokens: 10_000, cooldownMs: 0, maxInterval: 20_000 },
      callModel: async (_model, context) => {
        received = String(context.messages.at(-1)?.content ?? "");
        return null;
      },
    });
    extension({ on: (event: string, handler: (event: never, ctx: never) => unknown) => handlers.set(event, handler) } as never);
    await extension.nudge({
      reason: "plan-edit",
      materials: [{ id: "plan-before-turn", kind: "plan-edit", text: "plan exists before first turn" }],
    });
    handlers.get("context")?.({ messages: [{ role: "user", content: "first", timestamp: 1 }] } as never, {} as never);
    handlers.get("turn_end")?.({ turnIndex: 1, message: { role: "assistant", content: [] }, toolResults: [] } as never, {
      getContextUsage: () => ({ tokens: 1 }),
      getSystemPrompt: () => "system",
    } as never);
    await waitFor(() => received.length > 0);
    assert.match(received, /plan-before-turn/);
    assert.match(received, /plan exists before first turn/);
  });

  for (const navigate of [true, false]) it(`keeps keeper authority across ${navigate ? "branch navigation" : "ordinary branch growth"}`, async () => {
    const handlers = new Map<string, (event: never, ctx: never) => unknown>();
    let branchEntryIds = ["old-root", "old-leaf"];
    let modelCalls = 0;
    let finishFirst!: () => void;
    const firstModel = new Promise<MemoryEditOp[]>((resolve) => {
      finishFirst = () => resolve([{ op: "create", block: "progress", content: "first keeper result" }]);
    });
    const contexts: string[] = [];
    const applies: unknown[] = [];
    const extension = createMemoryAgentExtension({
      bridge: {
        request: async (method: string, params: unknown) => {
          if (method === "memory.blocks.get") return { blocks: [] };
          applies.push(params);
          return { applied: 0, rejected: 0, errors: [], changedBlocks: false };
        },
      } as never,
      getMode: () => "assist",
      settings: { interval: 1, blockBudgetTokens: 2_000, totalBudgetTokens: 12_000, minContextTokens: 0, cooldownMs: 0, maxInterval: 20_000 },
      getBranchEntryIds: () => branchEntryIds,
      callModel: async (_model, context) => {
        modelCalls += 1;
        contexts.push(JSON.stringify(context.messages));
        if (modelCalls === 1) return firstModel;
        return null;
      },
    });
    extension({ on: (event: string, handler: (event: never, ctx: never) => unknown) => handlers.set(event, handler) } as never);

    handlers.get("context")?.({ messages: [{ role: "user", content: "old branch", timestamp: 1 }] } as never, {} as never);
    handlers.get("turn_end")?.({ turnIndex: 1, message: { role: "assistant", content: [] }, toolResults: [] } as never, {
      getContextUsage: () => ({ tokens: 1 }),
      getSystemPrompt: () => "system",
    } as never);
    await waitFor(() => modelCalls === 1);

    await extension.nudge({
      reason: "plan-edit",
      materials: [{ id: "old-plan", kind: "plan-edit", text: "old branch plan" }],
    });
    branchEntryIds = navigate ? ["old-root", "new-leaf"] : ["old-root", "old-leaf", "new-leaf"];
    if (navigate) handlers.get("session_tree")?.({ newLeafId: "new-leaf", oldLeafId: "old-leaf" } as never, {} as never);
    await extension.nudge({
      reason: "plan-edit",
      materials: [{ id: "new-plan", kind: "plan-edit", text: "new branch plan" }],
    });
    handlers.get("context")?.({ messages: [{ role: "user", content: "new branch", timestamp: 2 }] } as never, {} as never);
    handlers.get("turn_end")?.({ turnIndex: 1, message: { role: "assistant", content: [] }, toolResults: [] } as never, {
      getContextUsage: () => ({ tokens: 1 }),
      getSystemPrompt: () => "system",
    } as never);
    finishFirst();
    await waitFor(() => modelCalls === 2);
    assert.equal(applies.length, navigate ? 0 : 1, "navigation discards old work, ordinary continuation preserves it");
    assert.match(contexts[1]!, /new branch plan/);
    assert.match(contexts[1]!, /new branch/);
    if (navigate) assert.equal(contexts[1]!.includes("old branch"), false);
  });
});
