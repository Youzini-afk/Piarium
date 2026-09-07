import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createGrammarStore, grammarIntegrityOf } from "./grammar-store.js";

describe("createGrammarStore", () => {
  it("stores wasm by sha256 and removes unused blobs", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "piarium-grammar-store-"));
    const store = createGrammarStore(dataDir, () => "2026-09-07T00:00:00.000Z");
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const integrity = grammarIntegrityOf(bytes);
    store.put("python", bytes, { integrity, source: "manifest", grammarFile: "tree-sitter-python.wasm" });
    expect(store.get("python")).toMatchObject({ integrity, source: "manifest" });
    expect(existsSync(store.pathForIntegrity(integrity))).toBe(true);
    expect(store.pathForGrammarFile("tree-sitter-python.wasm")).toBe(store.pathForIntegrity(integrity));
    expect(JSON.parse(readFileSync(join(store.root, "index.json"), "utf8")).schemaVersion).toBe(1);
    store.remove("python");
    expect(store.has("python")).toBe(false);
    expect(existsSync(store.pathForIntegrity(integrity))).toBe(false);
  });
});
