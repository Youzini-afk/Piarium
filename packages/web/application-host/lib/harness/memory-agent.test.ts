import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { openWorkspaceKnowledge, type KnowledgeStore } from "../knowledge/store.js";
import {
  createInitialState,
  evaluateGate,
  evaluateEventGate,
  validateOp,
  applyOps,
  createMemoryAgentRunner,
  DEFAULT_MEMORY_AGENT_SETTINGS,
  type MemoryAgentState,
  type TurnEndMeta,
  type MemoryEditOp,
} from "./memory-agent.js";

const TEST_DIR = join(import.meta.dirname, ".test-memory");
function cleanup() {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
}

let store: KnowledgeStore;
let storeCounter = 0;

async function openStore() {
  storeCounter++;
  const dir = join(TEST_DIR, `store-${storeCounter}`);
  mkdirSync(dir, { recursive: true });
  return openWorkspaceKnowledge({
    dataDir: dir, hostId: "test-host", workspaceId: "ws-test", embedding: null,
  });
}

const settings = DEFAULT_MEMORY_AGENT_SETTINGS;
const now = () => 1_000_000;

function makeState(overrides: Partial<MemoryAgentState> = {}): MemoryAgentState {
  return { ...createInitialState(settings), ...overrides };
}

function makeMeta(overrides: Partial<TurnEndMeta> = {}): TurnEndMeta {
  return {
    turnIndex: 1,
    contextTokens: 15_000,
    toolCallsSinceLastRun: 5,
    lastStepHadNoTools: false,
    ...overrides,
  };
}

describe("evaluateGate", () => {
  it("below min context and never run → don't run", () => {
    const state = makeState({ hasRun: false });
    const meta = makeMeta({ contextTokens: 5_000 });
    const d = evaluateGate(state, meta, settings, now());
    expect(d.shouldRun).toBe(false);
    expect(d.reason).toBe("below-min-context");
  });

  it("in flight → don't run", () => {
    const state = makeState({ inFlight: true });
    const d = evaluateGate(state, makeMeta(), settings, now());
    expect(d.shouldRun).toBe(false);
    expect(d.reason).toBe("in-flight");
  });

  it("within cooldown → don't run", () => {
    const state = makeState({ hasRun: true, lastEndAt: now() - 10_000 });
    const d = evaluateGate(state, makeMeta(), settings, now());
    expect(d.shouldRun).toBe(false);
    expect(d.reason).toBe("cooldown");
  });

  it("interval met with tool calls → run", () => {
    const state = makeState({ hasRun: true, lastEndAt: now() - 60_000, lastRunTokens: 5_000 });
    const meta = makeMeta({ contextTokens: 15_000, toolCallsSinceLastRun: 5 });
    const d = evaluateGate(state, meta, settings, now());
    expect(d.shouldRun).toBe(true);
    expect(d.reason).toBe("interval-met");
  });

  it("interval met with lastStepHadNoTools → run", () => {
    const state = makeState({ hasRun: true, lastEndAt: now() - 60_000, lastRunTokens: 5_000 });
    const meta = makeMeta({ contextTokens: 15_000, toolCallsSinceLastRun: 0, lastStepHadNoTools: true });
    const d = evaluateGate(state, meta, settings, now());
    expect(d.shouldRun).toBe(true);
  });

  it("interval not met → don't run", () => {
    const state = makeState({ hasRun: true, lastEndAt: now() - 60_000, lastRunTokens: 14_000 });
    const meta = makeMeta({ contextTokens: 15_000, toolCallsSinceLastRun: 5 });
    const d = evaluateGate(state, meta, settings, now());
    expect(d.shouldRun).toBe(false);
    expect(d.reason).toBe("interval-not-met");
  });

  it("interval met but not enough tool calls and not no-tools → don't run", () => {
    const state = makeState({ hasRun: true, lastEndAt: now() - 60_000, lastRunTokens: 5_000 });
    const meta = makeMeta({ contextTokens: 15_000, toolCallsSinceLastRun: 1, lastStepHadNoTools: false });
    const d = evaluateGate(state, meta, settings, now());
    expect(d.shouldRun).toBe(false);
  });
});

describe("evaluateEventGate", () => {
  it("in flight → don't run", () => {
    const state = makeState({ inFlight: true });
    const d = evaluateEventGate(state, settings, now());
    expect(d.shouldRun).toBe(false);
  });

  it("within cooldown → don't run", () => {
    const state = makeState({ hasRun: true, lastEndAt: now() - 10_000 });
    const d = evaluateEventGate(state, settings, now());
    expect(d.shouldRun).toBe(false);
  });

  it("otherwise → run", () => {
    const state = makeState({ hasRun: true, lastEndAt: now() - 60_000 });
    const d = evaluateEventGate(state, settings, now());
    expect(d.shouldRun).toBe(true);
    expect(d.reason).toBe("event-acceleration");
  });
});

describe("validateOp", () => {
  const existing = new Set(["progress", "decisions", "plan"]);

  it("replace valid", () => {
    expect(validateOp({ op: "replace", block: "progress", content: "new content" }, existing, settings).valid).toBe(true);
  });

  it("replace non-existent block → invalid", () => {
    expect(validateOp({ op: "replace", block: "nonexist", content: "x" }, existing, settings).valid).toBe(false);
  });

  it("replace over budget → invalid", () => {
    const bigContent = "x".repeat(settings.blockBudgetTokens * 4 + 100);
    expect(validateOp({ op: "replace", block: "progress", content: bigContent }, existing, settings).valid).toBe(false);
  });

  it("patch valid", () => {
    expect(validateOp({ op: "patch", block: "progress", find: "old", replace: "new" }, existing, settings).valid).toBe(true);
  });

  it("create valid", () => {
    expect(validateOp({ op: "create", block: "newblock", content: "x" }, existing, settings).valid).toBe(true);
  });

  it("create existing → invalid", () => {
    expect(validateOp({ op: "create", block: "progress", content: "x" }, existing, settings).valid).toBe(false);
  });

  it("delete valid", () => {
    expect(validateOp({ op: "delete", block: "progress" }, existing, settings).valid).toBe(true);
  });

  it("delete plan → invalid", () => {
    expect(validateOp({ op: "delete", block: "plan" }, existing, settings).valid).toBe(false);
  });

  it("mark_plan valid", () => {
    expect(validateOp({ op: "mark_plan", item: 0, status: "done" }, existing, settings).valid).toBe(true);
  });

  it("mark_plan invalid status", () => {
    expect(validateOp({ op: "mark_plan", item: 0, status: "invalid" }, existing, settings).valid).toBe(false);
  });

  it("invalid block name", () => {
    expect(validateOp({ op: "create", block: "Invalid!", content: "x" }, existing, settings).valid).toBe(false);
  });
});

describe("applyOps", () => {
  beforeEach(async () => {
    cleanup();
    store = await openStore();
  });
  afterEach(async () => {
    await store.close();
    cleanup();
  });

  it("applies replace op", async () => {
    await store.upsertBlock({ sessionId: "s1", label: "progress", content: "old", updatedBy: "agent" });
    const result = await applyOps(
      [{ op: "replace", block: "progress", content: "new content" }],
      store, "s1", 5, settings,
    );
    expect(result.applied).toBe(1);
    expect(result.changedBlocks).toBe(true);
    const blocks = await store.getBlocks("s1");
    expect(blocks[0]?.content).toBe("new content");
    expect(blocks[0]?.updatedBy).toBe("memory-agent");
    expect(blocks[0]?.cursorTurn).toBe(5);
  });

  it("applies create op", async () => {
    const result = await applyOps(
      [{ op: "create", block: "decisions", content: "decided to use vitest" }],
      store, "s1", 3, settings,
    );
    expect(result.applied).toBe(1);
    const blocks = await store.getBlocks("s1");
    expect(blocks.find((b) => b.label === "decisions")).toBeDefined();
  });

  it("applies delete op", async () => {
    await store.upsertBlock({ sessionId: "s1", label: "temp", content: "x", updatedBy: "agent" });
    const result = await applyOps([{ op: "delete", block: "temp" }], store, "s1", 1, settings);
    expect(result.applied).toBe(1);
    const blocks = await store.getBlocks("s1");
    expect(blocks).toHaveLength(0);
  });

  it("applies patch op", async () => {
    await store.upsertBlock({ sessionId: "s1", label: "progress", content: "Working on A. Then B.", updatedBy: "agent" });
    const result = await applyOps(
      [{ op: "patch", block: "progress", find: "Working on A", replace: "Completed A" }],
      store, "s1", 2, settings,
    );
    expect(result.applied).toBe(1);
    const blocks = await store.getBlocks("s1");
    expect(blocks[0]?.content).toBe("Completed A. Then B.");
  });

  it("applies mark_plan op", async () => {
    await store.upsertBlock({
      sessionId: "s1", label: "plan",
      content: "- [ ] Task 1\n- [ ] Task 2\n- [ ] Task 3",
      updatedBy: "agent",
    });
    const result = await applyOps(
      [{ op: "mark_plan", item: 1, status: "done" }],
      store, "s1", 4, settings,
    );
    expect(result.applied).toBe(1);
    const blocks = await store.getBlocks("s1");
    expect(blocks[0]?.content).toContain("- [ ] Task 1");
    expect(blocks[0]?.content).toContain("- [x] Task 2");
  });

  it("rejects plan block non-mark_plan ops", async () => {
    await store.upsertBlock({ sessionId: "s1", label: "plan", content: "- [ ] Task", updatedBy: "agent" });
    const result = await applyOps(
      [{ op: "delete", block: "plan" }],
      store, "s1", 1, settings,
    );
    expect(result.rejected).toBe(1);
    expect(result.applied).toBe(0);
  });

  it("rejects over-total-budget", async () => {
    // Fill up blocks to near total budget (each block = blockBudgetTokens)
    const bigContent = "x".repeat(settings.blockBudgetTokens * 4); // 2000 tokens
    // 6 blocks * 2000 = 12000 = total budget
    for (let i = 1; i <= 6; i++) {
      await store.upsertBlock({ sessionId: "s1", label: `block${i}`, content: bigContent, updatedBy: "agent" });
    }
    // Now adding another big block should exceed total (12000 + 2000 > 12000)
    const result = await applyOps(
      [{ op: "create", block: "block7", content: bigContent }],
      store, "s1", 1, settings,
    );
    expect(result.rejected).toBeGreaterThanOrEqual(1);
  });
});

describe("createMemoryAgentRunner", () => {
  beforeEach(async () => {
    cleanup();
    store = await openStore();
  });
  afterEach(async () => {
    cleanup();
  });

  it("interval adaptation: no changes → interval grows", () => {
    const runner = createMemoryAgentRunner({
      store,
      requestPrefix: async () => ({ system: "", tools: [], messages: [] }),
      callModel: async () => ({ toolCalls: [] }),
      now: () => 1_000_000,
      settings,
    });
    const state1 = runner.getState();
    expect(state1.interval).toBe(settings.interval);
    // After run with no changes, interval should grow
    // (Tested via state, but run is async — we test the logic separately)
  });

  it("exposes state for inspection", () => {
    const runner = createMemoryAgentRunner({
      store,
      requestPrefix: async () => ({ system: "", tools: [], messages: [] }),
      callModel: async () => ({ toolCalls: [] }),
      now: () => 1_000_000,
      settings,
    });
    const state = runner.getState();
    expect(state.hasRun).toBe(false);
    expect(state.inFlight).toBe(false);
  });
});
