import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const GRAMMAR_INTEGRITY_PATTERN = /^sha256-[0-9a-f]{64}$/;

export interface GrammarPackEntry {
  languageId: string;
  packageName: string;
  version: string;
  tarballUrl: string;
  wasmPath: string;
  grammarFile: string;
  integrity: string;
  bytes: number;
  abi: number;
  licensePath: string | null;
}

export interface GrammarPackManifest {
  generatedAt: string;
  minCompatibleAbi: number;
  maxCompatibleAbi: number;
  packs: Record<string, GrammarPackEntry>;
  skipped: Record<string, string>;
}

export const isGrammarIntegrity = (value: string): boolean => GRAMMAR_INTEGRITY_PATTERN.test(value);

export const grammarIntegrityHex = (integrity: string): string => integrity.slice("sha256-".length);

export function parseGrammarPackManifest(value: unknown): GrammarPackManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Grammar pack manifest is not an object.");
  }
  const raw = value as Record<string, unknown>;
  if (typeof raw.generatedAt !== "string" || typeof raw.minCompatibleAbi !== "number" || typeof raw.maxCompatibleAbi !== "number") {
    throw new Error("Grammar pack manifest is missing ABI bounds.");
  }
  const packs: Record<string, GrammarPackEntry> = {};
  const rawPacks = raw.packs && typeof raw.packs === "object" && !Array.isArray(raw.packs)
    ? raw.packs as Record<string, unknown>
    : {};
  for (const [languageId, entry] of Object.entries(rawPacks)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const pack = entry as Record<string, unknown>;
    if (
      typeof pack.packageName !== "string"
      || typeof pack.version !== "string"
      || typeof pack.tarballUrl !== "string"
      || typeof pack.wasmPath !== "string"
      || typeof pack.grammarFile !== "string"
      || typeof pack.integrity !== "string"
      || !isGrammarIntegrity(pack.integrity)
      || typeof pack.bytes !== "number"
      || typeof pack.abi !== "number"
    ) {
      throw new Error(`Grammar pack manifest entry for ${languageId} is invalid.`);
    }
    packs[languageId] = {
      languageId,
      packageName: pack.packageName,
      version: pack.version,
      tarballUrl: pack.tarballUrl,
      wasmPath: pack.wasmPath,
      grammarFile: pack.grammarFile,
      integrity: pack.integrity,
      bytes: pack.bytes,
      abi: pack.abi,
      licensePath: typeof pack.licensePath === "string" ? pack.licensePath : null,
    };
  }
  const skipped = raw.skipped && typeof raw.skipped === "object" && !Array.isArray(raw.skipped)
    ? Object.fromEntries(
      Object.entries(raw.skipped as Record<string, unknown>)
        .filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    )
    : {};
  return {
    generatedAt: raw.generatedAt,
    minCompatibleAbi: raw.minCompatibleAbi,
    maxCompatibleAbi: raw.maxCompatibleAbi,
    packs,
    skipped,
  };
}

export function loadCommittedGrammarPackManifest(
  fromUrl: string = import.meta.url,
): GrammarPackManifest {
  const source = readFileSync(fileURLToPath(new URL("./grammar-packs.json", fromUrl)), "utf8");
  return parseGrammarPackManifest(JSON.parse(source));
}
