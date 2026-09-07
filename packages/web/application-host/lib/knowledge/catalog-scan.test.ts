import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, promises as fsPromises } from "node:fs";
import path, { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDocumentAuthorityHarness } from "../documents/contract-fixtures.js";
import { createFsSearchRuntime } from "../fs/search.js";
import { createStructureSource } from "../structure/source.js";
import { createTreeSitterStructureProvider } from "../structure/tree-sitter-provider.js";
import { openWorkspaceKnowledge, type KnowledgeStore } from "./store.js";
import { createSymbolGraphRuntime } from "./symbol-runtime.js";

const disposes: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposes.splice(0).reverse()) await dispose();
});

const parsingSource = () => createStructureSource([
  createTreeSitterStructureProvider({ parseBudgetMs: 30_000 }),
]);

describe("cold workspace catalog scan", () => {
  it("indexes unmodified TS files from disk and skips dirty buffers and non-TS paths", async () => {
    const documents = await createDocumentAuthorityHarness();
    disposes.push(() => documents.cleanup());
    const store: KnowledgeStore = await openWorkspaceKnowledge({
      dataDir: documents.dataDir,
      hostId: "catalog-host",
      workspaceId: documents.identity.workspaceId,
      embedding: null,
    });
    disposes.push(async () => { await store.close(); });
    writeFileSync(join(documents.workspaceRoot, "cold.ts"), [
      "import { join } from \"node:path\";",
      "export function coldSymbol() {",
      "  return join(\"a\");",
      "}",
      "export function boot() {",
      "  router.register(\"explore.search\");",
      "  console.log(\"explore.search\");",
      "}",
    ].join("\n"), "utf8");
    writeFileSync(join(documents.workspaceRoot, "notes.md"), "# not a catalog language\n", "utf8");
    mkdirSync(join(documents.workspaceRoot, "src"), { recursive: true });
    writeFileSync(join(documents.workspaceRoot, "src", "skip.js"), "export const jsOnly = 1;\n", "utf8");

    const disk = await documents.authority.read(documents.resource("cold.ts"));
    expect(disk.status).toBe("ready");
    if (disk.status !== "ready") throw new Error("expected disk text");

    await documents.authority.publishDirtyBuffers({
      generation: 1,
      ownerId: "surface",
      resources: [{
        baseRevision: disk.revision,
        localEditRevision: 1,
        resource: documents.resource("cold.ts"),
      }],
      workspaceId: documents.identity.workspaceId,
    });
    await documents.authority.captureAgentInputSnapshot({
      generation: 1,
      ownerId: "surface",
      resources: [{
        baseRevision: disk.revision,
        content: "export function dirtySymbol() { return 1; }\n",
        localEditRevision: 1,
        resource: documents.resource("cold.ts"),
      }],
      sessionId: "catalog-session",
      workspaceId: documents.identity.workspaceId,
    });

    const readAgentInputSnapshot = vi.spyOn(documents.authority, "readAgentInputSnapshot");
    const search = createFsSearchRuntime({
      fsPromises,
      path,
      spawn,
      resolveGitBinaryForSpawn: () => "git",
    });
    const runtime = createSymbolGraphRuntime({
      getStore: async () => store,
      documents: documents.authority,
      supervisor: {
        syncDocument: async () => ({ status: "synced", documentVersion: 1 }),
        documentSymbols: async () => ({ status: "failed", message: "catalog scan must not start a language server" }),
      } as never,
      structureSource: parsingSource(),
      searchFilesystemFiles: search.searchFilesystemFiles,
    });
    disposes.push(() => runtime.dispose());

    await runtime.scanWorkspace(documents.identity.workspaceId);
    expect(readAgentInputSnapshot).not.toHaveBeenCalled();
    expect((await store.searchSymbols("coldSymbol", 5)).map((entry) => entry.name)).toEqual(["coldSymbol"]);
    expect((await store.searchSymbols("dirtySymbol", 5))).toEqual([]);
    expect((await store.searchSymbols("jsOnly", 5))).toEqual([]);
    const relations = await store.getFileRelations("cold.ts");
    expect(relations).toMatchObject({
      documentRevision: disk.revision,
      danglingEdges: 0,
      imports: [expect.objectContaining({ specifier: "node:path" })],
      connections: [expect.objectContaining({ callee: "register", literal: "explore.search" })],
      associations: expect.arrayContaining([
        expect.objectContaining({ callee: "log", literal: "explore.search" }),
      ]),
    });
    expect(await store.getFileRelations("notes.md")).toBeNull();
    expect(await store.getFileRelations("src/skip.js")).toBeNull();
  });
});
