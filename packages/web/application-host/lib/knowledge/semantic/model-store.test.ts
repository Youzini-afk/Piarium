import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { remapAsarUnpackedPath } from "../../structure/runtime-path.js";
import {
  SEMANTIC_MODEL_ID,
  bundledModelPackDir,
  createSemanticModelStore,
  resetInstalledModelPackMemo,
  resolveInstalledModelPack,
  SemanticModelStoreUnreadableError,
} from "./model-store.js";

const dirs: string[] = [];
afterEach(() => {
  resetInstalledModelPackMemo();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("semantic model store", () => {
  it("stages a pack by integrity and does not treat a torn index as empty", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "piarium-semantic-model-"));
    dirs.push(dataDir);
    const store = createSemanticModelStore(dataDir, () => "2026-09-08T00:00:00.000Z");
    const files = { "tokenizer.json": new TextEncoder().encode("{\"version\":\"1.0\"}"), "recipe.json": new TextEncoder().encode("{}") };
    const listing = Object.keys(files).sort().map((name) => (
      `${name}:sha256-${createHash("sha256").update(files[name as keyof typeof files]!).digest("hex")}`
    )).join("\n");
    const integrity = `sha256-${createHash("sha256").update(listing).digest("hex")}`;
    store.put(SEMANTIC_MODEL_ID, files, {
      integrity,
      source: "manifest",
      recipe: {
        schemaVersion: 1,
        provider: "local",
        model: "all-MiniLM-L6-v2",
        modelRevision: "xenova-quantized-1",
        dim: 384,
        pooling: "mean",
        normalize: true,
        maxTokens: 512,
        onnxFile: "model_quantized.onnx",
        tokenizerFile: "tokenizer.json",
      },
    });
    expect(store.has(SEMANTIC_MODEL_ID)).toBe(true);
    writeFileSync(join(store.root, "index.json"), "{not-json", "utf8");
    expect(() => store.get(SEMANTIC_MODEL_ID)).toThrow(SemanticModelStoreUnreadableError);
  });

  it("resolves a bundled recipe through the same asar remap as grammar wasm", () => {
    const logical = "C:\\Piarium\\resources\\app.asar\\server\\lib\\knowledge\\semantic\\runtime\\all-minilm-l6-v2\\recipe.json";
    const unpacked = "C:\\Piarium\\resources\\app.asar.unpacked\\server\\lib\\knowledge\\semantic\\runtime\\all-minilm-l6-v2\\recipe.json";
    expect(remapAsarUnpackedPath(logical, (candidate) => candidate === unpacked)).toBe(unpacked);
    expect(bundledModelPackDir(import.meta.url).replace(/\\/g, "/")).toContain("runtime/all-minilm-l6-v2");
    resetInstalledModelPackMemo();
    const dataDir = mkdtempSync(join(tmpdir(), "piarium-semantic-resolve-"));
    dirs.push(dataDir);
    const pack = resolveInstalledModelPack(dataDir);
    expect(pack === null || pack.recipe.maxTokens === 512).toBe(true);
  });
});
