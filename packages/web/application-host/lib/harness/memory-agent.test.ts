import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openWorkspaceKnowledge, type KnowledgeStore } from "../knowledge/store.js";
import {
  createInitialState,
  evaluateGate,
  evaluateEventGate,
  validateOp,
  applyOps,
  DEFAULT_MEMORY_AGENT_SETTINGS,
  type MemoryAgentState,
  type TurnEndMeta,
} from "./memory-agent.js";

// Scratch stores live in the OS temp dir; see recall-tool.test.ts.
const TEST_DIR = join(tmpdir(), "piarium-test-memory");
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
    expect(validateOp({ op: "mark_plan", item: 0, status: "invalid" as "done" }, existing, settings).valid).toBe(false);
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

  it("applies sequential operations against the result of the previous operation", async () => {
    const result = await applyOps([
      { op: "create", block: "progress", content: "started" },
      { op: "patch", block: "progress", find: "started", replace: "finished" },
    ], store, "s1", 2, settings);
    expect(result).toMatchObject({ applied: 2, rejected: 0, changedBlocks: true });
    await expect(store.getBlocks("s1")).resolves.toMatchObject([
      { label: "progress", content: "finished", updatedBy: "memory-agent" },
    ]);
  });

  it("rejects a stale patch instead of reporting a successful no-op", async () => {
    await store.upsertBlock({ sessionId: "s1", label: "progress", content: "current", updatedBy: "agent" });
    const result = await applyOps([
      { op: "patch", block: "progress", find: "missing", replace: "new" },
    ], store, "s1", 2, settings);
    expect(result).toMatchObject({ applied: 0, rejected: 1, changedBlocks: false });
    expect(result.errors[0]).toMatch(/not found/);
  });

  // ── Plan block protection ─────────────────────────────────────────

  it("rejects replace on plan block — keeper may only mark_plan", async () => {
    await store.upsertBlock({
      sessionId: "s1", label: "plan",
      content: "- [ ] Task 1\n- [ ] Task 2",
      updatedBy: "agent",
    });
    const result = await applyOps(
      [{ op: "replace", block: "plan", content: "- [x] All done" }],
      store, "s1", 1, settings,
    );
    expect(result.applied).toBe(0);
    expect(result.rejected).toBe(1);
    expect(result.errors[0]).toMatch(/plan block only accepts mark_plan/);
    // Plan content unchanged
    const blocks = await store.getBlocks("s1");
    expect(blocks.find((b) => b.label === "plan")?.content).toBe("- [ ] Task 1\n- [ ] Task 2");
  });

  it("rejects patch on plan block — keeper may only mark_plan", async () => {
    await store.upsertBlock({
      sessionId: "s1", label: "plan",
      content: "- [ ] Task 1",
      updatedBy: "agent",
    });
    const result = await applyOps(
      [{ op: "patch", block: "plan", find: "Task 1", replace: "Task 1 (done)" }],
      store, "s1", 1, settings,
    );
    expect(result.applied).toBe(0);
    expect(result.rejected).toBeGreaterThanOrEqual(1);
  });

  // ── Stale revision detection ──────────────────────────────────────

  it("rejects a stale replace with a conflict when expectedRevision doesn't match", async () => {
    const created = await store.upsertBlock({
      sessionId: "s1", label: "progress", content: "v1", updatedBy: "agent",
    });
    // Simulate a concurrent edit between the keeper's read and apply
    await store.upsertBlock({
      sessionId: "s1", label: "progress", content: "v2 (user edit)", updatedBy: "user",
    });
    const result = await applyOps(
      [{ op: "replace", block: "progress", content: "v3 (keeper)", expectedRevision: created.updatedAt }],
      store, "s1", 1, settings,
    );
    expect(result.applied).toBe(0);
    expect(result.rejected).toBe(1);
    expect(result.conflicts).toBeDefined();
    expect(result.conflicts![0]).toMatchObject({ block: "progress", expected: created.updatedAt });
    expect(result.conflicts![0]!.actual).not.toBe(created.updatedAt);
    // The user's edit is preserved, not silently overwritten
    const blocks = await store.getBlocks("s1");
    expect(blocks[0]?.content).toBe("v2 (user edit)");
  });

  it("applies a replace when expectedRevision matches the current block", async () => {
    const created = await store.upsertBlock({
      sessionId: "s1", label: "progress", content: "v1", updatedBy: "agent",
    });
    const result = await applyOps(
      [{ op: "replace", block: "progress", content: "v2 (keeper)", expectedRevision: created.updatedAt }],
      store, "s1", 1, settings,
    );
    expect(result.applied).toBe(1);
    expect(result.conflicts ?? []).toHaveLength(0);
  });

  it("does not let a model-supplied revision redefine create semantics", async () => {
    const result = await applyOps(
      [{ op: "create", block: "newblock", content: "fresh", expectedRevision: 999 }],
      store, "s1", 1, settings,
    );
    expect(result.applied).toBe(1);
    expect(result.conflicts ?? []).toHaveLength(0);
  });

  it("reports a conflict for mark_plan when the plan block changed since read", async () => {
    const created = await store.upsertBlock({
      sessionId: "s1", label: "plan",
      content: "- [ ] Task 1\n- [ ] Task 2",
      updatedBy: "agent",
    });
    // Concurrent user edit to plan
    await store.upsertBlock({
      sessionId: "s1", label: "plan",
      content: "- [ ] Task 1\n- [ ] Task 2\n- [ ] Task 3",
      updatedBy: "user",
    });
    const result = await applyOps(
      [{ op: "mark_plan", item: 1, status: "done", expectedRevision: created.updatedAt }],
      store, "s1", 1, settings,
    );
    expect(result.applied).toBe(0);
    expect(result.rejected).toBe(1);
    expect(result.conflicts).toBeDefined();
    expect(result.conflicts![0]!.block).toBe("plan");
  });

  it("threads revision forward for sequential ops on the same block", async () => {
    // Two ops on the same block in one apply call. The first op succeeds
    // and updates the revision. The second op should use the new revision
    // as its expectedUpdatedAt, not the original revision.
    const created = await store.upsertBlock({
      sessionId: "s1", label: "progress", content: "line1\nline2",
      updatedBy: "agent",
    });
    const result = await applyOps(
      [
        { op: "patch", block: "progress", find: "line1", replace: "LINE1", expectedRevision: created.updatedAt },
        { op: "patch", block: "progress", find: "line2", replace: "LINE2", expectedRevision: created.updatedAt },
      ],
      store, "s1", 1, settings,
    );
    // Both ops should succeed — the second op uses the threaded-forward
    // revision from the first op's successful write, not the stale original.
    expect(result.applied).toBe(2);
    expect(result.rejected).toBe(0);
    expect(result.conflicts ?? []).toHaveLength(0);
    const blocks = await store.getBlocks("s1");
    expect(blocks[0]?.content).toBe("LINE1\nLINE2");
  });

  // ── Branch ownership via ancestor resolution ──────────────────────

  it("isolates sibling branches — a block on one branch is not visible on another", async () => {
    // Branch A: root → leaf-a. Branch B: root → leaf-b (sibling).
    await store.upsertBlock({
      sessionId: "s1", label: "progress", content: "branch A state",
      updatedBy: "agent", sourceLeafId: "leaf-a",
    });
    await store.upsertBlock({
      sessionId: "s1", label: "progress", content: "branch B state",
      updatedBy: "agent", sourceLeafId: "leaf-b",
    });
    // Branch A's ancestor path includes leaf-a but not leaf-b
    const blocksA = await store.getBlocks("s1", ["root", "leaf-a"]);
    const blocksB = await store.getBlocks("s1", ["root", "leaf-b"]);
    expect(blocksA[0]?.content).toBe("branch A state");
    expect(blocksB[0]?.content).toBe("branch B state");
    expect(blocksA).toHaveLength(1);
    expect(blocksB).toHaveLength(1);
  });

  it("descendant branch inherits blocks from ancestor — leaf advances but block is still visible", async () => {
    // Block written at leaf-a. Then session advances to leaf-a1 (child of leaf-a).
    await store.upsertBlock({
      sessionId: "s1", label: "progress", content: "state at leaf-a",
      updatedBy: "agent", sourceLeafId: "leaf-a",
    });
    // New branch path: root → leaf-a → leaf-a1
    const blocks = await store.getBlocks("s1", ["root", "leaf-a", "leaf-a1"]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.content).toBe("state at leaf-a");
  });

  it("copy-on-write updates an inherited block without changing a sibling branch", async () => {
    await store.upsertBlock({
      sessionId: "s1", label: "progress", content: "original",
      updatedBy: "agent", sourceLeafId: "leaf-a",
    });
    await store.upsertBlock({
      sessionId: "s1", label: "progress", content: "original",
      updatedBy: "agent", sourceLeafId: "leaf-b",
    });
    const result = await applyOps(
      [{ op: "replace", block: "progress", content: "updated by keeper on A" }],
      store, "s1", 1, settings,
      { branchEntryIds: ["root", "leaf-a", "leaf-a1"], sourceLeafId: "leaf-a1" },
    );
    expect(result.applied).toBe(1);
    const blocksA = await store.getBlocks("s1", ["root", "leaf-a", "leaf-a1"]);
    const blocksB = await store.getBlocks("s1", ["root", "leaf-b"]);
    expect(blocksA[0]?.content).toBe("updated by keeper on A");
    expect(blocksB[0]?.content).toBe("original"); // untouched
  });

  it("applyOps creates blocks with the current sourceLeafId", async () => {
    const result = await applyOps(
      [{ op: "create", block: "decisions", content: "decided on branch X" }],
      store, "s1", 1, settings,
      { branchEntryIds: ["root", "leaf-x"], sourceLeafId: "leaf-x" },
    );
    expect(result.applied).toBe(1);
    const blocksX = await store.getBlocks("s1", ["root", "leaf-x"]);
    expect(blocksX).toHaveLength(1);
    expect(blocksX[0]?.sourceLeafId).toBe("leaf-x");
    // Not visible on a sibling branch
    const blocksSibling = await store.getBlocks("s1", ["root", "leaf-y"]);
    expect(blocksSibling).toHaveLength(0);
  });

  it("returns only the closest visible revision for each block label", async () => {
    await store.upsertBlock({
      sessionId: "s1", label: "progress", content: "ancestor",
      updatedBy: "memory-agent", sourceLeafId: "leaf-a",
    });
    await store.upsertBlock({
      sessionId: "s1", label: "progress", content: "descendant",
      updatedBy: "memory-agent", sourceLeafId: "leaf-a1",
    });
    await expect(store.getBlocks("s1", ["root", "leaf-a", "leaf-a1"]))
      .resolves.toMatchObject([{ label: "progress", content: "descendant" }]);
  });

  it("deleting an inherited block writes a branch tombstone and preserves siblings", async () => {
    const ancestor = await store.upsertBlock({
      sessionId: "s1", label: "progress", content: "shared",
      updatedBy: "memory-agent", sourceLeafId: "leaf-a",
    });
    const result = await applyOps(
      [{ op: "delete", block: "progress", expectedRevision: ancestor.updatedAt }],
      store, "s1", 1, settings,
      { branchEntryIds: ["root", "leaf-a", "leaf-a1"], sourceLeafId: "leaf-a1" },
    );
    expect(result).toMatchObject({ applied: 1, rejected: 0, changedBlocks: true });
    await expect(store.getBlocks("s1", ["root", "leaf-a", "leaf-a1"])).resolves.toEqual([]);
    await expect(store.getBlocks("s1", ["root", "leaf-a", "leaf-a2"]))
      .resolves.toMatchObject([{ content: "shared" }]);
  });

  it("treats create as an atomic absence check", async () => {
    let injected = false;
    const concurrentStore: KnowledgeStore = {
      ...store,
      upsertBlock: async (input) => {
        if (!injected) {
          injected = true;
          await store.upsertBlock({ ...input, content: "concurrent user value", updatedBy: "user" });
        }
        return store.upsertBlock(input);
      },
    };
    const result = await applyOps(
      [{ op: "create", block: "progress", content: "keeper value" }],
      concurrentStore, "s1", 1, settings,
    );
    expect(result).toMatchObject({ applied: 0, rejected: 1, changedBlocks: false });
    await expect(store.getBlocks("s1")).resolves.toMatchObject([{ content: "concurrent user value", updatedBy: "user" }]);
  });

  it("threads the created revision into a following op so an interleaved edit wins", async () => {
    let writes = 0;
    const concurrentStore: KnowledgeStore = {
      ...store,
      upsertBlock: async (input) => {
        writes += 1;
        if (writes === 2) {
          const { expectedUpdatedAt: _expected, ...unconditional } = input;
          await store.upsertBlock({ ...unconditional, content: "concurrent user value", updatedBy: "user" });
        }
        return store.upsertBlock(input);
      },
    };
    const result = await applyOps([
      { op: "create", block: "progress", content: "started" },
      { op: "patch", block: "progress", find: "started", replace: "finished" },
    ], concurrentStore, "s1", 1, settings);
    expect(result).toMatchObject({ applied: 1, rejected: 1, changedBlocks: true });
    await expect(store.getBlocks("s1"))
      .resolves.toMatchObject([{ content: "concurrent user value", updatedBy: "user" }]);
  });

  // ── Backward compatibility ────────────────────────────────────────

  it("reads old blocks (without sourceLeafId) as visible on any branch", async () => {
    // Simulate old data: write without sourceLeafId
    await store.upsertBlock({
      sessionId: "s1", label: "progress", content: "old data",
      updatedBy: "agent",
    });
    // Legacy blocks are visible on any branch (null/undefined sourceLeafId)
    const blocks = await store.getBlocks("s1", ["root", "leaf-a"]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.content).toBe("old data");
  });

  it("getBlocks without branchEntryIds returns all blocks regardless of branch", async () => {
    await store.upsertBlock({
      sessionId: "s1", label: "a", content: "x", updatedBy: "agent", sourceLeafId: "leaf-1",
    });
    await store.upsertBlock({
      sessionId: "s1", label: "b", content: "y", updatedBy: "agent", sourceLeafId: "leaf-2",
    });
    await store.upsertBlock({
      sessionId: "s1", label: "c", content: "z", updatedBy: "agent",
    });
    const all = await store.getBlocks("s1");
    expect(all).toHaveLength(3);
  });
});
