import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openWorkspaceKnowledge, type KnowledgeStore } from "./store.js";

// Scratch stores live in the OS temp dir; see harness/recall-tool.test.ts.
const TEST_DIR = join(tmpdir(), "piarium-test-tdb");

function cleanup() {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
}

let store: KnowledgeStore;
let storeCounter = 0;

async function openStore(onBlocksChanged?: (sessionId: string) => void) {
  storeCounter++;
  const dir = join(TEST_DIR, `store-${storeCounter}`);
  mkdirSync(dir, { recursive: true });
  return openWorkspaceKnowledge({
    dataDir: dir,
    hostId: "test-host",
    workspaceId: "ws-test",
    embedding: null,
    ...(onBlocksChanged ? { onBlocksChanged } : {}),
  });
}

describe("KnowledgeStore", () => {
  beforeEach(async () => {
    cleanup();
    store = await openStore();
  });

  afterEach(async () => {
    await store.close();
    cleanup();
  });

  describe("putEvent", () => {
    it("stores an event and assigns an id", async () => {
      const id = await store.putEvent({
        kind: "edit",
        at: Date.now(),
        sessionId: "s1",
        text: "modified src/index.ts",
        source: "user",
      });
      expect(typeof id).toBe("number");
      expect(id).toBeGreaterThan(0);
    });

    it("stores events with refs", async () => {
      const id = await store.putEvent({
        kind: "command",
        at: Date.now(),
        sessionId: "s1",
        text: "bun test",
        refs: { handle: "out_123" },
        source: "user",
      });
      expect(id).toBeGreaterThan(0);
    });

    it("lists session events by durable node cursor or turn fallback", async () => {
      const first = await store.putEvent({
        kind: "edit",
        at: 1,
        sessionId: "s1",
        turnIndex: 3,
        text: "modified a.ts",
        data: { kind: "modified", path: "a.ts" },
        source: "user",
      });
      const second = await store.putEvent({
        kind: "command",
        at: 2,
        sessionId: "s1",
        turnIndex: 4,
        text: "bun test",
        source: "user",
      });
      await store.putEvent({
        kind: "edit",
        at: 3,
        sessionId: "other",
        turnIndex: 4,
        text: "other session",
        source: "user",
      });

      await expect(store.listEvents({ sessionId: "s1", minTurnIndex: 4 })).resolves.toMatchObject([
        { id: second, text: "bun test" },
      ]);
      await expect(store.listEvents({ sessionId: "s1", afterId: first })).resolves.toMatchObject([
        { id: second, text: "bun test" },
      ]);
    });
  });

  describe("putSession", () => {
    it("stores a session node", async () => {
      const id = await store.putSession({
        sessionId: "s1",
        profile: "code",
        workspaceId: "ws-test",
        startedAt: Date.now(),
        harness: { version: 1 },
      });
      expect(id).toBeGreaterThan(0);
    });
  });

  describe("blocks", () => {
    it("publishes block changes only after committed writes", async () => {
      await store.close();
      const changed: string[] = [];
      store = await openStore((sessionId) => changed.push(sessionId));
      await store.upsertBlock({ sessionId: "s1", label: "progress", content: "one", updatedBy: "agent" });
      await store.deleteBlock("s1", "progress");
      expect(changed).toEqual(["s1", "s1"]);
    });

    it("upserts and retrieves blocks", async () => {
      await store.upsertBlock({
        sessionId: "s1",
        label: "progress",
        content: "Working on store tests",
        updatedBy: "agent",
      });

      const blocks = await store.getBlocks("s1");
      expect(blocks).toHaveLength(1);
      expect(blocks[0]?.label).toBe("progress");
      expect(blocks[0]?.content).toBe("Working on store tests");
      expect(blocks[0]?.updatedBy).toBe("agent");
    });

    it("upserts updates existing block", async () => {
      await store.upsertBlock({
        sessionId: "s1",
        label: "progress",
        content: "v1",
        updatedBy: "agent",
      });
      await store.upsertBlock({
        sessionId: "s1",
        label: "progress",
        content: "v2",
        updatedBy: "memory-agent",
        cursorTurn: 5,
      });

      const blocks = await store.getBlocks("s1");
      expect(blocks).toHaveLength(1);
      expect(blocks[0]?.content).toBe("v2");
      expect(blocks[0]?.updatedBy).toBe("memory-agent");
      expect(blocks[0]?.cursorTurn).toBe(5);
    });

    it("rejects invalid block names", async () => {
      await expect(store.upsertBlock({
        sessionId: "s1",
        label: "Invalid Name!",
        content: "x",
        updatedBy: "agent",
      })).rejects.toThrow();
    });

    it("deletes blocks", async () => {
      await store.upsertBlock({
        sessionId: "s1",
        label: "temp",
        content: "x",
        updatedBy: "agent",
      });
      await store.deleteBlock("s1", "temp");
      const blocks = await store.getBlocks("s1");
      expect(blocks).toHaveLength(0);
    });

    it("sorts blocks by label", async () => {
      await store.upsertBlock({ sessionId: "s1", label: "zeta", content: "z", updatedBy: "agent" });
      await store.upsertBlock({ sessionId: "s1", label: "alpha", content: "a", updatedBy: "agent" });
      await store.upsertBlock({ sessionId: "s1", label: "mid", content: "m", updatedBy: "agent" });

      const blocks = await store.getBlocks("s1");
      expect(blocks.map((b) => b.label)).toEqual(["alpha", "mid", "zeta"]);
    });
  });

  describe("knowledge", () => {
    it("puts and lists knowledge", async () => {
      const id = await store.putKnowledge({
        scope: "workspace",
        status: "suggested",
        content: "Use bun, never npm",
        trigger: "package management",
      });
      expect(id).toBeGreaterThan(0);

      const list = await store.listKnowledge({ scope: "workspace" });
      expect(list).toHaveLength(1);
      expect(list[0]?.content).toBe("Use bun, never npm");
      expect(list[0]?.status).toBe("suggested");
    });

    it("accepts knowledge", async () => {
      const id = await store.putKnowledge({
        scope: "workspace",
        status: "suggested",
        content: "Test knowledge",
        trigger: "",
      });
      await store.acceptKnowledge(id, {});

      const list = await store.listKnowledge({ status: "accepted" });
      expect(list).toHaveLength(1);
      expect(list[0]?.id).toBe(id);
    });

    it("creates supersedes chain", async () => {
      const oldId = await store.putKnowledge({
        scope: "workspace",
        status: "accepted",
        content: "Old rule",
        trigger: "build",
      });
      const newId = await store.putKnowledge({
        scope: "workspace",
        status: "suggested",
        content: "New rule",
        trigger: "build",
      });
      await store.acceptKnowledge(newId, { supersedes: [oldId] });

      const all = await store.listKnowledge({});
      const old = all.find((k) => k.id === oldId);
      const newer = all.find((k) => k.id === newId);
      expect(old?.invalidAt).toBeDefined();
      expect(newer?.status).toBe("accepted");

      // Active only should exclude old
      const active = await store.listKnowledge({ activeOnly: true });
      expect(active.find((k) => k.id === oldId)).toBeUndefined();
    });

    it("dismisses knowledge", async () => {
      const id = await store.putKnowledge({
        scope: "workspace",
        status: "suggested",
        content: "Dismiss me",
        trigger: "",
      });
      await store.dismissKnowledge(id);
      const list = await store.listKnowledge({ status: "dismissed" });
      expect(list).toHaveLength(1);
    });
  });

  describe("file and symbol graph", () => {
    const range = { startLine: 0, startCharacter: 0, endLine: 0, endCharacter: 5 };

    it("atomically replaces one file's active symbols and removes stale nodes", async () => {
      const first = await store.replaceFileSymbols("src/a.ts", "typescript", [
        { name: "Alpha", kind: "function", range },
        { name: "Beta", kind: "class", range: { ...range, startLine: 2, endLine: 4 } },
      ]);
      expect(first).toMatchObject({ symbols: 2, edges: 2 });
      expect(await store.searchSymbols("Alpha", 10)).toEqual([
        expect.objectContaining({ name: "Alpha", path: "src/a.ts", score: expect.any(Number) }),
      ]);
      expect((await store.getDefinedSymbols("src/a.ts")).map((symbol) => symbol.name)).toEqual(["Alpha", "Beta"]);

      await store.touchFile("src/a.ts", "typescript");
      expect(await store.searchSymbols("Beta", 10)).toHaveLength(1);
      await store.replaceFileSymbols("src/a.ts", "typescript", [
        { name: "Gamma", kind: "variable", range },
      ]);
      expect(await store.searchSymbols("Alpha", 10)).toEqual([]);
      expect(await store.searchSymbols("Gamma", 10)).toHaveLength(1);
      expect((await store.getDefinedSymbols("src/a.ts")).map((symbol) => symbol.name)).toEqual(["Gamma"]);

      await expect(store.removeFileSymbols("src/a.ts")).resolves.toEqual({ removedFiles: 1, removedSymbols: 1 });
      expect(await store.searchSymbols("Gamma", 10)).toEqual([]);
    });

    it("rejects malformed ranges before replacing the previous graph", async () => {
      await store.replaceFileSymbols("src/a.ts", "typescript", [{ name: "Stable", kind: "class", range }]);
      await expect(store.replaceFileSymbols("src/a.ts", "typescript", [{
        name: "Broken",
        kind: "class",
        range: { startLine: 2, startCharacter: 0, endLine: 1, endCharacter: 0 },
      }])).rejects.toMatchObject({ code: "invalid" });
      expect(await store.searchSymbols("Stable", 10)).toHaveLength(1);
    });
  });

  describe("recall", () => {
    it("returns results in placeholder vector mode", async () => {
      await store.putKnowledge({
        scope: "workspace",
        status: "accepted",
        content: "Always use bun test for running tests",
        trigger: "testing",
      });
      await store.putKnowledge({
        scope: "workspace",
        status: "accepted",
        content: "Use vitest for unit tests",
        trigger: "unit testing",
      });

      const results = await store.recall("test", 5);
      expect(results.length).toBeGreaterThan(0);
      // All results should be via text in placeholder mode
      expect(results.every((r) => r.via === "text")).toBe(true);
    });

    it("records recall count for knowledge nodes", async () => {
      const id = await store.putKnowledge({
        scope: "workspace",
        status: "accepted",
        content: "Important rule about testing",
        trigger: "testing",
      });
      await store.recall("testing", 5);

      const list = await store.listKnowledge({});
      const k = list.find((item) => item.id === id);
      expect(k?.recallCount).toBeGreaterThan(0);
      expect(k?.recalledAt).toBeDefined();
    });
  });

  describe("deleteSession", () => {
    it("cascades delete events and blocks", async () => {
      await store.putEvent({
        kind: "edit", at: Date.now(), sessionId: "s1",
        text: "edit event", source: "user",
      });
      await store.upsertBlock({
        sessionId: "s1", label: "progress",
        content: "x", updatedBy: "agent",
      });
      await store.putSession({
        sessionId: "s1", profile: "code",
        workspaceId: "ws-test", startedAt: Date.now(),
        harness: {},
      });

      await store.deleteSession("s1");

      const blocks = await store.getBlocks("s1");
      expect(blocks).toHaveLength(0);
    });
  });

  describe("runRetention", () => {
    it("removes old events", async () => {
      const oldTime = Date.now() - 40 * 24 * 60 * 60 * 1000; // 40 days ago
      await store.putEvent({
        kind: "edit", at: oldTime, sessionId: "s1",
        text: "old event", source: "user",
      });
      await store.putEvent({
        kind: "edit", at: Date.now(), sessionId: "s1",
        text: "new event", source: "user",
      });

      const result = await store.runRetention(new Date(), { eventRetentionDays: 30 });
      expect(result.removed).toBe(1);
    });
  });

  describe("dim", () => {
    it("returns placeholder dim when no embedding", () => {
      expect(store.dim).toBe(8);
    });
  });
});
