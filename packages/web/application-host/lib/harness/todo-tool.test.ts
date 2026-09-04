import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openWorkspaceKnowledge, type KnowledgeStore } from "../knowledge/store.js";
import {
  renderPlanContent,
  parsePlanContent,
  executeTodoTool,
  DEFAULT_TODO_SETTINGS,
  type TodoItem,
} from "./todo-tool.js";

// Scratch stores live in the OS temp dir; see recall-tool.test.ts.
const TEST_DIR = join(tmpdir(), "piarium-test-todo");
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

describe("renderPlanContent", () => {
  it("renders open items with [ ]", () => {
    const content = renderPlanContent([{ text: "Task A", status: "open" }]);
    expect(content).toBe("- [ ] Task A");
  });

  it("renders done items with [x]", () => {
    const content = renderPlanContent([{ text: "Task A", status: "done" }]);
    expect(content).toBe("- [x] Task A");
  });

  it("renders blocked items with [!]", () => {
    const content = renderPlanContent([{ text: "Task A", status: "blocked" }]);
    expect(content).toBe("- [!] Task A");
  });

  it("renders multiple items on separate lines", () => {
    const content = renderPlanContent([
      { text: "Task 1", status: "done" },
      { text: "Task 2", status: "open" },
      { text: "Task 3", status: "blocked" },
    ]);
    expect(content).toBe("- [x] Task 1\n- [ ] Task 2\n- [!] Task 3");
  });
});

describe("parsePlanContent", () => {
  it("parses round-trip", () => {
    const items: TodoItem[] = [
      { text: "Task 1", status: "done" },
      { text: "Task 2", status: "open" },
      { text: "Task 3", status: "blocked" },
    ];
    const content = renderPlanContent(items);
    const parsed = parsePlanContent(content);
    expect(parsed).toEqual(items);
  });

  it("ignores non-matching lines", () => {
    const content = "- [x] Done task\nsome other line\n- [ ] Open task";
    const parsed = parsePlanContent(content);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]?.status).toBe("done");
    expect(parsed[1]?.status).toBe("open");
  });
});

describe("executeTodoTool", () => {
  beforeEach(async () => {
    cleanup();
    store = await openStore();
  });
  afterEach(async () => {
    await store.close();
    cleanup();
  });

  it("replaces plan block and returns summary", async () => {
    const result = await executeTodoTool(
      { items: [
        { text: "Task 1", status: "done" },
        { text: "Task 2", status: "open" },
        { text: "Task 3", status: "blocked" },
      ]},
      { store, sessionId: "s1", settings: DEFAULT_TODO_SETTINGS },
      true, // session already confirmed
    );
    expect(result.text).toBe("plan updated: 1/3 done, 1 blocked");
    expect(result.askedConfirmation).toBe(false);

    const blocks = await store.getBlocks("s1");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.label).toBe("plan");
    expect(blocks[0]?.updatedBy).toBe("agent");
    expect(blocks[0]?.content).toContain("- [x] Task 1");
  });

  it("requires confirmation without writing when confidence is low", async () => {
    const result = await executeTodoTool(
      { items: [{ text: "Task", status: "open" }], confidence: 0.3 },
      { store, sessionId: "s1", settings: DEFAULT_TODO_SETTINGS },
      false,
    );
    expect(result.askedConfirmation).toBe(true);
    expect(result.confirmed).toBe(false);
    expect(result.text).toContain("requires user confirmation");
    expect(await store.getBlocks("s1")).toHaveLength(0);
  });

  it("writes a low-confidence plan after pi-host confirms it", async () => {
    const result = await executeTodoTool(
      { items: [{ text: "Task", status: "open" }], confidence: 0.3 },
      { store, sessionId: "s1", settings: DEFAULT_TODO_SETTINGS },
      true,
    );
    expect(result.askedConfirmation).toBe(true);
    expect(result.confirmed).toBe(true);
    expect(await store.getBlocks("s1")).toHaveLength(1);
  });

  it("does not require confirmation when confidence is high", async () => {
    const result = await executeTodoTool(
      { items: [{ text: "Task", status: "open" }], confidence: 0.9 },
      { store, sessionId: "s1", settings: DEFAULT_TODO_SETTINGS },
      false,
    );
    expect(result.askedConfirmation).toBe(false);
  });

  it("does not require confirmation when confidence is absent", async () => {
    const result = await executeTodoTool(
      { items: [{ text: "Task", status: "open" }] },
      { store, sessionId: "s1", settings: DEFAULT_TODO_SETTINGS },
      false,
    );
    expect(result.askedConfirmation).toBe(false);
  });
});
