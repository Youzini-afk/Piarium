import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extract } from "tar";
import type { LanguageSupportInstallResult } from "@piarium/application-client";
import { treeSitterLanguageSpec } from "./languages.js";
import type { GrammarPackManifest } from "./grammar-manifest.js";
import { grammarIntegrityOf, type GrammarStore } from "./grammar-store.js";

export interface GrammarInstaller {
  install(request: { languageId: string }): Promise<LanguageSupportInstallResult>;
  cancelInstall(request: { languageId: string }): Promise<LanguageSupportInstallResult>;
  importUserGrammar(request: { languageId: string; path: string }): Promise<LanguageSupportInstallResult>;
}

export interface GrammarInstallerOptions {
  store: GrammarStore;
  manifest: GrammarPackManifest;
  minAbi: number;
  maxAbi: number;
  download?: (url: string, signal?: AbortSignal) => Promise<Uint8Array>;
  extractWasm?: (tarball: Uint8Array, wasmPath: string, signal?: AbortSignal) => Promise<Uint8Array>;
  inspectAbi?: (bytes: Uint8Array) => Promise<number>;
  readLocal?: (path: string) => Promise<Uint8Array>;
}

const failed = (
  languageId: string,
  reason: Extract<LanguageSupportInstallResult, { status: "failed" }>["reason"],
  message: string,
): LanguageSupportInstallResult => ({ status: "failed", languageId, reason, message });

export async function downloadBytes(url: string, signal?: AbortSignal): Promise<Uint8Array> {
  const response = await fetch(url, signal ? { signal } : undefined);
  if (!response.ok) {
    throw new Error(`Download failed: ${response.status} ${response.statusText}`);
  }
  if (!response.body) throw new Error("Download failed: empty body.");
  return new Uint8Array(await response.arrayBuffer());
}

export async function extractWasmFromTarball(
  tarball: Uint8Array,
  wasmPath: string,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  if (signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
  const work = await mkdtemp(join(tmpdir(), "piarium-grammar-extract-"));
  const archive = join(work, "pack.tgz");
  try {
    await writeFile(archive, tarball);
    await extract({
      file: archive,
      cwd: work,
      filter: (entry) => entry.replace(/\\/g, "/") === wasmPath || entry.replace(/\\/g, "/").endsWith(`/${wasmPath}`),
    });
    const candidates = [join(work, wasmPath), join(work, wasmPath.replace(/^package\//, ""))];
    for (const candidate of candidates) {
      try {
        return new Uint8Array(await readFile(candidate));
      } catch {
        // try the next layout
      }
    }
    throw new Error(`Tarball did not contain ${wasmPath}.`);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

const isAbort = (error: unknown): boolean => (
  (error instanceof Error && error.name === "AbortError")
  || (typeof DOMException !== "undefined" && error instanceof DOMException && error.name === "AbortError")
);

export function createGrammarInstaller(options: GrammarInstallerOptions): GrammarInstaller {
  const download = options.download ?? downloadBytes;
  const extractWasm = options.extractWasm ?? extractWasmFromTarball;
  const readLocal = options.readLocal ?? (async (path: string) => new Uint8Array(await readFile(path)));
  const inspectAbi = options.inspectAbi;
  const inflight = new Map<string, AbortController>();

  const checkAbi = async (languageId: string, bytes: Uint8Array): Promise<LanguageSupportInstallResult | null> => {
    if (!inspectAbi) return null;
    const abi = await inspectAbi(bytes);
    if (abi < options.minAbi || abi > options.maxAbi) {
      return failed(
        languageId,
        "failed",
        `Grammar ABI ${abi} is locked out of this application (compatible ${options.minAbi}-${options.maxAbi}).`,
      );
    }
    return null;
  };

  const install = async ({ languageId }: { languageId: string }): Promise<LanguageSupportInstallResult> => {
    const id = languageId.trim();
    if (!id) return failed(languageId, "absent", "Language id is required.");
    if (treeSitterLanguageSpec(id)) {
      return { status: "ready", languageId: id, grammarStatus: "bundled" };
    }
    const pack = options.manifest.packs[id];
    if (!pack) return failed(id, "absent", "No published grammar pack is listed for this language.");
    inflight.get(id)?.abort();
    const controller = new AbortController();
    inflight.set(id, controller);
    try {
      const tarball = await download(pack.tarballUrl, controller.signal);
      if (controller.signal.aborted) return { status: "cancelled", languageId: id };
      const wasm = await extractWasm(tarball, pack.wasmPath, controller.signal);
      if (controller.signal.aborted) return { status: "cancelled", languageId: id };
      const integrity = grammarIntegrityOf(wasm);
      if (integrity !== pack.integrity) {
        return failed(id, "integrity", "Downloaded grammar wasm did not match the published digest.");
      }
      const abiFailure = await checkAbi(id, wasm);
      if (abiFailure) return abiFailure;
      options.store.put(id, wasm, {
        integrity,
        source: "manifest",
        grammarFile: pack.grammarFile,
        packageName: pack.packageName,
        version: pack.version,
      });
      return { status: "ready", languageId: id, grammarStatus: "installed" };
    } catch (error) {
      if (controller.signal.aborted || isAbort(error)) return { status: "cancelled", languageId: id };
      return failed(id, "failed", error instanceof Error ? error.message : "Grammar install failed.");
    } finally {
      if (inflight.get(id) === controller) inflight.delete(id);
    }
  };

  return {
    install,
    cancelInstall: async ({ languageId }) => {
      const id = languageId.trim();
      const controller = inflight.get(id);
      if (controller) {
        controller.abort();
        return { status: "cancelled", languageId: id };
      }
      return failed(id, "absent", "No grammar download is in progress.");
    },
    importUserGrammar: async ({ languageId, path }) => {
      const id = languageId.trim();
      if (!id) return failed(languageId, "absent", "Language id is required.");
      if (treeSitterLanguageSpec(id)) {
        return failed(id, "unsupported", "Bundled grammars cannot be replaced by a user file.");
      }
      if (!path.trim()) return failed(id, "absent", "A local .wasm path is required.");
      try {
        const bytes = await readLocal(path.trim());
        const integrity = grammarIntegrityOf(bytes);
        const abiFailure = await checkAbi(id, bytes);
        if (abiFailure) return abiFailure;
        options.store.put(id, bytes, {
          integrity,
          source: "user",
          grammarFile: `${id}.wasm`,
        });
        return { status: "ready", languageId: id, grammarStatus: "user-unverified" };
      } catch (error) {
        return failed(id, "failed", error instanceof Error ? error.message : "User grammar import failed.");
      }
    },
  };
}
