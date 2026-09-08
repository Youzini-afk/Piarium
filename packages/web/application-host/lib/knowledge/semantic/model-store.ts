/**
 * Content-addressed MiniLM pack, same install shape as structure grammars.
 *
 * Blobs are immutable and named by digest. `index.json` is the only binding
 * from a recipe id to those blobs. A missing index is empty; a torn or
 * unreadable index is an error (plan 0.4 invariant 10).
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { remapAsarUnpackedPath } from "../../structure/runtime-path.js";
import { LOCAL_MINILM_MAX_TOKENS, LOCAL_MINILM_SPACE, type VectorSpaceIdentity } from "./identity.js";

export const SEMANTIC_MODEL_ID = "all-minilm-l6-v2";

export type SemanticModelPackSource = "manifest" | "user";

export interface SemanticModelRecipe {
  schemaVersion: 1;
  provider: "local";
  model: string;
  modelRevision: string;
  dim: number;
  pooling: "mean" | "cls";
  normalize: boolean;
  maxTokens: number;
  onnxFile: string;
  tokenizerFile: string;
}

export interface SemanticModelRecord {
  integrity: string;
  source: SemanticModelPackSource;
  installedAt: string;
  recipe: SemanticModelRecipe;
}

export class SemanticModelStoreUnreadableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SemanticModelStoreUnreadableError";
  }
}

export interface SemanticModelStoreIndex {
  schemaVersion: 1;
  models: Record<string, SemanticModelRecord>;
}

export interface ResolvedModelPack {
  id: string;
  root: string;
  recipe: SemanticModelRecipe;
  space: VectorSpaceIdentity;
  onnxPath: string | null;
  tokenizerPath: string | null;
  source: "bundled" | "store";
}

const INDEX_NAME = "index.json";
const RECIPE_NAME = "recipe.json";

const integrityOf = (bytes: Uint8Array): string => (
  `sha256-${createHash("sha256").update(bytes).digest("hex")}`
);

const emptyIndex = (): SemanticModelStoreIndex => ({ schemaVersion: 1, models: {} });

const readIndex = (file: string): SemanticModelStoreIndex => {
  let source: string;
  try {
    source = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyIndex();
    throw new SemanticModelStoreUnreadableError(`Semantic model index is not readable: ${file}`, { cause: error });
  }
  let raw: Partial<SemanticModelStoreIndex>;
  try {
    raw = JSON.parse(source) as Partial<SemanticModelStoreIndex>;
  } catch (error) {
    throw new SemanticModelStoreUnreadableError(`Semantic model index is not valid JSON: ${file}`, { cause: error });
  }
  if (raw.schemaVersion !== 1 || !raw.models || typeof raw.models !== "object" || Array.isArray(raw.models)) {
    throw new SemanticModelStoreUnreadableError(`Semantic model index has an unknown shape: ${file}`);
  }
  const models: Record<string, SemanticModelRecord> = {};
  for (const [id, record] of Object.entries(raw.models)) {
    if (
      record
      && typeof record.integrity === "string"
      && record.integrity.startsWith("sha256-")
      && (record.source === "manifest" || record.source === "user")
      && typeof record.installedAt === "string"
      && record.recipe
      && record.recipe.schemaVersion === 1
    ) {
      models[id] = record;
    }
  }
  return { schemaVersion: 1, models };
};

const readRecipe = (file: string): SemanticModelRecipe | null => {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as SemanticModelRecipe;
    if (raw.schemaVersion !== 1 || raw.provider !== "local") return null;
    return raw;
  } catch {
    return null;
  }
};

const spaceFromRecipe = (recipe: SemanticModelRecipe): VectorSpaceIdentity => ({
  provider: recipe.provider,
  model: recipe.model,
  modelRevision: recipe.modelRevision,
  dim: recipe.dim,
  pooling: recipe.pooling,
  normalize: recipe.normalize,
  maxTokens: recipe.maxTokens,
});

const defaultRecipe = (): SemanticModelRecipe => ({
  schemaVersion: 1,
  provider: "local",
  model: LOCAL_MINILM_SPACE.model,
  modelRevision: LOCAL_MINILM_SPACE.modelRevision,
  dim: LOCAL_MINILM_SPACE.dim,
  pooling: LOCAL_MINILM_SPACE.pooling,
  normalize: LOCAL_MINILM_SPACE.normalize,
  maxTokens: LOCAL_MINILM_MAX_TOKENS,
  onnxFile: "model_quantized.onnx",
  tokenizerFile: "tokenizer.json",
});

export const bundledModelPackDir = (
  fromUrl: string = import.meta.url,
  pathExists: (candidate: string) => boolean = existsSync,
): string => remapAsarUnpackedPath(
  fileURLToPath(new URL("./runtime/all-minilm-l6-v2/", fromUrl)),
  pathExists,
);

export function createSemanticModelStore(dataDir: string, now: () => string = () => new Date().toISOString()) {
  const root = join(dataDir, "semantic-models");
  const indexPath = join(root, INDEX_NAME);
  mkdirSync(join(root, "sha256"), { recursive: true });

  const persist = (index: SemanticModelStoreIndex): void => {
    const tmp = `${indexPath}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(index, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, indexPath);
  };

  const packDir = (integrity: string): string => join(root, "sha256", integrity.slice("sha256-".length));

  return {
    root,
    has: (id: string) => Boolean(readIndex(indexPath).models[id]),
    get: (id: string) => readIndex(indexPath).models[id],
    pathForIntegrity: (integrity: string) => packDir(integrity),
    put: (id: string, files: Record<string, Uint8Array>, record: Omit<SemanticModelRecord, "installedAt">): SemanticModelRecord => {
      const listing = Object.keys(files).sort().map((name) => `${name}:${integrityOf(files[name]!)}`).join("\n");
      const integrity = integrityOf(new TextEncoder().encode(listing));
      if (integrity !== record.integrity) {
        throw new Error("Semantic model pack bytes do not match the supplied integrity.");
      }
      const index = readIndex(indexPath);
      const dest = packDir(integrity);
      mkdirSync(dest, { recursive: true });
      for (const [name, bytes] of Object.entries(files)) {
        const file = join(dest, name);
        const tmp = `${file}.${process.pid}.tmp`;
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(tmp, bytes);
        renameSync(tmp, file);
      }
      const stored: SemanticModelRecord = { ...record, installedAt: now() };
      index.models[id] = stored;
      persist(index);
      return stored;
    },
    remove: (id: string) => {
      const index = readIndex(indexPath);
      const record = index.models[id];
      if (!record) return;
      delete index.models[id];
      persist(index);
      if (!Object.values(index.models).some((entry) => entry.integrity === record.integrity)) {
        rmSync(packDir(record.integrity), { recursive: true, force: true });
      }
    },
  };
}

export type SemanticModelStore = ReturnType<typeof createSemanticModelStore>;

const memo = new Map<string, ResolvedModelPack | null>();

export function resolveInstalledModelPack(
  dataDir: string,
  fromUrl: string = import.meta.url,
  pathExists: (candidate: string) => boolean = existsSync,
): ResolvedModelPack | null {
  const key = `${dataDir}\0${fromUrl}`;
  if (memo.has(key)) return memo.get(key) ?? null;
  const bundledRoot = bundledModelPackDir(fromUrl, pathExists);
  const bundledRecipe = readRecipe(join(bundledRoot, RECIPE_NAME)) ?? defaultRecipe();
  const bundledOnnx = join(bundledRoot, bundledRecipe.onnxFile);
  const bundledTokenizer = join(bundledRoot, bundledRecipe.tokenizerFile);
  if (pathExists(bundledTokenizer) || pathExists(bundledOnnx)) {
    const pack: ResolvedModelPack = {
      id: SEMANTIC_MODEL_ID,
      root: bundledRoot,
      recipe: bundledRecipe,
      space: spaceFromRecipe(bundledRecipe),
      onnxPath: pathExists(bundledOnnx) ? bundledOnnx : null,
      tokenizerPath: pathExists(bundledTokenizer) ? bundledTokenizer : null,
      source: "bundled",
    };
    memo.set(key, pack);
    return pack;
  }
  try {
    const store = createSemanticModelStore(dataDir);
    const record = store.get(SEMANTIC_MODEL_ID);
    if (!record) {
      memo.set(key, null);
      return null;
    }
    const root = store.pathForIntegrity(record.integrity);
    const onnxPath = join(root, record.recipe.onnxFile);
    const tokenizerPath = join(root, record.recipe.tokenizerFile);
    const pack: ResolvedModelPack = {
      id: SEMANTIC_MODEL_ID,
      root,
      recipe: record.recipe,
      space: spaceFromRecipe(record.recipe),
      onnxPath: pathExists(onnxPath) ? onnxPath : null,
      tokenizerPath: pathExists(tokenizerPath) ? tokenizerPath : null,
      source: "store",
    };
    memo.set(key, pack);
    return pack;
  } catch (error) {
    if (error instanceof SemanticModelStoreUnreadableError) throw error;
    memo.set(key, null);
    return null;
  }
}

export const resetInstalledModelPackMemo = (): void => {
  memo.clear();
};
