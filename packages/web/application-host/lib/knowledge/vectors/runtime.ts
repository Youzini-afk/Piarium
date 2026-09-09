/**
 * Background knowledge-vector builder. Authority writes finish first; this
 * runtime only publishes derived vectors and never writes the .tdb.
 */

import { spaceIdOf, type VectorSpaceIdentity } from "../semantic/identity.js";
import type { SemanticEmbedder } from "../semantic/embedder.js";
import type { EmbedScheduler } from "../semantic/embed-scheduler.js";
import type { SemanticVectorCache } from "../semantic/vector-cache.js";
import type { Knowledge, KnowledgeScope, KnowledgeStore, NodeId } from "../store.js";
import { createKnowledgeVectorStore, type KnowledgeVectorHit, type KnowledgeVectorStore } from "./store.js";
import { knowledgeContentRevision, knowledgeEmbedText } from "./identity.js";

export type KnowledgeVectorStatus = "unconfigured" | "unavailable" | "failed" | "empty" | "partial" | "used";

export type KnowledgeEmbedderResolution =
  | { status: "unconfigured" }
  | { status: "unavailable" | "invalid" | "failed"; message?: string }
  | { status: "ready"; embedder: SemanticEmbedder };

const eligible = (item: Knowledge, scope: KnowledgeScope): boolean => (
  item.scope === scope && item.status === "accepted" && item.invalidAt === undefined
);

export function createKnowledgeVectorRuntime(options: {
  dataDir: string;
  hostId: string;
  scheduler: EmbedScheduler;
  cache: SemanticVectorCache;
  resolveEmbedder: (workspaceId: string) => Promise<KnowledgeEmbedderResolution>;
}) {
  const stores = new Map<string, KnowledgeVectorStore>();
  const builds = new Map<string, Promise<void>>();

  const storeKey = (scope: KnowledgeScope, scopeId: string, spaceId: string): string => (
    `${scope}:${scopeId}:${spaceId}`
  );

  const storeFor = (scope: KnowledgeScope, scopeId: string, space: VectorSpaceIdentity): KnowledgeVectorStore => {
    const key = storeKey(scope, scopeId, spaceIdOf(space));
    const existing = stores.get(key);
    if (existing) return existing;
    const created = createKnowledgeVectorStore({
      dataDir: options.dataDir,
      hostId: options.hostId,
      scope,
      scopeId,
      space,
    });
    stores.set(key, created);
    return created;
  };

  const embedTextOf = async (
    embedder: SemanticEmbedder,
    purpose: "document" | "query",
    text: string,
    signal?: AbortSignal,
  ): Promise<number[]> => {
    const spaceId = spaceIdOf(embedder.space);
    const cached = options.cache.get({ spaceId, purpose, embedText: text });
    if (cached) return cached;
    const claim = options.cache.claim({ spaceId, purpose, embedText: text });
    if (!claim.owner) return claim.promise;
    try {
      const vectors = await options.scheduler.enqueue(
        purpose === "query" ? "foreground" : "background",
        () => embedder.embed([text], {
          purpose,
          ...(signal ? { signal } : {}),
        }),
      );
      const vector = vectors[0];
      if (!vector) throw new Error("Knowledge embedder returned no vector.");
      claim.resolve(vector);
      options.cache.set({ spaceId, purpose, embedText: text }, vector);
      return vector;
    } catch (error) {
      claim.reject(error);
      throw error;
    }
  };

  const publishOne = async (
    store: KnowledgeVectorStore,
    item: Knowledge,
    embedder: SemanticEmbedder,
    signal?: AbortSignal,
  ): Promise<void> => {
    const embedText = knowledgeEmbedText(item.content, item.trigger);
    const contentRevision = knowledgeContentRevision(item.content, item.trigger);
    const published = store.get(item.id);
    if (published && published.contentRevision === contentRevision && published.embedText === embedText) {
      return;
    }
    const token = store.nextToken(item.id);
    const vector = await embedTextOf(embedder, "document", embedText, signal);
    if (spaceIdOf(embedder.space) !== store.spaceId) return;
    if (store.currentToken(item.id) !== token) return;
    store.publish({
      knowledgeId: item.id,
      contentRevision,
      embedText,
      vector,
      publishToken: token,
    });
  };

  const reconcile = async (
    authority: KnowledgeStore,
    scope: KnowledgeScope,
    scopeId: string,
    embedder: SemanticEmbedder,
    signal?: AbortSignal,
  ): Promise<KnowledgeVectorStore | undefined> => {
    if (embedder.status !== "ready" || embedder.space.dim <= 0) return undefined;
    const store = storeFor(scope, scopeId, embedder.space);
    const accepted = (await authority.listKnowledge({ status: "accepted", activeOnly: true }))
      .filter((item) => eligible(item, scope));
    const allowed = new Set(accepted.map((item) => item.id));
    for (const id of store.publishedIds()) {
      if (!allowed.has(id)) store.remove(id);
    }
    for (const item of accepted) {
      signal?.throwIfAborted();
      await publishOne(store, item, embedder, signal);
    }
    return store;
  };

  const scheduleReconcile = (
    authority: KnowledgeStore,
    scope: KnowledgeScope,
    scopeId: string,
    workspaceId: string,
  ): void => {
    const key = `${scope}:${scopeId}:${workspaceId}`;
    const pending = builds.get(key);
    const run = (async () => {
      if (pending) await pending.catch(() => undefined);
      const resolved = await options.resolveEmbedder(workspaceId);
      if (resolved.status !== "ready") return;
      await reconcile(authority, scope, scopeId, resolved.embedder);
    })();
    builds.set(key, run);
    void run.finally(() => {
      if (builds.get(key) === run) builds.delete(key);
    });
  };

  const search = async (input: {
    authority: KnowledgeStore;
    scope: KnowledgeScope;
    scopeId: string;
    workspaceId: string;
    query: string;
    limit: number;
    signal?: AbortSignal;
  }): Promise<{ status: KnowledgeVectorStatus; spaceId?: string; hits: KnowledgeVectorHit[] }> => {
    const resolved = await options.resolveEmbedder(input.workspaceId);
    if (resolved.status === "unconfigured") return { status: "unconfigured", hits: [] };
    if (resolved.status !== "ready") return { status: resolved.status === "failed" ? "failed" : "unavailable", hits: [] };
    const embedder = resolved.embedder;
    if (embedder.status !== "ready") return { status: "unavailable", hits: [] };
    try {
      if (embedder.space.dim <= 0) {
        await embedTextOf(embedder, "query", input.query, input.signal);
      }
      if (embedder.space.dim <= 0) return { status: "empty", hits: [] };
      const store = storeFor(input.scope, input.scopeId, embedder.space);
      const accepted = (await input.authority.listKnowledge({ status: "accepted", activeOnly: true }))
        .filter((item) => eligible(item, input.scope));
      const allowed = new Set(accepted.map((item) => item.id));
      const queryVector = await embedTextOf(embedder, "query", input.query, input.signal);
      const hits = store.search(queryVector, allowed, input.limit)
        .filter((hit) => {
          const item = accepted.find((row) => row.id === hit.knowledgeId);
          return item !== undefined && knowledgeContentRevision(item.content, item.trigger) === hit.contentRevision;
        });
      const status: KnowledgeVectorStatus = hits.length === 0 && store.published === 0
        ? (accepted.length === 0 ? "empty" : "partial")
        : store.published < accepted.length ? "partial" : "used";
      return { status, spaceId: store.spaceId, hits };
    } catch (error) {
      if (input.signal?.aborted) throw error;
      return { status: "failed", hits: [] };
    }
  };

  return {
    scheduleReconcile,
    notify(authority: KnowledgeStore, scope: KnowledgeScope, scopeId: string, workspaceId: string, _ids: readonly NodeId[]): void {
      scheduleReconcile(authority, scope, scopeId, workspaceId);
    },
    search,
    waitForBuild(scope: KnowledgeScope, scopeId: string, workspaceId: string): Promise<void> {
      return builds.get(`${scope}:${scopeId}:${workspaceId}`) ?? Promise.resolve();
    },
    close(): void {
      for (const store of stores.values()) store.close();
      stores.clear();
    },
  };
}

export type KnowledgeVectorRuntime = ReturnType<typeof createKnowledgeVectorRuntime>;
