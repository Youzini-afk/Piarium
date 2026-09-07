import { describe, expect, it } from "vitest";
import { loadCommittedGrammarPackManifest } from "./grammar-manifest.js";

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
});
