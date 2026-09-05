import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openWorkspaceKnowledge, type KnowledgeStore } from "../knowledge/store.js";
import {
  assembleCompactionSummary,
  handleBeforeCompact,
  assembleReinjectMessage,
  createKeeperCoverageStore,
  evaluateKeeperCoverage,
  DEFAULT_COMPACTION_SETTINGS,
  type CompactionFacts,
} from "./compaction.js";

const TAKEOVER_SETTINGS = { ...DEFAULT_COMPACTION_SETTINGS, takeoverEnabled: true };

// Scratch stores live in the OS temp dir; see recall-tool.test.ts.
const TEST_DIR = join(tmpdir(), "piarium-test-compaction");
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
      updatedBy: "memory-agent",
    });

    const coverage = createKeeperCoverageStore();
    coverage.extend("s1", ["e1", "e2", "e3", "e4", "e5", "e6", "e7"]);
    const result = await handleBeforeCompact("s1", {
      store,
      settings: TAKEOVER_SETTINGS,
      getFacts: async () => ({
        touchedFiles: ["a.ts"],
        unresolvedDiagnostics: [],
        checkpoints: ["2026-09-03T10:00Z"],
      }),
      coverageStore: coverage,
    }, { firstKeptEntryId: "entry-8", tokensBefore: 50000, branchEntryIds: ["e1", "e2", "e3", "e4", "e5", "e6", "e7", "entry-8"], removedEntryIds: ["e1", "e2", "e3", "e4", "e5", "e6", "e7"] });

    expect(result.summary).toContain("<piarium-compaction");
    expect(result.summary).toContain("Working");
    expect(result.firstKeptEntryId).toBe("entry-8");
    expect(result.tokensBefore).toBe(50000);
  });

  it("adds stale note when requested", async () => {
    await store.upsertBlock({
      sessionId: "s1", label: "progress", content: "Working",
      updatedBy: "memory-agent",
    });
    const coverage = createKeeperCoverageStore();
    coverage.extend("s1", ["e1"]);
    const result = await handleBeforeCompact("s1", {
      store,
      settings: TAKEOVER_SETTINGS,
      getFacts: async () => emptyFacts,
      coverageStore: coverage,
    }, { firstKeptEntryId: "entry", tokensBefore: 1000, branchEntryIds: ["e1", "entry"], removedEntryIds: ["e1"] }, { staleNote: true });

    expect(result.summary).toContain("memory blocks may be stale");
  });

  it("throws unavailable when there are no blocks at all", async () => {
    try {
      await handleBeforeCompact("s1", {
        store,
        settings: TAKEOVER_SETTINGS,
        getFacts: async () => emptyFacts,
      }, { firstKeptEntryId: "entry", tokensBefore: 1000, branchEntryIds: ["entry"], removedEntryIds: [] });
      expect.fail("should have thrown");
    } catch (e) {
      expect((e as { harnessCode?: string }).harnessCode).toBe("unavailable");
    }
  });

  // Taking compaction over replaces the conversation with the summary, so a
  // todo checklist is not enough material to justify it — Pi must summarize.
  it("throws unavailable when only the agent's plan block exists", async () => {
    await store.upsertBlock({
      sessionId: "s1", label: "plan", content: "- [ ] Task",
      updatedBy: "agent",
    });
    try {
      await handleBeforeCompact("s1", {
        store,
        settings: TAKEOVER_SETTINGS,
        getFacts: async () => ({
          touchedFiles: ["a.ts"],
          unresolvedDiagnostics: [],
          checkpoints: ["2026-09-03T10:00Z"],
        }),
      }, { firstKeptEntryId: "entry", tokensBefore: 1000, branchEntryIds: ["entry"], removedEntryIds: [] });
      expect.fail("should have thrown");
    } catch (e) {
      expect((e as { harnessCode?: string }).harnessCode).toBe("unavailable");
    }
  });

  it("does not treat a plan status update by the memory keeper as a conversation summary", async () => {
    await store.upsertBlock({
      sessionId: "s1", label: "plan", content: "- [x] Task",
      updatedBy: "memory-agent",
    });
    await expect(handleBeforeCompact("s1", {
      store,
      settings: TAKEOVER_SETTINGS,
      getFacts: async () => emptyFacts,
    }, { firstKeptEntryId: "entry", tokensBefore: 1000, branchEntryIds: ["entry"], removedEntryIds: [] })).rejects.toMatchObject({
      harnessCode: "unavailable",
    });
  });

  it("takes over once the memory keeper has written a block", async () => {
    await store.upsertBlock({
      sessionId: "s1", label: "plan", content: "- [ ] Task",
      updatedBy: "agent",
    });
    await store.upsertBlock({
      sessionId: "s1", label: "decisions", content: "Chose PTY over spawn",
      updatedBy: "memory-agent",
    });
    const coverage = createKeeperCoverageStore();
    coverage.extend("s1", ["e1", "e2", "e3", "e4", "e5", "e6", "e7"]);
    const result = await handleBeforeCompact("s1", {
      store,
      settings: TAKEOVER_SETTINGS,
      getFacts: async () => emptyFacts,
      coverageStore: coverage,
    }, { firstKeptEntryId: "entry-8", tokensBefore: 1000, branchEntryIds: ["e1", "e2", "e3", "e4", "e5", "e6", "e7", "entry-8"], removedEntryIds: ["e1", "e2", "e3", "e4", "e5", "e6", "e7"] });

    expect(result.summary).toContain("Chose PTY over spawn");
    expect(result.firstKeptEntryId).toBe("entry-8");
  });

  it("keeps Pi compaction authoritative while the memory keeper is in shadow mode", async () => {
    await store.upsertBlock({
      sessionId: "s1", label: "progress", content: "Observed only",
      updatedBy: "memory-agent",
    });
    await expect(handleBeforeCompact("s1", {
      store,
      settings: DEFAULT_COMPACTION_SETTINGS,
      getFacts: async () => emptyFacts,
    }, { firstKeptEntryId: "entry", tokensBefore: 1000, branchEntryIds: ["entry"], removedEntryIds: [] })).rejects.toMatchObject({
      harnessCode: "unavailable",
    });
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

describe("keeper coverage store", () => {
  it("returns none when no coverage exists", () => {
    const store = createKeeperCoverageStore();
    expect(store.get("s1")).toBeNull();
    const state = evaluateKeeperCoverage(null, ["e1", "e2", "e3"]);
    expect(state.status).toBe("none");
    expect(state.uncovered).toEqual(["e1", "e2", "e3"]);
  });

  it("extends coverage with entry IDs", () => {
    const store = createKeeperCoverageStore();
    store.extend("s1", ["e1", "e2", "e3"]);
    const entry = store.get("s1");
    expect(entry).not.toBeNull();
    expect(entry!.coveredEntryIds.has("e1")).toBe(true);
    expect(entry!.coveredEntryIds.has("e2")).toBe(true);
    expect(entry!.coveredEntryIds.has("e3")).toBe(true);
  });

  it("accumulates coverage across multiple extends", () => {
    const store = createKeeperCoverageStore();
    store.extend("s1", ["e1", "e2"]);
    store.extend("s1", ["e3", "e4"]);
    const entry = store.get("s1");
    expect(entry!.coveredEntryIds.size).toBe(4);
    expect(entry!.coveredEntryIds.has("e4")).toBe(true);
  });

  it("reports ready when all removed entries are covered", () => {
    const store = createKeeperCoverageStore();
    store.extend("s1", ["e1", "e2", "e3", "e4", "e5"]);
    const entry = store.get("s1");
    const state = evaluateKeeperCoverage(entry, ["e1", "e2", "e3"]);
    expect(state.status).toBe("ready");
    expect(state.uncovered).toHaveLength(0);
  });

  it("reports partial when some removed entries are not covered", () => {
    const store = createKeeperCoverageStore();
    // Keeper only processed e3-e5, but compaction removes e1-e4
    store.extend("s1", ["e3", "e4", "e5"]);
    const entry = store.get("s1");
    const state = evaluateKeeperCoverage(entry, ["e1", "e2", "e3", "e4"]);
    expect(state.status).toBe("partial");
    expect(state.uncovered).toEqual(["e1", "e2"]);
  });

  it("clears coverage for a session", () => {
    const store = createKeeperCoverageStore();
    store.extend("s1", ["e1", "e2"]);
    store.clear("s1");
    expect(store.get("s1")).toBeNull();
  });
});

describe("handleBeforeCompact with coverage", () => {
  beforeEach(async () => {
    cleanup();
    store = await openStore();
  });
  afterEach(async () => {
    await store.close();
    cleanup();
  });

  it("takes over when coverage covers all removed entries", async () => {
    await store.upsertBlock({
      sessionId: "s1", label: "progress", content: "Working",
      updatedBy: "memory-agent",
    });
    const coverage = createKeeperCoverageStore();
    // Keeper processed entries e1 through e10
    coverage.extend("s1", ["e1", "e2", "e3", "e4", "e5", "e6", "e7", "e8", "e9", "e10"]);
    const result = await handleBeforeCompact("s1", {
      store,
      settings: TAKEOVER_SETTINGS,
      getFacts: async () => emptyFacts,
      coverageStore: coverage,
    }, { firstKeptEntryId: "e8", tokensBefore: 1000, branchEntryIds: ["e1", "e2", "e3", "e4", "e5", "e6", "e7", "e8"], removedEntryIds: ["e1", "e2", "e3", "e4", "e5", "e6", "e7"] });
    expect(result.summary).toContain("Working");
  });

  it("uses only blocks visible on the active compaction branch", async () => {
    await store.upsertBlock({
      sessionId: "s1", label: "progress", content: "branch A",
      updatedBy: "memory-agent", sourceLeafId: "a",
    });
    await store.upsertBlock({
      sessionId: "s1", label: "progress", content: "branch B",
      updatedBy: "memory-agent", sourceLeafId: "b",
    });
    const coverage = createKeeperCoverageStore();
    coverage.extend("s1", ["root", "a"]);
    const result = await handleBeforeCompact("s1", {
      store,
      settings: TAKEOVER_SETTINGS,
      getFacts: async () => emptyFacts,
      coverageStore: coverage,
    }, {
      firstKeptEntryId: "kept",
      tokensBefore: 1000,
      branchEntryIds: ["root", "a", "kept"],
      removedEntryIds: ["root", "a"],
    });
    expect(result.summary).toContain("branch A");
    expect(result.summary).not.toContain("branch B");
  });

  it("rejects takeover when coverage is partial", async () => {
    await store.upsertBlock({
      sessionId: "s1", label: "progress", content: "Working",
      updatedBy: "memory-agent",
    });
    const coverage = createKeeperCoverageStore();
    // Only covered e5-e10, but removing e1-e7
    coverage.extend("s1", ["e5", "e6", "e7", "e8", "e9", "e10"]);
    await expect(handleBeforeCompact("s1", {
      store,
      settings: TAKEOVER_SETTINGS,
      getFacts: async () => emptyFacts,
      coverageStore: coverage,
    }, { firstKeptEntryId: "e8", tokensBefore: 1000, branchEntryIds: ["e1", "e2", "e3", "e4", "e5", "e6", "e7", "e8"], removedEntryIds: ["e1", "e2", "e3", "e4", "e5", "e6", "e7"] })).rejects.toMatchObject({
      harnessCode: "unavailable",
    });
  });

  it("rejects takeover when coverage is none", async () => {
    await store.upsertBlock({
      sessionId: "s1", label: "progress", content: "Working",
      updatedBy: "memory-agent",
    });
    const coverage = createKeeperCoverageStore();
    // No coverage at all
    await expect(handleBeforeCompact("s1", {
      store,
      settings: TAKEOVER_SETTINGS,
      getFacts: async () => emptyFacts,
      coverageStore: coverage,
    }, { firstKeptEntryId: "e8", tokensBefore: 1000, branchEntryIds: ["e1", "e2", "e3", "e4", "e5", "e6", "e7", "e8"], removedEntryIds: ["e1", "e2", "e3", "e4", "e5", "e6", "e7"] })).rejects.toMatchObject({
      harnessCode: "unavailable",
    });
  });

  it("rejects takeover when Pi reports no removable context entries", async () => {
    await store.upsertBlock({
      sessionId: "s1", label: "progress", content: "Working",
      updatedBy: "memory-agent",
    });
    const coverage = createKeeperCoverageStore();
    coverage.extend("s1", ["e1", "e2"]);
    // An empty removal range cannot authorize takeover.
    await expect(handleBeforeCompact("s1", {
      store,
      settings: TAKEOVER_SETTINGS,
      getFacts: async () => emptyFacts,
      coverageStore: coverage,
    }, { firstKeptEntryId: "e8", tokensBefore: 1000, branchEntryIds: ["e8"], removedEntryIds: [] })).rejects.toMatchObject({
      harnessCode: "unavailable",
    });
  });

  it("rejects takeover when coverage store is not configured", async () => {
    await store.upsertBlock({
      sessionId: "s1", label: "progress", content: "Working",
      updatedBy: "memory-agent",
    });
    // No coverageStore provided
    await expect(handleBeforeCompact("s1", {
      store,
      settings: TAKEOVER_SETTINGS,
      getFacts: async () => emptyFacts,
    }, { firstKeptEntryId: "e8", tokensBefore: 1000, branchEntryIds: ["e1", "e2", "e8"], removedEntryIds: ["e1", "e2"] })).rejects.toMatchObject({
      harnessCode: "unavailable",
    });
  });
});
