import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openWorkspaceKnowledge, type KnowledgeStore } from "../knowledge/store.js";
import { executeRelated } from "./related-tool.js";

const TEST_DIR = join(tmpdir(), "piarium-related-tool");
const range = { startLine: 0, startCharacter: 0, endLine: 0, endCharacter: 5 };

let store: KnowledgeStore;

describe("related tool", () => {
  beforeEach(async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    store = await openWorkspaceKnowledge({
      dataDir: TEST_DIR,
      hostId: "related-host",
      workspaceId: "ws",
      embedding: null,
    });
  });

  afterEach(async () => {
    await store.close();
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("reports none versus incomplete for imports, importers, and connections", async () => {
    await store.replaceFileSymbols("lib/core.ts", "typescript", [
      { name: "core", kind: "function", range },
    ], "disk-r1");
    const none = await executeRelated({ anchor: "lib/core.ts" }, store);
    expect(none.status).toBe("ready");
    expect(none.imports.items).toEqual([]);
    expect(none.imports.unresolved).toEqual([]);
    expect(none.imports.incomplete).toBe(false);
    expect(none.text).toContain("Imports: none");
    expect(none.text).toContain("Imported by: none");
    expect(none.text).toContain("Connections: none");

    await store.replaceFileSymbols("lib/core.ts", "typescript", [
      { name: "core", kind: "function", range },
    ], "disk-r2", [
      { kind: "import", value: "@piarium/protocol", line: 1 },
    ], { linksIncomplete: true });
    const incomplete = await executeRelated({ anchor: "lib/core.ts" }, store);
    expect(incomplete.imports.incomplete).toBe(true);
    expect(incomplete.imports.unresolved).toEqual([
      { specifier: "@piarium/protocol", path: "lib/core.ts", reason: "non-relative" },
    ]);
    expect(incomplete.text).toContain("[unresolved: non-relative]");
    expect(incomplete.text).toContain("incomplete");
  });

  it("resolves reverse imports and connection other ends for a path", async () => {
    await store.replaceFileSymbols("lib/harness/explore.ts", "typescript", [
      { name: "explore", kind: "function", range },
    ], "disk-r1", [
      { kind: "connects", value: "explore.search", callee: "register", line: 4 },
    ]);
    await store.replaceFileSymbols("lib/harness/explore-service.ts", "typescript", [
      { name: "createExploreSearchService", kind: "function", range },
    ], "disk-r1", [
      { kind: "import", value: "./explore.js", line: 1 },
      { kind: "connects", value: "explore.search", callee: "request", line: 8 },
    ]);
    const byPath = await executeRelated({ anchor: "lib/harness/explore.ts" }, store);
    expect(byPath.definitions).toEqual([
      expect.objectContaining({ name: "explore", path: "lib/harness/explore.ts" }),
    ]);
    expect(byPath.importers.items).toEqual([
      { path: "lib/harness/explore-service.ts", specifier: "./explore.js" },
    ]);
    expect(byPath.connections.items[0]?.otherEnds).toEqual([
      expect.objectContaining({ path: "lib/harness/explore-service.ts", callee: "request" }),
    ]);
    const byName = await executeRelated({ anchor: "explore" }, store);
    expect(byName.anchor.kind).toBe("name");
    expect(byName.definitions[0]?.name).toBe("explore");
    expect(byName.text).toContain("lsp.references");
    expect(byName.text).not.toContain("rank ");
  });

  it("caps each text section and says how much it left out", async () => {
    const many = Array.from({ length: 120 }, (_, index) => ({
      name: `sym${index}`,
      kind: "function",
      range,
    }));
    await store.replaceFileSymbols("lib/hub.ts", "typescript", many, "disk-r1");
    for (let index = 0; index < 60; index += 1) {
      await store.replaceFileSymbols(`lib/consumer-${index}.ts`, "typescript", [
        { name: `consumer${index}`, kind: "function", range },
      ], "disk-r1", [{ kind: "import", value: "./hub.js", line: 1 }]);
    }
    const result = await executeRelated({ anchor: "lib/hub.ts" }, store);
    expect(result.definitions).toHaveLength(120);
    expect(result.importers.items).toHaveLength(60);
    expect(result.text).toContain("… 80 more (full list in details)");
    expect(result.text).toContain("… 20 more (full list in details)");
    expect(Buffer.byteLength(result.text, "utf8")).toBeLessThan(24 * 1024);
  });

  it("walks a bounded number of paths when a name matches many files", async () => {
    for (let index = 0; index < 12; index += 1) {
      await store.replaceFileSymbols(`lib/dup-${index}.ts`, "typescript", [
        { name: "shared", kind: "function", range },
      ], "disk-r1");
    }
    const result = await executeRelated({ anchor: "shared" }, store);
    expect(result.anchor.kind).toBe("name");
    expect(result.definitions).toHaveLength(8);
    expect(result.text).toContain("matched 4 more file(s) than were walked");
  });

  it("distinguishes an empty catalog from a miss", async () => {
    const empty = await executeRelated({ anchor: "explore" }, store);
    expect(empty.status).toBe("empty");
    expect(empty.text).toContain("Catalog languages are TypeScript and JavaScript");
    await store.replaceFileSymbols("lib/a.ts", "typescript", [
      { name: "alpha", kind: "function", range },
    ], "disk-r1");
    const miss = await executeRelated({ anchor: "nope" }, store);
    expect(miss.status).toBe("empty");
    expect(miss.text).toContain("nothing in the catalog matched");
  });
});
