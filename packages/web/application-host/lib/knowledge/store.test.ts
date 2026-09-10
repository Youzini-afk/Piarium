import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openWorkspaceKnowledge, type BlockChange, type KnowledgeStore } from "./store.js";

// Scratch stores live in the OS temp dir; see harness/recall-tool.test.ts.
const TEST_DIR = join(tmpdir(), "piarium-test-tdb");

function cleanup() {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
}

let store: KnowledgeStore;
let storeCounter = 0;

async function openStore(onBlocksChanged?: (sessionId: string, change: BlockChange) => void) {
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
      const changes: BlockChange[] = [];
      store = await openStore((sessionId, change) => { changed.push(sessionId); changes.push(change); });
      await store.upsertBlock({ sessionId: "s1", label: "progress", content: "one", updatedBy: "agent" });
      await store.deleteBlock("s1", "progress");
      expect(changed).toEqual(["s1", "s1"]);
      expect(changes).toMatchObject([
        { previous: null, current: { content: "one" } },
        { previous: { content: "one" }, current: null },
      ]);
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

    it("edits current accepted knowledge and rejects stale or retired rows", async () => {
      const id = await store.putKnowledge({
        scope: "workspace",
        status: "accepted",
        content: "Use npm",
        trigger: "packages",
      });
      await store.updateAcceptedKnowledge(id, { content: "Use bun", trigger: "packages" }, "workspace", {
        content: "Use npm",
        trigger: "packages",
      });
      expect(await store.getKnowledge(id)).toMatchObject({ content: "Use bun", status: "accepted" });
      await expect(store.updateAcceptedKnowledge(id, { content: "stale", trigger: "packages" }, "workspace", {
        content: "Use npm",
        trigger: "packages",
      })).rejects.toMatchObject({ code: "conflict" });
      await store.retireKnowledge(id, "workspace", {
        content: "Use bun",
        trigger: "packages",
        status: "accepted",
      });
      await expect(store.updateAcceptedKnowledge(id, { content: "again", trigger: "packages" }, "workspace", {
        content: "Use bun",
        trigger: "packages",
      })).rejects.toMatchObject({ code: "conflict" });
    });

    it("retires one identity without cascading or dropping history", async () => {
      const kept = await store.putKnowledge({
        scope: "workspace",
        status: "accepted",
        content: "Keep unique-kept-phrase",
        trigger: "keep",
      });
      const retired = await store.putKnowledge({
        scope: "workspace",
        status: "accepted",
        content: "Retire unique-retired-phrase",
        trigger: "drop",
      });
      const otherScope = await store.putKnowledge({
        scope: "user",
        status: "accepted",
        content: "Retire unique-retired-phrase",
        trigger: "drop",
      });
      await store.retireKnowledge(retired, "workspace", {
        content: "Retire unique-retired-phrase",
        trigger: "drop",
        status: "accepted",
      });
      expect((await store.getKnowledge(retired))?.invalidAt).toEqual(expect.any(Number));
      expect((await store.getKnowledge(kept))?.invalidAt).toBeUndefined();
      expect((await store.getKnowledge(otherScope))?.invalidAt).toBeUndefined();
      expect(await store.listKnowledge({ status: "accepted", activeOnly: true }))
        .toEqual(expect.arrayContaining([
          expect.objectContaining({ id: kept }),
          expect.objectContaining({ id: otherScope }),
        ]));
      expect((await store.listKnowledge({ status: "accepted", activeOnly: true })).map((item) => item.id))
        .not.toContain(retired);
      expect(await store.recall("unique-retired-phrase", 5)).toEqual([]);
      expect((await store.recall("unique-kept-phrase", 5)).map((row) => row.node.id)).toEqual([kept]);
      await expect(store.retireKnowledge(retired, "workspace", {
        content: "Retire unique-retired-phrase",
        trigger: "drop",
        status: "accepted",
      })).rejects.toMatchObject({ code: "conflict" });
    });

    it("walks a supersede chain in both directions", async () => {
      const first = await store.putKnowledge({
        scope: "workspace",
        status: "accepted",
        content: "v1",
        trigger: "rule",
      });
      const second = await store.putKnowledge({
        scope: "workspace",
        status: "suggested",
        content: "v2",
        trigger: "rule",
      });
      await store.acceptKnowledge(second, { supersedes: [first] });
      const third = await store.putKnowledge({
        scope: "workspace",
        status: "suggested",
        content: "v3",
        trigger: "rule",
      });
      await store.acceptKnowledge(third, { supersedes: [second] });
      const fromFirst = await store.getSupersedeChain(first, "workspace");
      expect(fromFirst?.chain.map((item) => item.id)).toEqual([first, second, third]);
      expect(fromFirst?.successors.map((item) => item.id)).toEqual([second, third]);
      const fromThird = await store.getSupersedeChain(third, "workspace");
      expect(fromThird?.predecessors.map((item) => item.id)).toEqual([first, second]);
      expect(fromThird?.chain.map((item) => item.content)).toEqual(["v1", "v2", "v3"]);
    });

    it("rejects non-user writes on the user store", async () => {
      const userDir = join(TEST_DIR, "user-store");
      mkdirSync(userDir, { recursive: true });
      const userStore = await openWorkspaceKnowledge({
        dataDir: userDir,
        hostId: "test-host",
        workspaceId: "user",
        embedding: null,
      });
      await expect(userStore.putKnowledge({
        scope: "workspace",
        status: "accepted",
        content: "forged",
        trigger: "",
      })).rejects.toMatchObject({ code: "invalid" });
      const id = await userStore.putKnowledge({
        scope: "user",
        status: "accepted",
        content: "mine",
        trigger: "style",
      });
      expect((await userStore.getKnowledge(id))?.scope).toBe("user");
      await userStore.close();
    });

    it("keeps retired knowledge out of recall after reopen", async () => {
      const dir = join(TEST_DIR, "knowledge-reopen");
      mkdirSync(dir, { recursive: true });
      const first = await openWorkspaceKnowledge({
        dataDir: dir,
        hostId: "test-host",
        workspaceId: "ws-reopen",
        embedding: null,
      });
      const id = await first.putKnowledge({
        scope: "workspace",
        status: "accepted",
        content: "Old effective rule",
        trigger: "old rule",
      });
      await first.retireKnowledge(id, "workspace", {
        content: "Old effective rule",
        trigger: "old rule",
        status: "accepted",
      });
      await first.close();
      const second = await openWorkspaceKnowledge({
        dataDir: dir,
        hostId: "test-host",
        workspaceId: "ws-reopen",
        embedding: null,
      });
      expect((await second.getKnowledge(id))?.invalidAt).toEqual(expect.any(Number));
      expect(await second.recall("Old effective rule", 5)).toEqual([]);
      await second.close();
    });
  });

  describe("file and symbol graph", () => {
    const range = { startLine: 0, startCharacter: 0, endLine: 0, endCharacter: 5 };

    it("atomically replaces one file's active symbols and removes stale nodes", async () => {
      const first = await store.replaceFileSymbols("src/a.ts", "typescript", [
        { name: "Alpha", kind: "function", range },
        { name: "Beta", kind: "class", range: { ...range, startLine: 2, endLine: 4 } },
      ], "disk-r1");
      expect(first).toMatchObject({ symbols: 2, edges: 2 });
      expect(await store.searchSymbols("Alpha", 10)).toEqual([
        expect.objectContaining({ name: "Alpha", path: "src/a.ts", score: expect.any(Number), documentRevision: "disk-r1" }),
      ]);
      expect((await store.getDefinedSymbols("src/a.ts")).map((symbol) => symbol.name)).toEqual(["Alpha", "Beta"]);
      expect((await store.getDefinedSymbols("src/a.ts")).map((symbol) => symbol.documentRevision)).toEqual(["disk-r1", "disk-r1"]);

      await store.touchFile("src/a.ts", "typescript");
      expect(await store.searchSymbols("Beta", 10)).toHaveLength(1);
      expect((await store.getFileRelations("src/a.ts"))?.documentRevision).toBe("disk-r1");
      await store.replaceFileSymbols("src/a.ts", "typescript", [
        { name: "Gamma", kind: "variable", range },
      ], "disk-r2");
      expect((await store.searchSymbols("Gamma", 10))[0]?.documentRevision).toBe("disk-r2");
      expect(await store.searchSymbols("Alpha", 10)).toEqual([]);
      expect(await store.searchSymbols("Gamma", 10)).toHaveLength(1);
      expect((await store.getDefinedSymbols("src/a.ts")).map((symbol) => symbol.name)).toEqual(["Gamma"]);

      await expect(store.removeFileSymbols("src/a.ts")).resolves.toEqual({ removedFiles: 1, removedSymbols: 1 });
      expect(await store.searchSymbols("Gamma", 10)).toEqual([]);
    });

    it("rejects malformed ranges before replacing the previous graph", async () => {
      await store.replaceFileSymbols("src/a.ts", "typescript", [{ name: "Stable", kind: "class", range }], "disk-r1");
      await expect(store.replaceFileSymbols("src/a.ts", "typescript", [{
        name: "Broken",
        kind: "class",
        range: { startLine: 2, startCharacter: 0, endLine: 1, endCharacter: 0 },
      }], "disk-r2")).rejects.toMatchObject({ code: "invalid" });
      expect(await store.searchSymbols("Stable", 10)).toHaveLength(1);
    });

    it("requires a document revision so a stored range can be attributed", async () => {
      await expect(store.replaceFileSymbols("src/a.ts", "typescript", [
        { name: "Unattributed", kind: "class", range },
      ], "")).rejects.toMatchObject({ code: "invalid" });
      expect(await store.searchSymbols("Unattributed", 10)).toEqual([]);
    });

    it("keeps confirmed connections distinct from association candidates and binds imports to the revision", async () => {
      await store.replaceFileSymbols("src/router.ts", "typescript", [
        { name: "boot", kind: "function", range },
      ], "disk-r1", [
        { kind: "import", value: "./protocol", line: 1 },
        { kind: "connects", value: "explore.search", callee: "register", line: 4 },
        { kind: "associates", value: "explore.search", callee: "log", line: 5 },
      ]);
      const relations = await store.getFileRelations("src/router.ts");
      expect(relations).toMatchObject({
        path: "src/router.ts",
        documentRevision: "disk-r1",
        danglingEdges: 0,
        imports: [{ specifier: "./protocol", line: 1, documentRevision: "disk-r1" }],
        connections: [{ callee: "register", literal: "explore.search", line: 4, documentRevision: "disk-r1" }],
        associations: [{ callee: "log", literal: "explore.search", line: 5, documentRevision: "disk-r1" }],
      });
      expect(relations?.connections).not.toEqual(relations?.associations);
      expect(await store.findLinks("explore.search")).toEqual([
        expect.objectContaining({ kind: "connects", callee: "register", path: "src/router.ts" }),
        expect.objectContaining({ kind: "associates", callee: "log", path: "src/router.ts" }),
      ]);
    });

    it("drops previous link nodes and leaves no hanging edges after a re-collect", async () => {
      await store.replaceFileSymbols("src/a.ts", "typescript", [
        { name: "Alpha", kind: "function", range },
      ], "disk-r1", [
        { kind: "import", value: "./old", line: 1 },
        { kind: "connects", value: "old.event", callee: "on", line: 2 },
      ]);
      await store.replaceFileSymbols("src/a.ts", "typescript", [
        { name: "Beta", kind: "function", range },
      ], "disk-r2", [
        { kind: "import", value: "./new", line: 1 },
      ]);
      const relations = await store.getFileRelations("src/a.ts");
      expect(relations).toMatchObject({
        documentRevision: "disk-r2",
        danglingEdges: 0,
        imports: [{ specifier: "./new", line: 1, documentRevision: "disk-r2" }],
        connections: [],
        associations: [],
      });
      expect(await store.findLinks("./old")).toEqual([]);
      expect(await store.findLinks("old.event")).toEqual([]);
      expect(await store.searchSymbols("Alpha", 10)).toEqual([]);
    });

    it("reports exact, name-contains, and path-contains match tiers", async () => {
      await store.replaceFileSymbols("src/harness/explore.ts", "typescript", [
        { name: "explore", kind: "function", range },
        { name: "exploreSearch", kind: "function", range: { ...range, startLine: 2, endLine: 2 } },
      ], "disk-r1");
      const exact = await store.searchSymbols("explore", 10);
      expect(exact[0]).toMatchObject({ name: "explore", match: "exact", score: 4 });
      expect(exact.find((entry) => entry.name === "exploreSearch")).toMatchObject({ match: "name-contains", score: 2 });
      const byPath = await store.searchSymbols("harness", 10);
      expect(byPath.every((entry) => entry.match === "path-contains")).toBe(true);
    });

    it("computes scoped symbol Top-K before truncating global candidates", async () => {
      await store.replaceFileSymbols("a-outside.ts", "typescript", [
        { name: "NeedleSymbol", kind: "function", range },
      ], "disk-outside");
      await store.replaceFileSymbols("allowed/z-inside.ts", "typescript", [
        { name: "NeedleSymbol", kind: "function", range },
      ], "disk-inside");

      expect((await store.searchSymbols("NeedleSymbol", 1)).map((entry) => entry.path)).toEqual(["a-outside.ts"]);
      expect((await store.searchSymbols("NeedleSymbol", 1, ["allowed"])).map((entry) => entry.path)).toEqual(["allowed/z-inside.ts"]);
      expect((await store.searchSymbols("NeedleSymbol", 1, ["."])).map((entry) => entry.path)).toEqual(["a-outside.ts"]);
    });

    it("matches case-insensitively through the lowercased n-gram fields", async () => {
      await store.replaceFileSymbols("src/LanguageSupportPage.tsx", "typescriptreact", [
        { name: "LanguageSupportPage", kind: "function", range },
      ], "disk-r1");
      expect((await store.searchSymbols("languagesupport", 10)).map((row) => row.name)).toEqual(["LanguageSupportPage"]);
      expect((await store.searchSymbols("SUPPORTPAGE", 10)).map((row) => row.name)).toEqual(["LanguageSupportPage"]);
    });

    it("matches a term shorter than three characters only as an exact name", async () => {
      await store.replaceFileSymbols("src/db/index.ts", "typescript", [
        { name: "db", kind: "variable", range },
        { name: "dbPath", kind: "variable", range: { ...range, startLine: 2, endLine: 2 } },
      ], "disk-r1");
      // The n-gram index rejects needles under three characters, so `db` can
      // reach `db` exactly, not `dbPath` and not the `src/db/` path (D-141).
      expect((await store.searchSymbols("db", 10)).map((row) => row.name)).toEqual(["db"]);
      expect((await store.searchSymbols("dbp", 10)).map((row) => row.name)).toEqual(["dbPath"]);
    });

    it("answers catalog queries after a reopen without rebuilding anything in memory", async () => {
      const dir = join(TEST_DIR, "graph-reopen-indexes");
      mkdirSync(dir, { recursive: true });
      const open = () => openWorkspaceKnowledge({
        dataDir: dir,
        hostId: "test-host",
        workspaceId: "ws-reopen",
        embedding: null,
      });
      const first = await open();
      await first.replaceFileSymbols("lib/a.ts", "typescript", [
        { name: "alphaThing", kind: "function", range },
      ], "disk-r1", [
        { kind: "connects", value: "wire.one", line: 3, callee: "register" },
      ]);
      await first.replaceFileSymbols("lib/b.ts", "javascript", [
        { name: "betaThing", kind: "function", range },
      ], "disk-r1", [
        { kind: "import", value: "./a.js", line: 1 },
        { kind: "connects", value: "wire.one", line: 5, callee: "request" },
      ]);
      await first.close();

      const second = await open();
      expect(await second.catalogStats()).toEqual({
        symbolCount: 2,
        fileCount: 2,
        linkCount: 3,
        languages: ["javascript", "typescript"],
        paths: ["lib/a.ts", "lib/b.ts"],
      });
      expect((await second.searchSymbols("thing", 10)).map((row) => row.name).toSorted()).toEqual(["alphaThing", "betaThing"]);
      expect((await second.findLinks("wire.one")).map((row) => row.path)).toEqual(["lib/a.ts", "lib/b.ts"]);
      expect(await second.connectionLiterals(["wire.one", "wire.none"])).toEqual(new Set(["wire.one"]));
      expect((await second.findImporters("lib/a.ts")).resolved).toEqual([{ path: "lib/b.ts", specifier: "./a.js" }]);
      await second.close();
    });

    it("keeps counts and shape current across replace, touch and remove", async () => {
      await store.replaceFileSymbols("lib/x.ts", "typescript", [
        { name: "one", kind: "function", range },
        { name: "two", kind: "function", range: { ...range, startLine: 2, endLine: 2 } },
      ], "disk-r1", [{ kind: "import", value: "./y.js", line: 1 }]);
      expect(await store.catalogStats()).toMatchObject({ symbolCount: 2, fileCount: 1, linkCount: 1 });

      // Same path, fewer symbols: the counter must follow the replacement.
      await store.replaceFileSymbols("lib/x.ts", "typescript", [
        { name: "one", kind: "function", range },
      ], "disk-r2");
      expect(await store.catalogStats()).toMatchObject({ symbolCount: 1, fileCount: 1, linkCount: 0 });

      await store.touchFile("lib/y.ts", "typescript");
      expect(await store.catalogStats()).toMatchObject({ fileCount: 2, paths: ["lib/x.ts", "lib/y.ts"] });

      await store.removeFileSymbols("lib/x.ts");
      expect(await store.catalogStats()).toMatchObject({ symbolCount: 0, fileCount: 1, linkCount: 0, paths: ["lib/y.ts"] });
    });

    it("resolves reverse imports at query time and leaves non-relative specifiers unresolved", async () => {
      await store.replaceFileSymbols("lib/harness/explore.ts", "typescript", [
        { name: "explore", kind: "function", range },
      ], "disk-r1");
      await store.replaceFileSymbols("lib/harness/explore-service.ts", "typescript", [
        { name: "createExploreSearchService", kind: "function", range },
      ], "disk-r1", [
        { kind: "import", value: "./explore.js", line: 1 },
        { kind: "import", value: "@piarium/protocol", line: 2 },
      ]);
      await store.replaceFileSymbols("lib/other.ts", "typescript", [
        { name: "other", kind: "function", range },
      ], "disk-r1", [
        { kind: "import", value: "../missing", line: 1 },
      ]);
      expect(await store.findImporters("lib/harness/explore.ts")).toEqual({
        path: "lib/harness/explore.ts",
        resolved: [{ path: "lib/harness/explore-service.ts", specifier: "./explore.js" }],
      });
      expect(await store.findImporters("lib/missing.ts")).toEqual({
        path: "lib/missing.ts",
        resolved: [],
      });
      const stats = await store.catalogStats();
      expect(stats.symbolCount).toBe(3);
      expect(stats.fileCount).toBe(3);
      expect(stats.paths).toEqual([
        "lib/harness/explore-service.ts",
        "lib/harness/explore.ts",
        "lib/other.ts",
      ]);
      expect(stats.languages).toEqual(["typescript"]);
    });

    it("re-resolves reverse imports when the known path set changes", async () => {
      await store.replaceFileSymbols("lib/app.ts", "typescript", [
        { name: "app", kind: "function", range },
      ], "disk-r1", [
        { kind: "import", value: "./core.js", line: 1 },
      ]);
      // The target is not in the catalog yet, so the specifier cannot resolve.
      expect((await store.findImporters("lib/core.ts")).resolved).toEqual([]);
      await store.touchFile("lib/core.ts", "typescript");
      expect((await store.findImporters("lib/core.ts")).resolved).toEqual([
        { path: "lib/app.ts", specifier: "./core.js" },
      ]);
      await store.removeFileSymbols("lib/app.ts");
      expect((await store.findImporters("lib/core.ts")).resolved).toEqual([]);
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

    it("does not return user-scope rows from a workspace store", async () => {
      await store.putKnowledge({
        scope: "user",
        status: "accepted",
        content: "private user note about testing",
        trigger: "testing",
      });
      const results = await store.recall("testing", 5);
      expect(results).toEqual([]);
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

  /**
   * Graph writes flush on a trailing debounce because a per-file flush made a
   * catalog build quadratic (D-140). The contract that matters is that nothing
   * is lost: a burst is readable at once and survives a close.
   */
  describe("derived graph flush", () => {
    const range = { startLine: 0, startCharacter: 0, endLine: 0, endCharacter: 9 };

    it("keeps a burst of graph writes readable before any flush settles", async () => {
      await Promise.all(Array.from({ length: 12 }, (_unused, index) => (
        store.replaceFileSymbols(
          `src/burst-${index}.ts`,
          "typescript",
          [{ name: `burst${index}`, kind: "function", range }],
          `rev-${index}`,
        )
      )));

      expect(await store.searchSymbols("burst7", 5)).toHaveLength(1);
      expect((await store.catalogStats()).fileCount).toBe(12);
    });

    it("persists a deferred graph write across close and reopen", async () => {
      const dir = join(TEST_DIR, "graph-durability");
      mkdirSync(dir, { recursive: true });
      const open = () => openWorkspaceKnowledge({
        dataDir: dir,
        hostId: "test-host",
        workspaceId: "ws-durability",
        embedding: null,
      });

      const first = await open();
      await first.replaceFileSymbols(
        "src/deferred.ts",
        "typescript",
        [{ name: "deferred", kind: "function", range }],
        "rev-1",
      );
      // No wait for the debounce: closing has to settle it.
      await first.close();

      const second = await open();
      expect((await second.searchSymbols("deferred", 5)).map((row) => row.path)).toEqual(["src/deferred.ts"]);
      await second.close();
    });

    it("does not defer a knowledge write behind a graph burst", async () => {
      const range0 = { startLine: 0, startCharacter: 0, endLine: 0, endCharacter: 4 };
      const writes = Array.from({ length: 8 }, (_unused, index) => (
        store.replaceFileSymbols(`src/mixed-${index}.ts`, "typescript", [{ name: `mixed${index}`, kind: "function", range: range0 }], `rev-${index}`)
      ));
      const knowledge = store.putKnowledge({
        scope: "workspace",
        status: "accepted",
        content: "user data is not derived",
        trigger: "always",
      });
      await Promise.all([...writes, knowledge]);

      // User-data call sites still flush inside their own write; only the graph
      // ones debounce. That timing is by construction, so what is asserted here
      // is that mixing the two loses neither.
      expect((await store.listKnowledge({ scope: "workspace" })).map((item) => item.content))
        .toContain("user data is not derived");
      expect((await store.catalogStats()).fileCount).toBe(8);
    });
  });
});
