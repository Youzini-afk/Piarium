/**
 * Independent semantic generation store. Not the authoritative workspace .tdb
 * (that file locks a single dim at open). Host is the only writer.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import {
  defaultRecipeIdentity,
  recipeIdOf,
  semanticGenerationDir,
  semanticSpaceDir,
  spaceIdOf,
  type IndexRecipeIdentity,
  type SemanticScopeKey,
  type VectorSpaceIdentity,
} from "./identity.js";
import { cosineSimilarity, type SemanticEmbedder } from "./embedder.js";
import type { SemanticChunk } from "./chunker.js";

const require = createRequire(import.meta.url);
const { TriviumDB } = require("triviumdb") as typeof import("triviumdb");

const FLUSH_QUIET_MS = 250;
const FLUSH_MAX_DEFER_MS = 30_000;

export type SemanticIndexLifecycle = "idle" | "building" | "rebuilding" | "ready";
export type SemanticQueryCoverage = "empty" | "partial" | "complete";

export type SemanticHit = {
  documentId: string;
  revision: string;
  blockId: string;
  parentUnitId: string;
  parentName: string;
  parentKind: string;
  startLine: number;
  endLine: number;
  contentHash: string;
  fallback: boolean;
  body: string;
  similarity: number;
  rank: number;
  scope: SemanticScopeKey;
  spaceId: string;
  generation: string;
};

export type SemanticCheckpoint = {
  generation: string;
  spaceId: string;
  recipeId: string;
  lifecycle: SemanticIndexLifecycle;
  coverage: SemanticQueryCoverage;
  publishedDocuments: number;
};

type BlockPayload = {
  type: "block";
  documentId: string;
  revision: string;
  blockId: string;
  parentUnitId: string;
  parentName: string;
  parentKind: string;
  parentSignature: string;
  startLine: number;
  endLine: number;
  contentHash: string;
  fallback: boolean;
  body: string;
  embedText: string;
};

type DocumentPayload = {
  type: "document";
  documentId: string;
  revision: string;
  recipeId: string;
  blockCount: number;
};

export type SemanticDocumentPublication = {
  documentId: string;
  revision: string;
  chunks: readonly SemanticChunk[];
};

const checkpointPath = (spaceDir: string): string => join(spaceDir, "current.json");

const readCheckpoint = (spaceDir: string): SemanticCheckpoint | null => {
  try {
    const raw = JSON.parse(readFileSync(checkpointPath(spaceDir), "utf8")) as SemanticCheckpoint;
    if (!raw.generation || !raw.spaceId || !raw.recipeId) return null;
    return raw;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
};

const writeCheckpoint = (spaceDir: string, checkpoint: SemanticCheckpoint): void => {
  mkdirSync(spaceDir, { recursive: true });
  const target = checkpointPath(spaceDir);
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(checkpoint)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, target);
};

const openDb = (file: string, dim: number, accessMode: "readWrite" | "readOnly") => {
  const db = new TriviumDB(file, {
    dim,
    syncMode: "normal",
    loadTextIndex: false,
    payloadCacheMb: 0,
    accessMode,
  });
  if (accessMode === "readWrite") {
    db.createIndex("type");
    db.createIndex("documentId");
    db.createIndex("blockId");
  }
  return db;
};

export function createSemanticGenerationStore(options: {
  dataDir: string;
  hostId: string;
  scope: SemanticScopeKey;
  embedder: SemanticEmbedder;
  recipe?: IndexRecipeIdentity;
}) {
  const space = options.embedder.space;
  const spaceId = spaceIdOf(space);
  const recipe = options.recipe ?? defaultRecipeIdentity();
  const recipeId = recipeIdOf(recipe);
  const spaceDir = semanticSpaceDir(options.dataDir, options.hostId, options.scope, spaceId);
  let checkpoint = readCheckpoint(spaceDir);
  const generation = checkpoint?.generation ?? "g1";
  let lifecycle: SemanticIndexLifecycle = checkpoint?.lifecycle ?? "idle";
  let coverage: SemanticQueryCoverage = checkpoint?.coverage ?? "empty";
  const dbFile = () => join(semanticGenerationDir(options.dataDir, options.hostId, options.scope, spaceId, generation), "index.tdb");
  const maximumLookupResults = (db: InstanceType<typeof TriviumDB>): number => Math.max(1, db.nodeCount());
  let writer: InstanceType<typeof TriviumDB> | null = null;
  const countStoredDocuments = (): number => {
    if (!existsSync(dbFile())) return 0;
    // Host is the sole writer. A previous process may have left WAL recovery
    // pending, which readOnly rejects, so recover once here and keep this writer
    // for the scan's revision lookups instead of reopening the database per file.
    const db = openDb(dbFile(), space.dim, "readWrite");
    try {
      const count = db.indexedLookup({ type: "document" }, maximumLookupResults(db)).length;
      writer = db;
      return count;
    } catch (error) {
      db.close();
      throw error;
    }
  };
  // A checkpoint can lag the WAL when the process stops between a database
  // transaction and current.json. Reconcile once on open, then maintain the
  // count from each committed document replacement/removal.
  let publishedDocuments = countStoredDocuments();
  let writeTail: Promise<void> = Promise.resolve();
  let flushDirty = false;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let flushDeadline = 0;
  let disposed = false;

  const enqueue = <T>(work: () => T): Promise<T> => {
    const run = writeTail.then(work, work);
    writeTail = run.then(() => undefined, () => undefined);
    return run;
  };

  const flushNow = (): void => {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    flushDeadline = 0;
    if (!flushDirty || !writer) return;
    flushDirty = false;
    writer.flush();
  };

  const scheduleFlush = (): void => {
    flushDirty = true;
    const now = Date.now();
    if (flushDeadline === 0) flushDeadline = now + FLUSH_MAX_DEFER_MS;
    if (now >= flushDeadline) {
      flushNow();
      return;
    }
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void enqueue(() => flushNow());
    }, Math.min(FLUSH_QUIET_MS, Math.max(0, flushDeadline - now)));
    flushTimer.unref?.();
  };

  const refreshCheckpoint = (): SemanticCheckpoint => {
    const refreshed: SemanticCheckpoint = {
      generation,
      spaceId,
      recipeId,
      lifecycle,
      coverage,
      publishedDocuments,
    };
    checkpoint = refreshed;
    return refreshed;
  };

  const persistCheckpoint = (): void => {
    writeCheckpoint(spaceDir, refreshCheckpoint());
  };

  const ensureWriter = (): InstanceType<typeof TriviumDB> => {
    if (writer) return writer;
    mkdirSync(semanticGenerationDir(options.dataDir, options.hostId, options.scope, spaceId, generation), { recursive: true });
    writer = openDb(dbFile(), space.dim, "readWrite");
    return writer;
  };

  const lookupDocuments = (db: InstanceType<typeof TriviumDB>, documentId: string): number[] => (
    db.indexedLookup({ type: "document", documentId }, maximumLookupResults(db))
  );

  const lookupBlocks = (db: InstanceType<typeof TriviumDB>, documentId: string): number[] => (
    db.indexedLookup({ type: "block", documentId }, maximumLookupResults(db))
  );

  const publishDocuments = async (inputs: readonly SemanticDocumentPublication[]): Promise<void> => {
    if (options.embedder.status !== "ready" || inputs.length === 0) return;
    const publicationsByDocument = new Map<string, SemanticDocumentPublication>();
    for (const input of inputs) publicationsByDocument.set(input.documentId, input);
    const publications = [...publicationsByDocument.values()];
    await options.embedder.prepare();
    const chunks = publications.flatMap((input) => input.chunks);
    const vectors = chunks.length === 0
      ? []
      : await options.embedder.embed(chunks.map((chunk) => chunk.embedText));
    if (vectors.length !== chunks.length || vectors.some((vector) => vector.length !== space.dim)) {
      throw new Error(`Semantic embedder returned ${vectors.length} vectors for ${chunks.length} chunks in ${space.dim} dimensions.`);
    }
    await enqueue(() => {
      const db = ensureWriter();
      const operations: import("triviumdb").TransactionOperation[] = [];
      const emptyVector = new Array(space.dim).fill(0);
      let vectorIndex = 0;
      let documentDelta = 0;
      for (const input of publications) {
        const oldBlocks = lookupBlocks(db, input.documentId);
        const oldDocuments = lookupDocuments(db, input.documentId);
        documentDelta += 1 - oldDocuments.length;
        for (const id of [...oldBlocks, ...oldDocuments]) operations.push({ type: "delete", id });
        for (const chunk of input.chunks) {
          const payload: BlockPayload = {
            type: "block",
            documentId: input.documentId,
            revision: input.revision,
            blockId: chunk.blockId,
            parentUnitId: chunk.parentUnitId,
            parentName: chunk.parentName,
            parentKind: chunk.parentKind,
            parentSignature: chunk.parentSignature,
            startLine: chunk.startLine,
            endLine: chunk.endLine,
            contentHash: chunk.contentHash,
            fallback: chunk.fallback,
            body: chunk.body,
            embedText: chunk.embedText,
          };
          operations.push({ type: "insert", vector: vectors[vectorIndex]!, payload });
          vectorIndex += 1;
        }
        const document: DocumentPayload = {
          type: "document",
          documentId: input.documentId,
          revision: input.revision,
          recipeId,
          blockCount: input.chunks.length,
        };
        operations.push({ type: "insert", vector: emptyVector, payload: document });
      }
      db.commitTransaction(operations);
      publishedDocuments += documentDelta;
      const priorLifecycle = lifecycle;
      const priorCoverage = coverage;
      if (lifecycle === "idle") lifecycle = "building";
      if (coverage === "empty") coverage = "partial";
      scheduleFlush();
      if (documentDelta !== 0 || lifecycle !== priorLifecycle || coverage !== priorCoverage) persistCheckpoint();
      else refreshCheckpoint();
    });
  };

  return {
    scope: options.scope,
    space,
    spaceId,
    recipeId,
    get lifecycle() { return lifecycle; },
    get coverage() { return coverage; },
    get generation() { return generation; },
    checkpoint(): SemanticCheckpoint | null {
      if (!checkpoint) return null;
      refreshCheckpoint();
      return { ...checkpoint };
    },
    markBuilding(kind: "building" | "rebuilding"): void {
      lifecycle = kind;
      if (coverage === "empty") coverage = "partial";
      persistCheckpoint();
    },
    markReady(complete: boolean): void {
      lifecycle = "ready";
      coverage = complete ? "complete" : (publishedDocuments > 0 ? "partial" : "empty");
      persistCheckpoint();
    },
    async publishedRevision(documentId: string): Promise<{ revision: string; recipeId: string } | null> {
      return enqueue(() => {
        if (!existsSync(dbFile()) && !writer) return null;
        const db = writer ?? openDb(dbFile(), space.dim, writer ? "readWrite" : "readOnly");
        try {
          const ids = lookupDocuments(db, documentId);
          const payload = ids[0] !== undefined ? db.getPayload(ids[0]) as DocumentPayload | null : null;
          return payload ? { revision: payload.revision, recipeId: payload.recipeId } : null;
        } finally {
          if (db !== writer) db.close();
        }
      });
    },
    publishDocument(input: SemanticDocumentPublication): Promise<void> {
      return publishDocuments([input]);
    },
    publishDocuments(inputs: readonly SemanticDocumentPublication[]): Promise<void> {
      return publishDocuments(inputs);
    },
    async removeDocument(documentId: string): Promise<void> {
      await enqueue(() => {
        if (!existsSync(dbFile()) && !writer) return;
        const db = ensureWriter();
        const operations: import("triviumdb").TransactionOperation[] = [];
        const oldDocuments = lookupDocuments(db, documentId);
        for (const id of [...lookupBlocks(db, documentId), ...oldDocuments]) {
          operations.push({ type: "delete", id });
        }
        if (operations.length === 0) return;
        db.commitTransaction(operations);
        publishedDocuments = Math.max(0, publishedDocuments - oldDocuments.length);
        scheduleFlush();
        if (oldDocuments.length > 0) persistCheckpoint();
      });
    },
    async search(query: number[], limit: number): Promise<SemanticHit[]> {
      return enqueue(() => {
        if (!existsSync(dbFile()) && !writer) return [];
        const db = writer ?? openDb(dbFile(), space.dim, writer ? "readWrite" : "readOnly");
        try {
          let hits: Array<{ id: number; score: number; payload: BlockPayload }>;
          try {
            hits = db.searchExact(query, Math.max(limit * 4, limit)).map((hit) => ({
              id: hit.id,
              score: hit.score,
              payload: hit.payload as BlockPayload,
            }));
          } catch {
            hits = [];
            for (const id of db.indexedLookup({ type: "block" }, maximumLookupResults(db))) {
              const node = db.get(id);
              if (!node) continue;
              const payload = node.payload as BlockPayload;
              if (payload.type !== "block") continue;
              hits.push({ id, score: cosineSimilarity(query, node.vector), payload });
            }
            hits.sort((left, right) => right.score - left.score);
          }
          const ranked = hits
            .filter((hit) => hit.payload?.type === "block")
            .slice(0, limit);
          return ranked.map((hit, index) => ({
            documentId: hit.payload.documentId,
            revision: hit.payload.revision,
            blockId: hit.payload.blockId,
            parentUnitId: hit.payload.parentUnitId,
            parentName: hit.payload.parentName,
            parentKind: hit.payload.parentKind,
            startLine: hit.payload.startLine,
            endLine: hit.payload.endLine,
            contentHash: hit.payload.contentHash,
            fallback: hit.payload.fallback,
            body: typeof hit.payload.body === "string" ? hit.payload.body : "",
            similarity: hit.score,
            rank: index + 1,
            scope: options.scope,
            spaceId,
            generation,
          }));
        } finally {
          if (db !== writer) db.close();
        }
      });
    },
    async close(): Promise<void> {
      if (disposed) return;
      disposed = true;
      await enqueue(() => {
        flushNow();
        writer?.flush();
        writer?.close();
        writer = null;
      });
    },
  };
}

export type SemanticGenerationStore = ReturnType<typeof createSemanticGenerationStore>;

export const spaceIdentityOf = (space: VectorSpaceIdentity): string => spaceIdOf(space);
