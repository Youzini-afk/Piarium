import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createLanguageSupportRuntime, LANGUAGE_DISTRIBUTION_FILE_LIMIT } from "./runtime.js";
import { createGrammarStore, grammarIntegrityOf } from "../structure/grammar-store.js";
import type { FileSearchItem } from "../fs/types.js";

const file = (relativePath: string): FileSearchItem => ({
  name: relativePath.split("/").at(-1) ?? relativePath,
  path: `/ws/${relativePath}`,
  relativePath,
});

describe("createLanguageSupportRuntime", () => {
  it("buckets workspace files on demand and marks the scan partial at the file cap", async () => {
    let searches = 0;
    const runtime = createLanguageSupportRuntime({
      fileLimit: 3,
      cacheTtlMs: 60_000,
      inspectWorkspace: async () => ({ root: "/ws" }),
      searchFilesystemFiles: async (_root, options) => {
        searches += 1;
        expect(options.limit).toBe(4);
        return [
          file("a.ts"),
          file("b.ts"),
          file("c.js"),
          file("d.py"),
          file("notes.md"),
        ];
      },
    });
    const status = await runtime.getStatus({ workspaceId: "ws-1" });
    expect(status).toMatchObject({
      workspaceId: "ws-1",
      partial: true,
      scannedFiles: 3,
      fileLimit: 3,
    });
    expect(status.languages.map((row) => row.languageId)).toEqual(["typescript", "javascript"]);
    expect(status.languages[0]).toMatchObject({
      languageId: "typescript",
      grammarStatus: "bundled",
      fileCount: 2,
      wanted: false,
      capabilities: { outline: true, classifyHits: true, literalCalls: true, imports: true },
    });
    expect(status.languages[1]).toMatchObject({
      languageId: "javascript",
      grammarStatus: "bundled",
      fileCount: 1,
    });
    await runtime.getStatus({ workspaceId: "ws-1" });
    expect(searches).toBe(1);
  });

  it("records wanted only for installable languages that are not present, and still leaves structure unsupported", async () => {
    const runtime = createLanguageSupportRuntime({
      installableLanguageIds: () => ["python"],
      inspectWorkspace: async () => ({ root: "/ws" }),
      searchFilesystemFiles: async () => [file("app.py"), file("main.ts")],
    });
    runtime.noteRequest("python", "ws-1");
    runtime.noteRequest("typescript", "ws-1");
    runtime.noteRequest("python");
    expect(runtime.peekWanted("ws-1")).toEqual(["python"]);
    const status = await runtime.getStatus({ workspaceId: "ws-1" });
    expect(status.languages[0]).toMatchObject({
      languageId: "python",
      grammarStatus: "available",
      wanted: true,
      fileCount: 1,
      capabilities: { outline: false, classifyHits: false, literalCalls: false, imports: false },
    });
    expect(status.languages[1]).toMatchObject({
      languageId: "typescript",
      grammarStatus: "bundled",
      wanted: false,
      fileCount: 1,
    });
  });

  it("does not enumerate files until getStatus is called", async () => {
    let searches = 0;
    createLanguageSupportRuntime({
      inspectWorkspace: async () => ({ root: "/ws" }),
      searchFilesystemFiles: async () => {
        searches += 1;
        return [];
      },
    });
    expect(searches).toBe(0);
    expect(LANGUAGE_DISTRIBUTION_FILE_LIMIT).toBe(8_000);
  });

  it("reports install as unsupported until a download pipeline is wired", async () => {
    const runtime = createLanguageSupportRuntime({
      inspectWorkspace: async () => ({ root: "/ws" }),
      searchFilesystemFiles: async () => [],
    });
    await expect(runtime.install({ languageId: "python" })).resolves.toMatchObject({
      status: "failed",
      reason: "unsupported",
    });
  });

  it("delegates install to the injected installer and attaches pack metadata", async () => {
    const runtime = createLanguageSupportRuntime({
      inspectWorkspace: async () => ({ root: "/ws" }),
      searchFilesystemFiles: async () => [file("app.py")],
      manifest: {
        generatedAt: "2026-09-07",
        minCompatibleAbi: 13,
        maxCompatibleAbi: 15,
        packs: {
          python: {
            languageId: "python",
            packageName: "tree-sitter-python",
            version: "0.25.0",
            tarballUrl: "https://example.test/python.tgz",
            wasmPath: "package/tree-sitter-python.wasm",
            grammarFile: "tree-sitter-python.wasm",
            integrity: "sha256-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            bytes: 12,
            abi: 15,
            licensePath: null,
            tagsPath: "package/queries/tags.scm",
            tagsIntegrity: "sha256-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          },
        },
        skipped: {},
      },
      installer: {
        install: async ({ languageId }) => ({ status: "ready", languageId, grammarStatus: "installed" }),
        cancelInstall: async ({ languageId }) => ({ status: "cancelled", languageId }),
        importUserGrammar: async ({ languageId }) => ({ status: "ready", languageId, grammarStatus: "user-unverified" }),
      },
    });
    const status = await runtime.getStatus({ workspaceId: "ws-1" });
    expect(status.grammarStore).toBe("ready");
    expect(status.languages[0]).toMatchObject({
      languageId: "python",
      grammarStatus: "available",
      pack: { abi: 15, packageName: "tree-sitter-python", version: "0.25.0", providesOutline: true },
    });
    await expect(runtime.install({ languageId: "python" })).resolves.toMatchObject({
      status: "ready",
      grammarStatus: "installed",
    });
  });

  it("wires an installed grammar that shipped a query and reports the rest as installed-only", async () => {
    const store = createGrammarStore(mkdtempSync(join(tmpdir(), "piarium-language-support-")));
    const wasm = new Uint8Array([1, 2, 3]);
    const tags = new TextEncoder().encode("(class_declaration) @definition.class");
    store.put(
      "python",
      wasm,
      { integrity: grammarIntegrityOf(wasm), source: "manifest", grammarFile: "tree-sitter-python.wasm" },
      { bytes: tags, integrity: grammarIntegrityOf(tags) },
    );
    store.put("go", wasm, { integrity: grammarIntegrityOf(wasm), source: "manifest", grammarFile: "tree-sitter-go.wasm" });
    const runtime = createLanguageSupportRuntime({
      store,
      inspectWorkspace: async () => ({ root: "/ws" }),
      searchFilesystemFiles: async () => [file("app.py"), file("main.go")],
    });

    expect(runtime.installedStructureSpec("python")).toMatchObject({ grammarFile: "tree-sitter-python.wasm" });
    // A grammar with no query cannot outline, so it is not wired at all.
    expect(runtime.installedStructureSpec("go")).toBeNull();
    expect(runtime.installedStructureSpec("typescript")).toBeNull();

    const status = await runtime.getStatus({ workspaceId: "ws-1" });
    const byLanguage = new Map(status.languages.map((row) => [row.languageId, row]));
    expect(byLanguage.get("python")).toMatchObject({
      grammarStatus: "installed",
      capabilities: { outline: true, classifyHits: true, literalCalls: false, imports: false },
    });
    expect(byLanguage.get("go")).toMatchObject({
      grammarStatus: "installed",
      capabilities: { outline: false, classifyHits: false, literalCalls: false, imports: false },
    });
  });

  it("reports an unreadable index as unknown instead of nothing installed", async () => {
    const store = createGrammarStore(mkdtempSync(join(tmpdir(), "piarium-language-support-")));
    const wasm = new Uint8Array([4, 5, 6]);
    store.put("python", wasm, {
      integrity: grammarIntegrityOf(wasm),
      source: "manifest",
      grammarFile: "tree-sitter-python.wasm",
    });
    writeFileSync(join(store.root, "index.json"), "{ broken", "utf8");
    const runtime = createLanguageSupportRuntime({
      store,
      inspectWorkspace: async () => ({ root: "/ws" }),
      searchFilesystemFiles: async () => [file("app.py"), file("main.ts")],
    });

    const status = await runtime.getStatus({ workspaceId: "ws-1" });
    expect(status.grammarStore).toBe("unreadable");
    const byLanguage = new Map(status.languages.map((row) => [row.languageId, row]));
    expect(byLanguage.get("python")?.grammarStatus).toBe("unknown");
    // The bundled table is still authoritative on its own.
    expect(byLanguage.get("typescript")?.grammarStatus).toBe("bundled");
    // Demand tracking must not turn a broken index into a structure failure.
    expect(() => runtime.noteRequest("python", "ws-1")).not.toThrow();
  });
});
