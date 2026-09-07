import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createGrammarInstaller } from "./grammar-installer.js";
import { parseGrammarPackManifest } from "./grammar-manifest.js";
import { createGrammarStore, grammarIntegrityOf } from "./grammar-store.js";

const wasm = new Uint8Array([0, 1, 2, 3, 4, 5]);
const integrity = grammarIntegrityOf(wasm);

const manifest = parseGrammarPackManifest({
  generatedAt: "2026-09-07",
  minCompatibleAbi: 13,
  maxCompatibleAbi: 15,
  packs: {
    python: {
      languageId: "python",
      packageName: "tree-sitter-python",
      version: "0.25.0",
      tarballUrl: "https://example.test/tree-sitter-python.tgz",
      wasmPath: "package/tree-sitter-python.wasm",
      grammarFile: "tree-sitter-python.wasm",
      integrity,
      bytes: wasm.byteLength,
      abi: 15,
      licensePath: "package/LICENSE",
    },
  },
  skipped: {},
});

const storeOf = () => createGrammarStore(mkdtempSync(join(tmpdir(), "piarium-grammar-install-")));

describe("createGrammarInstaller", () => {
  it("rejects a digest mismatch and does not keep the file", async () => {
    const store = storeOf();
    const installer = createGrammarInstaller({
      store,
      manifest,
      minAbi: 13,
      maxAbi: 15,
      download: async () => new Uint8Array([9, 9, 9]),
      extractWasm: async () => new Uint8Array([9, 9, 9]),
      inspectAbi: async () => 15,
    });
    await expect(installer.install({ languageId: "python" })).resolves.toMatchObject({
      status: "failed",
      reason: "integrity",
    });
    expect(store.has("python")).toBe(false);
  });

  it("cancels an in-flight download", async () => {
    const store = storeOf();
    let release: (() => void) | undefined;
    const installer = createGrammarInstaller({
      store,
      manifest,
      minAbi: 13,
      maxAbi: 15,
      download: async (_url, signal) => {
        await new Promise<void>((resolve, reject) => {
          release = resolve;
          signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")));
        });
        return wasm;
      },
      extractWasm: async () => wasm,
      inspectAbi: async () => 15,
    });
    const pending = installer.install({ languageId: "python" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await expect(installer.cancelInstall({ languageId: "python" })).resolves.toMatchObject({
      status: "cancelled",
    });
    await expect(pending).resolves.toMatchObject({ status: "cancelled" });
    expect(store.has("python")).toBe(false);
    release?.();
  });

  it("rejects an ABI outside the application window and cleans up", async () => {
    const store = storeOf();
    const installer = createGrammarInstaller({
      store,
      manifest,
      minAbi: 13,
      maxAbi: 15,
      download: async () => wasm,
      extractWasm: async () => wasm,
      inspectAbi: async () => 16,
    });
    await expect(installer.install({ languageId: "python" })).resolves.toMatchObject({
      status: "failed",
      reason: "failed",
    });
    expect(store.has("python")).toBe(false);
  });

  it("imports a user wasm without a manifest match", async () => {
    const store = storeOf();
    const installer = createGrammarInstaller({
      store,
      manifest,
      minAbi: 13,
      maxAbi: 15,
      readLocal: async () => wasm,
      inspectAbi: async () => 14,
    });
    await expect(installer.importUserGrammar({ languageId: "kotlin", path: "C:\\tmp\\custom.wasm" })).resolves.toMatchObject({
      status: "ready",
      grammarStatus: "user-unverified",
    });
    expect(store.get("kotlin")?.source).toBe("user");
  });
});
