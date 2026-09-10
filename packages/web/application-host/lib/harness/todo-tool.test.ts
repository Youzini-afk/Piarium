import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openWorkspaceKnowledge, type KnowledgeStore } from "../knowledge/store.js";
import {
  renderPlanContent,
  parsePlanContent,
  executeTodoTool,
  type TodoItem,
} from "./todo-tool.js";

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
      { store, sessionId: "s1" },
    );
    expect(result.text).toBe("plan updated: 1/3 done, 1 blocked");

    const blocks = await store.getBlocks("s1");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.label).toBe("plan");
    expect(blocks[0]?.updatedBy).toBe("agent");
    expect(blocks[0]?.content).toContain("- [x] Task 1");
  });

  it("treats confidence as informational and writes without confirmation", async () => {
    await executeTodoTool(
      { items: [{ text: "Task", status: "open" }], confidence: 0.3 },
      { store, sessionId: "s1" },
    );
    expect(await store.getBlocks("s1")).toHaveLength(1);
  });

  it("does not add a second confirmation path when confidence is absent", async () => {
    await executeTodoTool(
      { items: [{ text: "Task", status: "open" }] },
      { store, sessionId: "s1" },
    );
  });
});
