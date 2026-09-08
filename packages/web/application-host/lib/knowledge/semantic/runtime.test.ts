import { afterEach, describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createDocumentAuthorityHarness } from "../../documents/contract-fixtures.js";
import { createStructureSource } from "../../structure/source.js";
import { createTreeSitterStructureProvider } from "../../structure/tree-sitter-provider.js";
import { createHashEmbedder } from "./embedder.js";
import { workspaceScope } from "./identity.js";
import { createSemanticIndexRuntime } from "./runtime.js";

const disposes: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposes.splice(0).reverse()) await dispose();
});

const parsingSource = () => createStructureSource([
  createTreeSitterStructureProvider({ parseBudgetMs: 30_000 }),
]);

describe("semantic index runtime", () => {
  it("indexes a workspace on disk and stays unavailable when the model pack is missing", async () => {
    const documents = await createDocumentAuthorityHarness();
    disposes.push(() => documents.cleanup());
    writeFileSync(join(documents.workspaceRoot, "ready.ts"), [
      "export function publishedZebra() {",
      "  return \"published zebra token\";",
      "}",
    ].join("\n"), "utf8");

    const ready = createHashEmbedder();
    const runtime = createSemanticIndexRuntime({
      dataDir: documents.dataDir,
      hostId: "semantic-host",
      documents: documents.authority,
      structureSource: parsingSource(),
      searchFilesystemFiles: async () => [{
        name: "ready.ts",
        path: join(documents.workspaceRoot, "ready.ts"),
        relativePath: "ready.ts",
      }],
      embedder: ready,
    });
    disposes.push(() => runtime.dispose());
    await runtime.scanScope(workspaceScope(documents.identity.workspaceId));
    const found = await runtime.search(workspaceScope(documents.identity.workspaceId), "published zebra token", 8);
    expect(found.status.coverage).toBe("complete");
    expect(found.status.lifecycle).toBe("ready");
    expect(found.hits[0]?.documentId).toBe("ready.ts");

    const missing = createHashEmbedder();
    missing.status = "unavailable";
    const dark = createSemanticIndexRuntime({
      dataDir: documents.dataDir,
      hostId: "semantic-host-dark",
      documents: documents.authority,
      structureSource: parsingSource(),
      searchFilesystemFiles: async () => [{
        name: "ready.ts",
        path: join(documents.workspaceRoot, "ready.ts"),
        relativePath: "ready.ts",
      }],
      embedder: missing,
    });
    disposes.push(() => dark.dispose());
    await dark.scanScope(workspaceScope(documents.identity.workspaceId));
    const status = dark.statusFor(workspaceScope(documents.identity.workspaceId));
    expect(status.status).toBe("unavailable");
    expect((await dark.search(workspaceScope(documents.identity.workspaceId), "published zebra token", 8)).hits).toEqual([]);
  });

  it("increments from Documents revisions and can sit at partial coverage", async () => {
    const documents = await createDocumentAuthorityHarness();
    disposes.push(() => documents.cleanup());
    writeFileSync(join(documents.workspaceRoot, "one.ts"), "export function one() { return \"alpha unique\"; }\n", "utf8");
    writeFileSync(join(documents.workspaceRoot, "two.ts"), "export function two() { return \"beta unique\"; }\n", "utf8");
    const embedder = createHashEmbedder();
    const runtime = createSemanticIndexRuntime({
      dataDir: documents.dataDir,
      hostId: "semantic-host",
      documents: documents.authority,
      structureSource: parsingSource(),
      searchFilesystemFiles: async () => [{
        name: "one.ts",
        path: join(documents.workspaceRoot, "one.ts"),
        relativePath: "one.ts",
      }],
      embedder,
    });
    disposes.push(() => runtime.dispose());
    await runtime.scanScope(workspaceScope(documents.identity.workspaceId));
    expect((await runtime.search(workspaceScope(documents.identity.workspaceId), "alpha unique", 8)).hits[0]?.documentId).toBe("one.ts");
    expect((await runtime.search(workspaceScope(documents.identity.workspaceId), "beta unique", 8)).hits.some((hit) => hit.documentId === "two.ts")).toBe(false);

    runtime.observeDocumentMutation({
      workspaceId: documents.identity.workspaceId,
      resourceId: "one.ts",
      kind: "modified",
      owner: { kind: "web-route", id: "editor" },
    });
    await runtime.drain();
    writeFileSync(join(documents.workspaceRoot, "one.ts"), "export function one() { return \"alpha unique changed\"; }\n", "utf8");
    runtime.observeDocumentMutation({
      workspaceId: documents.identity.workspaceId,
      resourceId: "one.ts",
      kind: "modified",
      owner: { kind: "web-route", id: "editor" },
    });
    await runtime.drain();
    const again = await runtime.search(workspaceScope(documents.identity.workspaceId), "alpha unique changed", 8);
    expect(again.hits[0]?.documentId).toBe("one.ts");
  });
});
