import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { openWorkspaceKnowledge, type KnowledgeStore } from "../knowledge/store.js";
import {
  assembleCompactionSummary,
  handleBeforeCompact,
  assembleReinjectMessage,
  DEFAULT_COMPACTION_SETTINGS,
  type CompactionFacts,
} from "./compaction.js";

const TEST_DIR = join(import.meta.dirname, ".test-compaction");
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

const emptyFacts: CompactionFacts = {
  touchedFiles: [],
  unresolvedDiagnostics: [],
  checkpoints: [],
};

describe("assembleCompactionSummary", () => {
  it("includes plan section", () => {
    const summary = assembleCompactionSummary({
      blocks: [],
      plan: "- [x] Task 1\n- [ ] Task 2",
      facts: emptyFacts,
      recentTurnsToKeep: 8,
    });
    expect(summary).toContain("<plan>");
    expect(summary).toContain("Task 1");
    expect(summary).toContain("</piarium-compaction>");
  });

  it("includes blocks section (excluding plan)", () => {
    const summary = assembleCompactionSummary({
      blocks: [
        { sessionId: "s1", label: "progress", content: "Working on tests", updatedBy: "agent", updatedAt: 0 },
        { sessionId: "s1", label: "decisions", content: "Use vitest", updatedBy: "agent", updatedAt: 0 },
      ],
      plan: "",
      facts: emptyFacts,
      recentTurnsToKeep: 8,
    });
    expect(summary).toContain("<blocks>");
    expect(summary).toContain("[progress] Working on tests");
    expect(summary).toContain("[decisions] Use vitest");
  });

  it("includes facts section", () => {
    const summary = assembleCompactionSummary({
      blocks: [],
      plan: "",
      facts: {
        touchedFiles: ["a.ts", "b.ts", "c.ts"],
        unresolvedDiagnostics: [{ path: "c.ts", count: 2 }],
        checkpoints: ["2026-09-03T10:12Z"],
      },
      recentTurnsToKeep: 8,
    });
    expect(summary).toContain("<facts>");
    expect(summary).toContain("files touched: a.ts, b.ts, c.ts");
    expect(summary).toContain("unresolved diagnostics: c.ts (2)");
    expect(summary).toContain("last checkpoint: 2026-09-03T10:12Z");
  });

  it("truncates touched files list", () => {
    const files = Array.from({ length: 15 }, (_, i) => `file${i}.ts`);
    const summary = assembleCompactionSummary({
      blocks: [], plan: "",
      facts: { touchedFiles: files, unresolvedDiagnostics: [], checkpoints: [] },
      recentTurnsToKeep: 8,
    });
    expect(summary).toContain("+5 more");
  });

  it("wraps in piarium-compaction tag with note", () => {
    const summary = assembleCompactionSummary({
      blocks: [], plan: "x", facts: emptyFacts, recentTurnsToKeep: 8,
    });
    expect(summary).toContain('<piarium-compaction note="State carried across compaction.');
  });

  it("non-stacking: summary only contains current blocks, not previous summary", () => {
    // First compaction summary
    const firstSummary = assembleCompactionSummary({
      blocks: [{ sessionId: "s1", label: "progress", content: "First pass", updatedBy: "agent", updatedAt: 0 }],
      plan: "- [ ] Task",
      facts: emptyFacts,
      recentTurnsToKeep: 8,
    });
    // Second compaction should use new blocks, not include firstSummary
    const secondSummary = assembleCompactionSummary({
      blocks: [{ sessionId: "s1", label: "progress", content: "Second pass", updatedBy: "agent", updatedAt: 0 }],
      plan: "- [x] Task",
      facts: emptyFacts,
      recentTurnsToKeep: 8,
    });
    expect(secondSummary).toContain("Second pass");
    expect(secondSummary).not.toContain("First pass");
    expect(secondSummary).not.toContain(firstSummary);
  });
});

describe("handleBeforeCompact", () => {
  beforeEach(async () => {
    cleanup();
    store = await openStore();
  });
  afterEach(async () => {
    await store.close();
    cleanup();
  });

  it("returns compaction result with summary", async () => {
    await store.upsertBlock({
      sessionId: "s1", label: "plan", content: "- [ ] Task",
      updatedBy: "agent",
    });
    await store.upsertBlock({
      sessionId: "s1", label: "progress", content: "Working",
      updatedBy: "agent",
    });

    const result = await handleBeforeCompact("s1", {
      store,
      settings: DEFAULT_COMPACTION_SETTINGS,
      getFacts: async () => ({
        touchedFiles: ["a.ts"],
        unresolvedDiagnostics: [],
        checkpoints: ["2026-09-03T10:00Z"],
      }),
      getEntryIdAtTurn: async (n) => `entry-${n}`,
      getTokensBefore: () => 50000,
    });

    expect(result.summary).toContain("<piarium-compaction");
    expect(result.summary).toContain("Working");
    expect(result.firstKeptEntryId).toBe("entry-8");
    expect(result.tokensBefore).toBe(50000);
  });

  it("adds stale note when requested", async () => {
    await store.upsertBlock({
      sessionId: "s1", label: "plan", content: "- [ ] Task",
      updatedBy: "agent",
    });
    const result = await handleBeforeCompact("s1", {
      store,
      settings: DEFAULT_COMPACTION_SETTINGS,
      getFacts: async () => emptyFacts,
      getEntryIdAtTurn: async () => "entry",
      getTokensBefore: () => 1000,
    }, { staleNote: true });

    expect(result.summary).toContain("memory blocks may be stale");
  });

  it("throws unavailable when getEntryIdAtTurn returns null", async () => {
    try {
      await handleBeforeCompact("s1", {
        store,
        settings: DEFAULT_COMPACTION_SETTINGS,
        getFacts: async () => ({ touchedFiles: ["a.ts"], unresolvedDiagnostics: [], checkpoints: [] }),
        getEntryIdAtTurn: async () => null,
        getTokensBefore: () => 1000,
      });
      expect.fail("should have thrown");
    } catch (e) {
      expect((e as { harnessCode?: string }).harnessCode).toBe("unavailable");
    }
  });

  it("throws unavailable when no blocks and no facts", async () => {
    try {
      await handleBeforeCompact("s1", {
        store,
        settings: DEFAULT_COMPACTION_SETTINGS,
        getFacts: async () => emptyFacts,
        getEntryIdAtTurn: async () => "entry",
        getTokensBefore: () => 1000,
      });
      expect.fail("should have thrown");
    } catch (e) {
      expect((e as { harnessCode?: string }).harnessCode).toBe("unavailable");
    }
  });
});

describe("assembleReinjectMessage", () => {
  it("includes files up to limit", () => {
    const result = assembleReinjectMessage(
      [
        { path: "a.ts", content: "content a" },
        { path: "b.ts", content: "content b" },
      ],
      ["skill1", "skill2"],
      DEFAULT_COMPACTION_SETTINGS,
    );
    expect(result.filesReinjected).toBe(2);
    expect(result.skillsReinjected).toBe(2);
    expect(result.message).toContain("a.ts");
    expect(result.message).toContain("b.ts");
    expect(result.message).toContain("skill1");
  });

  it("respects file limit", () => {
    const files = Array.from({ length: 10 }, (_, i) => ({
      path: `file${i}.ts`, content: "x",
    }));
    const result = assembleReinjectMessage(files, [], DEFAULT_COMPACTION_SETTINGS);
    expect(result.filesReinjected).toBe(DEFAULT_COMPACTION_SETTINGS.reinjectFileLimit);
  });
});
