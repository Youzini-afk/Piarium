import { describe, expect, it } from "vitest";
import { loadCommittedGrammarPackManifest, parseGrammarPackManifest } from "./grammar-manifest.js";

const entry = (overrides: Record<string, unknown> = {}) => ({
  languageId: "python",
  packageName: "tree-sitter-python",
  version: "0.25.0",
  tarballUrl: "https://example.test/p.tgz",
  wasmPath: "package/tree-sitter-python.wasm",
  grammarFile: "tree-sitter-python.wasm",
  integrity: `sha256-${"a".repeat(64)}`,
  bytes: 10,
  abi: 15,
  licensePath: "package/LICENSE",
  ...overrides,
});

describe("loadCommittedGrammarPackManifest", () => {
  it("loads the publish-time digest list with ABI bounds", () => {
    const manifest = loadCommittedGrammarPackManifest();
    expect(manifest.minCompatibleAbi).toBe(13);
    expect(manifest.maxCompatibleAbi).toBe(15);
    expect(manifest.packs.python?.integrity).toMatch(/^sha256-[0-9a-f]{64}$/);
    expect(manifest.skipped.swift).toContain("no .wasm");
    expect(manifest.skipped.markdown).toContain("no .wasm");
    expect(manifest.skipped.xml).toContain("no .wasm");
    expect(Object.keys(manifest.packs).sort()).toEqual([
      "c",
      "cpp",
      "csharp",
      "css",
      "go",
      "html",
      "java",
      "kotlin",
      "php",
      "python",
      "ruby",
      "rust",
      "shellscript",
      "toml",
      "yaml",
    ]);
  });

  it("records which packs carry a verified structure query", () => {
    const manifest = loadCommittedGrammarPackManifest();
    const withOutline = Object.entries(manifest.packs)
      .filter(([, pack]) => pack.tagsPath !== null)
      .map(([languageId]) => languageId)
      .sort();
    expect(withOutline).toEqual(["c", "cpp", "csharp", "go", "java", "php", "python", "ruby", "rust"]);
    expect(manifest.packs.python?.tagsIntegrity).toMatch(/^sha256-[0-9a-f]{64}$/);
    // A pack without a query still installs a parser, so it stays listed.
    expect(manifest.packs.toml?.tagsPath).toBeNull();
  });

  it("does not offer a pack whose ABI is outside the window the manifest declares", () => {
    const manifest = parseGrammarPackManifest({
      generatedAt: "2026-09-07",
      minCompatibleAbi: 13,
      maxCompatibleAbi: 15,
      packs: { python: entry(), go: entry({ languageId: "go", abi: 17 }) },
      skipped: {},
    });
    expect(Object.keys(manifest.packs)).toEqual(["python"]);
    expect(manifest.skipped.go).toContain("outside the manifest window");
  });

  it("drops a query it cannot verify instead of installing one on trust", () => {
    const manifest = parseGrammarPackManifest({
      generatedAt: "2026-09-07",
      minCompatibleAbi: 13,
      maxCompatibleAbi: 15,
      packs: { python: entry({ tagsPath: "package/queries/tags.scm", tagsIntegrity: "not-a-digest" }) },
      skipped: {},
    });
    expect(manifest.packs.python?.tagsPath).toBeNull();
    expect(manifest.packs.python?.tagsIntegrity).toBeNull();
  });
});
