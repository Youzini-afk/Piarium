import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  GRAMMAR_INTEGRITY_PATTERN,
  grammarIntegrityHex,
  isGrammarIntegrity,
} from "./grammar-manifest.js";

export type GrammarStoreSource = "manifest" | "user";

export interface GrammarStoreRecord {
  integrity: string;
  source: GrammarStoreSource;
  installedAt: string;
  grammarFile: string;
  packageName?: string;
  version?: string;
}

export interface GrammarStoreIndex {
  schemaVersion: 1;
  languages: Record<string, GrammarStoreRecord>;
}

export interface GrammarStore {
  root: string;
  has(languageId: string): boolean;
  get(languageId: string): GrammarStoreRecord | undefined;
  idsBySource(source: GrammarStoreSource): string[];
  pathForIntegrity(integrity: string): string;
  pathForGrammarFile(fileName: string): string | null;
  put(languageId: string, bytes: Uint8Array, record: Omit<GrammarStoreRecord, "installedAt">): GrammarStoreRecord;
  remove(languageId: string): void;
}

const INDEX_NAME = "index.json";

export const grammarIntegrityOf = (bytes: Uint8Array): string => (
  `sha256-${createHash("sha256").update(bytes).digest("hex")}`
);

const emptyIndex = (): GrammarStoreIndex => ({ schemaVersion: 1, languages: {} });

const readIndex = (file: string): GrammarStoreIndex => {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<GrammarStoreIndex>;
    if (raw.schemaVersion !== 1 || !raw.languages || typeof raw.languages !== "object") return emptyIndex();
    const languages: Record<string, GrammarStoreRecord> = {};
    for (const [languageId, record] of Object.entries(raw.languages)) {
      if (
        record
        && typeof record.integrity === "string"
        && isGrammarIntegrity(record.integrity)
        && (record.source === "manifest" || record.source === "user")
        && typeof record.installedAt === "string"
        && typeof record.grammarFile === "string"
      ) {
        languages[languageId] = record;
      }
    }
    return { schemaVersion: 1, languages };
  } catch {
    return emptyIndex();
  }
};

export function createGrammarStore(dataDir: string, now: () => string = () => new Date().toISOString()): GrammarStore {
  const root = join(dataDir, "structure-grammars");
  const indexPath = join(root, INDEX_NAME);
  mkdirSync(join(root, "sha256"), { recursive: true });

  const persist = (index: GrammarStoreIndex): void => {
    writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");
  };

  const pathForIntegrity = (integrity: string): string => {
    if (!GRAMMAR_INTEGRITY_PATTERN.test(integrity)) {
      throw new Error(`Invalid grammar integrity: ${integrity}`);
    }
    return join(root, "sha256", `${grammarIntegrityHex(integrity)}.wasm`);
  };

  return {
    root,
    has: (languageId) => Boolean(readIndex(indexPath).languages[languageId]),
    get: (languageId) => readIndex(indexPath).languages[languageId],
    idsBySource: (source) => (
      Object.entries(readIndex(indexPath).languages)
        .filter(([, record]) => record.source === source)
        .map(([languageId]) => languageId)
    ),
    pathForIntegrity,
    pathForGrammarFile: (fileName) => {
      const match = Object.values(readIndex(indexPath).languages).find((record) => record.grammarFile === fileName);
      return match ? pathForIntegrity(match.integrity) : null;
    },
    put: (languageId, bytes, record) => {
      if (grammarIntegrityOf(bytes) !== record.integrity) {
        throw new Error("Grammar wasm bytes do not match the supplied integrity.");
      }
      const dest = pathForIntegrity(record.integrity);
      mkdirSync(dirname(dest), { recursive: true });
      const tmp = `${dest}.${process.pid}.tmp`;
      writeFileSync(tmp, bytes);
      renameSync(tmp, dest);
      const stored: GrammarStoreRecord = { ...record, installedAt: now() };
      const index = readIndex(indexPath);
      index.languages[languageId] = stored;
      persist(index);
      return stored;
    },
    remove: (languageId) => {
      const index = readIndex(indexPath);
      const record = index.languages[languageId];
      if (!record) return;
      delete index.languages[languageId];
      persist(index);
      const stillUsed = Object.values(index.languages).some((entry) => entry.integrity === record.integrity);
      if (!stillUsed) {
        rmSync(pathForIntegrity(record.integrity), { force: true });
      }
    },
  };
}
