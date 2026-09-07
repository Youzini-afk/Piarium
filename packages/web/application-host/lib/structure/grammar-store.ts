/**
 * On-demand grammar blobs, content-addressed under the data directory.
 *
 * Blobs are immutable and named by digest; `index.json` is the only thing that
 * binds a language to them, so it is staged and renamed like the blobs, and an
 * index that cannot be read is an error rather than an empty store.
 */
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
  /** Digest of the stored `tags.scm`, when the pack shipped a usable one. */
  tagsIntegrity?: string;
  packageName?: string;
  version?: string;
}

/**
 * The index could not be read. Only a missing file means "nothing installed"
 * (plan 0.4 invariant 10) — a parse error or an EACCES must not be reported as
 * an empty store, because the next write would then persist an index that has
 * dropped every other language.
 */
export class GrammarStoreUnreadableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "GrammarStoreUnreadableError";
  }
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
  /** Query source stored next to the grammar, or null when the pack had none. */
  readTagsQuery(languageId: string): string | null;
  put(
    languageId: string,
    bytes: Uint8Array,
    record: Omit<GrammarStoreRecord, "installedAt">,
    tags?: { bytes: Uint8Array; integrity: string },
  ): GrammarStoreRecord;
  remove(languageId: string): void;
}

const INDEX_NAME = "index.json";

export const grammarIntegrityOf = (bytes: Uint8Array): string => (
  `sha256-${createHash("sha256").update(bytes).digest("hex")}`
);

const emptyIndex = (): GrammarStoreIndex => ({ schemaVersion: 1, languages: {} });

const readIndex = (file: string): GrammarStoreIndex => {
  let source: string;
  try {
    source = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyIndex();
    throw new GrammarStoreUnreadableError(`Grammar index is not readable: ${file}`, { cause: error });
  }
  let raw: Partial<GrammarStoreIndex>;
  try {
    raw = JSON.parse(source) as Partial<GrammarStoreIndex>;
  } catch (error) {
    throw new GrammarStoreUnreadableError(`Grammar index is not valid JSON: ${file}`, { cause: error });
  }
  if (raw.schemaVersion !== 1 || !raw.languages || typeof raw.languages !== "object" || Array.isArray(raw.languages)) {
    throw new GrammarStoreUnreadableError(`Grammar index has an unknown shape: ${file}`);
  }
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
};

export function createGrammarStore(dataDir: string, now: () => string = () => new Date().toISOString()): GrammarStore {
  const root = join(dataDir, "structure-grammars");
  const indexPath = join(root, INDEX_NAME);
  mkdirSync(join(root, "sha256"), { recursive: true });

  /**
   * The index is the only thing that maps a language to its blobs, so a torn
   * write loses every installed grammar. Stage and rename like the blobs do.
   */
  const persist = (index: GrammarStoreIndex): void => {
    const tmp = `${indexPath}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(index, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, indexPath);
  };

  const pathForIntegrity = (integrity: string): string => {
    if (!GRAMMAR_INTEGRITY_PATTERN.test(integrity)) {
      throw new Error(`Invalid grammar integrity: ${integrity}`);
    }
    return join(root, "sha256", `${grammarIntegrityHex(integrity)}.wasm`);
  };

  const pathForTagsIntegrity = (integrity: string): string => {
    if (!GRAMMAR_INTEGRITY_PATTERN.test(integrity)) {
      throw new Error(`Invalid grammar integrity: ${integrity}`);
    }
    return join(root, "sha256", `${grammarIntegrityHex(integrity)}.scm`);
  };

  const writeBlob = (dest: string, bytes: Uint8Array): void => {
    mkdirSync(dirname(dest), { recursive: true });
    const tmp = `${dest}.${process.pid}.tmp`;
    writeFileSync(tmp, bytes);
    renameSync(tmp, dest);
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
    readTagsQuery: (languageId) => {
      const record = readIndex(indexPath).languages[languageId];
      if (!record?.tagsIntegrity) return null;
      const file = pathForTagsIntegrity(record.tagsIntegrity);
      try {
        return readFileSync(file, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw new GrammarStoreUnreadableError(`Grammar query is not readable: ${file}`, { cause: error });
      }
    },
    put: (languageId, bytes, record, tags) => {
      if (grammarIntegrityOf(bytes) !== record.integrity) {
        throw new Error("Grammar wasm bytes do not match the supplied integrity.");
      }
      if (tags && grammarIntegrityOf(tags.bytes) !== tags.integrity) {
        throw new Error("Grammar query bytes do not match the supplied integrity.");
      }
      // Read the index before writing blobs: an unreadable index must abort the
      // install rather than leave an orphan blob behind.
      const index = readIndex(indexPath);
      writeBlob(pathForIntegrity(record.integrity), bytes);
      if (tags) writeBlob(pathForTagsIntegrity(tags.integrity), tags.bytes);
      const stored: GrammarStoreRecord = {
        ...record,
        ...(tags ? { tagsIntegrity: tags.integrity } : {}),
        installedAt: now(),
      };
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
      const remaining = Object.values(index.languages);
      if (!remaining.some((entry) => entry.integrity === record.integrity)) {
        rmSync(pathForIntegrity(record.integrity), { force: true });
      }
      if (record.tagsIntegrity && !remaining.some((entry) => entry.tagsIntegrity === record.tagsIntegrity)) {
        rmSync(pathForTagsIntegrity(record.tagsIntegrity), { force: true });
      }
    },
  };
}
