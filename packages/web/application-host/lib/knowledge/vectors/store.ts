/**
 * Derived knowledge vectors. Separate from the authoritative workspace/user
 * .tdb so a model/dimension change cannot reopen or rewrite other knowledge
 * nodes (D-196).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { embedTextKey, spaceIdOf, type VectorSpaceIdentity } from "../semantic/identity.js";
import { cosineSimilarity } from "../semantic/embedder.js";
import { knowledgeVectorSpaceDir } from "./identity.js";
import type { KnowledgeScope } from "../store.js";

const require = createRequire(import.meta.url);
const { TriviumDB } = require("triviumdb") as typeof import("triviumdb");

type KnowledgeVectorPayload = {
  type: "knowledge-vector";
  knowledgeId: number;
  contentRevision: string;
  embedText: string;
  embedKey: string;
  publishToken: number;
};

export type KnowledgeVectorHit = {
  knowledgeId: number;
  contentRevision: string;
  similarity: number;
  rank: number;
  spaceId: string;
};

const checkpointPath = (dir: string): string => join(dir, "checkpoint.json");

export function createKnowledgeVectorStore(options: {
  dataDir: string;
  hostId: string;
  scope: KnowledgeScope;
  scopeId: string;
  space: VectorSpaceIdentity;
}) {
  const spaceId = spaceIdOf(options.space);
  if (options.space.dim <= 0) {
    throw new Error("Knowledge vector store requires a resolved embedding dimension.");
  }
  const dir = knowledgeVectorSpaceDir(options.dataDir, options.hostId, options.scope, options.scopeId, spaceId);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const dbFile = join(dir, "vectors.tdb");
  const db = new TriviumDB(dbFile, { dim: options.space.dim, syncMode: "normal", payloadCacheMb: 0 });
  const tokens = new Map<number, number>();
  const idByKnowledge = new Map<number, number>();

  const loadIndex = (): void => {
    idByKnowledge.clear();
    for (const id of db.allNodeIds()) {
      const payload = db.getPayload(id) as KnowledgeVectorPayload | null;
      if (!payload || payload.type !== "knowledge-vector") continue;
      idByKnowledge.set(payload.knowledgeId, id);
      tokens.set(payload.knowledgeId, Math.max(tokens.get(payload.knowledgeId) ?? 0, payload.publishToken));
    }
  };
  loadIndex();

  const persistCheckpoint = (): void => {
    const tmp = `${checkpointPath(dir)}.tmp`;
    writeFileSync(tmp, JSON.stringify({ spaceId, published: idByKnowledge.size }), "utf-8");
    renameSync(tmp, checkpointPath(dir));
  };

  return {
    spaceId,
    get published() { return idByKnowledge.size; },
    nextToken(knowledgeId: number): number {
      const next = (tokens.get(knowledgeId) ?? 0) + 1;
      tokens.set(knowledgeId, next);
      return next;
    },
    currentToken(knowledgeId: number): number {
      return tokens.get(knowledgeId) ?? 0;
    },
    get(knowledgeId: number): KnowledgeVectorPayload | null {
      const id = idByKnowledge.get(knowledgeId);
      if (id === undefined) return null;
      const payload = db.getPayload(id) as KnowledgeVectorPayload | null;
      return payload?.type === "knowledge-vector" ? payload : null;
    },
    publish(input: {
      knowledgeId: number;
      contentRevision: string;
      embedText: string;
      vector: readonly number[];
      publishToken: number;
    }): boolean {
      if (input.vector.length !== options.space.dim) return false;
      if (input.publishToken < (tokens.get(input.knowledgeId) ?? 0)) return false;
      tokens.set(input.knowledgeId, input.publishToken);
      const payload: KnowledgeVectorPayload = {
        type: "knowledge-vector",
        knowledgeId: input.knowledgeId,
        contentRevision: input.contentRevision,
        embedText: input.embedText,
        embedKey: embedTextKey(input.embedText),
        publishToken: input.publishToken,
      };
      const existing = idByKnowledge.get(input.knowledgeId);
      if (existing !== undefined) db.delete(existing);
      const id = db.insert([...input.vector], payload);
      idByKnowledge.set(input.knowledgeId, id);
      db.flush();
      persistCheckpoint();
      return true;
    },
    remove(knowledgeId: number): void {
      const existing = idByKnowledge.get(knowledgeId);
      if (existing === undefined) return;
      db.delete(existing);
      idByKnowledge.delete(knowledgeId);
      db.flush();
      persistCheckpoint();
    },
    publishedIds(): number[] {
      return [...idByKnowledge.keys()];
    },
    search(query: number[], allowedIds: ReadonlySet<number>, limit: number): KnowledgeVectorHit[] {
      if (query.length !== options.space.dim) {
        throw new Error(`Knowledge query vector has dimension ${query.length}; expected ${options.space.dim}.`);
      }
      const hits: Array<{ knowledgeId: number; contentRevision: string; similarity: number }> = [];
      for (const knowledgeId of allowedIds) {
        const nodeId = idByKnowledge.get(knowledgeId);
        if (nodeId === undefined) continue;
        const node = db.get(nodeId);
        const payload = node?.payload as KnowledgeVectorPayload | undefined;
        if (!node || payload?.type !== "knowledge-vector") continue;
        hits.push({
          knowledgeId,
          contentRevision: payload.contentRevision,
          similarity: cosineSimilarity(query, node.vector),
        });
      }
      return hits
        .sort((left, right) => right.similarity - left.similarity)
        .slice(0, limit)
        .map((hit, index) => ({ ...hit, rank: index + 1, spaceId }));
    },
    close(): void {
      db.flush();
      db.close();
    },
    readCheckpoint(): { spaceId: string; published: number } | null {
      if (!existsSync(checkpointPath(dir))) return null;
      try {
        return JSON.parse(readFileSync(checkpointPath(dir), "utf-8")) as { spaceId: string; published: number };
      } catch {
        return null;
      }
    },
  };
}

export type KnowledgeVectorStore = ReturnType<typeof createKnowledgeVectorStore>;
