/**
 * Background semantic index. Bound by the Host to a workspace scope, not to a
 * chat session. Incremental updates follow Documents revisions (D-107 / D-140).
 */

import type { DocumentAuthority, DocumentMutationObservation } from "../../documents/authority.js";
import type { FileSearchItem } from "../../fs/types.js";
import { languageIdForPath } from "../../harness/language-id.js";
import { TREE_SITTER_LANGUAGE_SPECS } from "../../structure/languages.js";
import type { StructureSource } from "../../structure/types.js";
import { CATALOG_SCAN_BATCH } from "../symbol-runtime.js";
import { chunkDocument } from "./chunker.js";
import type { SemanticEmbedder } from "./embedder.js";
import { createEmbedScheduler, type EmbedScheduler } from "./embed-scheduler.js";
import { workspaceScope, spaceIdOf, type SemanticScopeKey } from "./identity.js";
import {
  createSemanticGenerationStore,
  type SemanticDocumentPublication,
  type SemanticGenerationStore,
  type SemanticHit,
  type SemanticOverlayBlock,
} from "./store.js";
import { createVectorCache, type SemanticVectorCache } from "./vector-cache.js";

export const SEMANTIC_SCAN_LANGUAGES: ReadonlySet<string> = new Set(Object.keys(TREE_SITTER_LANGUAGE_SPECS));

export type SemanticQueryStatus = "not-requested" | "ready" | "empty" | "unavailable" | "failed" | "stale";

export type SemanticIndexStatus = {
  status: SemanticQueryStatus;
  coverage: "empty" | "partial" | "complete";
  lifecycle: "idle" | "building" | "rebuilding" | "ready";
  generation: string | null;
  spaceId: string | null;
  scope: SemanticScopeKey;
};

export type SemanticScanBatchProgress = {
  processedFiles: number;
  totalFiles: number;
  publishedDocuments: number;
};

export type SemanticScanOptions = {
  signal?: AbortSignal;
  onBatchComplete?: (progress: SemanticScanBatchProgress) => void;
};

export type SemanticQueryOverlay = {
  path: string;
  content: string | null;
  revision: string;
  origin: "surface-draft" | "thread";
  gap?: "draft-vector-pending" | "draft-unavailable" | "thread-vector-pending";
};

export type SemanticSearchRequest = {
  signal?: AbortSignal;
  roots?: readonly string[];
  overlays?: readonly SemanticQueryOverlay[];
  view?: "disk" | "working-state";
  waitForFirstPublish?: boolean;
};

export type SemanticSearchResult = {
  status: SemanticIndexStatus;
  hits: SemanticHit[];
  gaps: Array<{ path: string; reason: "draft-vector-pending" | "draft-unavailable" | "thread-vector-pending" }>;
};

const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => {
  setTimeout(resolve, 0);
});

const waitWithSignal = <T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> => {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener("abort", onAbort);
      try {
        signal.throwIfAborted();
      } catch (error) {
        reject(error);
      }
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
};

export interface SemanticIndexRuntimeOptions {
  dataDir: string;
  hostId: string;
  documents: Pick<DocumentAuthority, "read" | "inspectWorkspace">;
  structureSource: StructureSource;
  searchFilesystemFiles?: (
    rootPath: string,
    options: { query: string; respectGitignore?: boolean; signal?: AbortSignal },
  ) => Promise<FileSearchItem[]>;
  embedder: SemanticEmbedder;
  getEmbedder?: () => SemanticEmbedder;
  onError?: (error: unknown) => void;
  vectorCache?: SemanticVectorCache;
  scheduler?: EmbedScheduler;
}

export function createSemanticIndexRuntime(options: SemanticIndexRuntimeOptions) {
  const stores = new Map<string, SemanticGenerationStore>();
  const pending = new Set<Promise<void>>();
  const scanControllers = new Map<string, AbortController>();
  const inFlightScans = new Map<string, Promise<void>>();
  const firstPublish = new Map<string, { promise: Promise<void>; resolve: () => void; resolved: boolean }>();
  const documentTokens = new Map<string, number>();
  const queryCache = options.vectorCache ?? createVectorCache();
  const scheduler = options.scheduler ?? createEmbedScheduler();
  let disposed = false;

  const embedderOf = (): SemanticEmbedder => options.getEmbedder?.() ?? options.embedder;

  const ensureEmbedderSpace = async (signal?: AbortSignal): Promise<SemanticEmbedder> => {
    const embedder = embedderOf();
    if (embedder.status !== "ready" || embedder.space.dim > 0) return embedder;
    await waitWithSignal(embedder.prepare(), signal);
    await waitWithSignal(scheduler.enqueue("foreground", async () => (
      embedder.embed(["."], { purpose: "document", ...(signal ? { signal } : {}) })
    )), signal);
    return embedderOf();
  };

  const scopeKey = (scope: SemanticScopeKey, spaceId?: string): string => (
    `${scope.scopeKind}\0${scope.scopeId}\0${spaceId ?? spaceIdOf(embedderOf().space)}`
  );

  const firstPublishGate = (key: string) => {
    const existing = firstPublish.get(key);
    if (existing) return existing;
    let resolve = (): void => undefined;
    const created = {
      resolved: false,
      resolve: (): void => undefined,
      promise: new Promise<void>((done) => {
        resolve = () => {
          created.resolved = true;
          done();
        };
      }),
    };
    created.resolve = resolve;
    firstPublish.set(key, created);
    return created;
  };

  const storeFor = (scope: SemanticScopeKey): SemanticGenerationStore => {
    const embedder = embedderOf();
    if (embedder.space.dim <= 0) {
      throw new Error("Semantic store requires a known vector dimension.");
    }
    const key = scopeKey(scope);
    const existing = stores.get(key);
    if (existing) return existing;
    const created = createSemanticGenerationStore({
      dataDir: options.dataDir,
      hostId: options.hostId,
      scope,
      embedder,
      vectorCache: queryCache,
      scheduler,
    });
    stores.set(key, created);
    return created;
  };

  const track = (task: Promise<void>): void => {
    pending.add(task);
    void task.catch((error) => {
      try { options.onError?.(error); } catch { /* diagnostics cannot break observation */ }
    }).finally(() => pending.delete(task));
  };

  const nextToken = (scope: SemanticScopeKey, documentId: string): number => {
    const key = `${scopeKey(scope, "token")}\0${documentId}`;
    const next = (documentTokens.get(key) ?? 0) + 1;
    documentTokens.set(key, next);
    return next;
  };

  const isCurrentToken = (scope: SemanticScopeKey, documentId: string, token: number): boolean => {
    const key = `${scopeKey(scope, "token")}\0${documentId}`;
    return documentTokens.get(key) === token;
  };

  const prepareDocument = async (
    scope: SemanticScopeKey,
    store: SemanticGenerationStore,
    documentId: string,
    token: number,
  ): Promise<SemanticDocumentPublication | null> => {
    if (scope.scopeKind !== "workspace") return null;
    let snapshot: Awaited<ReturnType<DocumentAuthority["read"]>>;
    try {
      snapshot = await options.documents.read({ workspaceId: scope.scopeId, resourceId: documentId });
    } catch {
      return null;
    }
    if (snapshot.status !== "ready") return null;
    if (!isCurrentToken(scope, documentId, token)) return null;
    const published = await store.publishedRevision(documentId);
    if (published?.revision === snapshot.revision && published.recipeId === store.recipeId) return null;
    const languageId = languageIdForPath(documentId) ?? null;
    const outline = languageId
      ? await options.structureSource.outline({
        path: documentId,
        languageId,
        text: snapshot.content,
        revision: snapshot.revision,
      })
      : { status: "unsupported" as const, symbols: [] };
    if (!isCurrentToken(scope, documentId, token)) return null;
    const embedder = embedderOf();
    const chunks = chunkDocument({
      documentId,
      text: snapshot.content,
      languageId,
      outline,
      maxTokens: embedder.space.maxTokens,
      countTokens: (text) => embedder.countTokens(text),
    });
    return { documentId, revision: snapshot.revision, chunks, publishToken: token };
  };

  const indexDocument = async (scope: SemanticScopeKey, documentId: string, kind: "modified" | "deleted"): Promise<void> => {
    const embedder = await ensureEmbedderSpace();
    if (disposed || embedder.status !== "ready") return;
    const store = storeFor(scope);
    if (kind === "deleted") {
      await store.removeDocument(documentId);
      return;
    }
    const token = nextToken(scope, documentId);
    await embedder.prepare();
    const publication = await prepareDocument(scope, store, documentId, token);
    if (publication && isCurrentToken(scope, documentId, token)) {
      await store.publishDocument(publication);
      firstPublishGate(scopeKey(scope)).resolve();
    }
  };

  const observeDocumentMutation = (event: DocumentMutationObservation): void => {
    if (disposed) return;
    const languageId = languageIdForPath(event.resourceId);
    if (!languageId || !SEMANTIC_SCAN_LANGUAGES.has(languageId)) return;
    track(indexDocument(workspaceScope(event.workspaceId), event.resourceId, event.kind === "deleted" ? "deleted" : "modified"));
  };

  const scanScope = async (scope: SemanticScopeKey, optionsForScan?: SemanticScanOptions): Promise<void> => {
    if (disposed || !options.searchFilesystemFiles || embedderOf().status !== "ready") return;
    if (scope.scopeKind !== "workspace") return;
    const key = scopeKey(scope);
    const existing = inFlightScans.get(key);
    if (existing) return existing;
    const run = (async () => {
      await ensureEmbedderSpace(optionsForScan?.signal);
      scanControllers.get(key)?.abort();
      const controller = new AbortController();
      scanControllers.set(key, controller);
      const signal = optionsForScan?.signal
        ? AbortSignal.any([controller.signal, optionsForScan.signal])
        : controller.signal;
      const store = storeFor(scope);
      store.markBuilding(store.lifecycle === "ready" ? "rebuilding" : "building");
      try {
        await embedderOf().prepare();
        let root: string;
        try {
          root = (await options.documents.inspectWorkspace(scope.scopeId)).root;
        } catch {
          return;
        }
        const files = await options.searchFilesystemFiles!(root, {
          query: "",
          respectGitignore: true,
          signal,
        });
        if (signal.aborted) return;
        const catalog = files.filter((file) => SEMANTIC_SCAN_LANGUAGES.has(languageIdForPath(file.relativePath) ?? ""));
        const catalogIds = new Set(catalog.map((file) => file.relativePath));
        for (let offset = 0; offset < catalog.length; offset += CATALOG_SCAN_BATCH) {
          if (disposed || signal.aborted) return;
          const batch = catalog.slice(offset, offset + CATALOG_SCAN_BATCH);
          const publications = await Promise.all(batch.map((file) => (
            prepareDocument(scope, store, file.relativePath, nextToken(scope, file.relativePath))
          )));
          if (disposed || signal.aborted) return;
          const accepted = publications.filter((publication): publication is SemanticDocumentPublication => publication !== null);
          if (accepted.length > 0) {
            await store.publishDocuments(accepted);
            firstPublishGate(key).resolve();
          }
          try {
            optionsForScan?.onBatchComplete?.({
              processedFiles: offset + batch.length,
              totalFiles: catalog.length,
              publishedDocuments: store.checkpoint()?.publishedDocuments ?? 0,
            });
          } catch {
            // Performance/diagnostic observers cannot break indexing.
          }
          await yieldToEventLoop();
        }
        if (!disposed && !signal.aborted) {
          const published = await store.listDocumentIds();
          await Promise.all(published
            .filter((documentId) => !catalogIds.has(documentId))
            .map((documentId) => store.removeDocument(documentId)));
          store.markReady(true);
        }
      } catch (error) {
        if (signal.aborted || disposed) return;
        try { options.onError?.(error); } catch { /* catalog failures stay observational */ }
      } finally {
        if (scanControllers.get(key) === controller) scanControllers.delete(key);
      }
    })();
    inFlightScans.set(key, run);
    void run.finally(() => {
      if (inFlightScans.get(key) === run) inFlightScans.delete(key);
    });
    return run;
  };

  const statusFor = (scope: SemanticScopeKey): SemanticIndexStatus => {
    if (embedderOf().status !== "ready") {
      return {
        status: "unavailable",
        coverage: "empty",
        lifecycle: "idle",
        generation: null,
        spaceId: null,
        scope,
      };
    }
    if (embedderOf().space.dim <= 0) {
      return {
        status: "empty",
        coverage: "empty",
        lifecycle: "idle",
        generation: null,
        spaceId: spaceIdOf(embedderOf().space),
        scope,
      };
    }
    const store = stores.get(scopeKey(scope)) ?? storeFor(scope);
    const checkpoint = store.checkpoint();
    const coverage = checkpoint?.coverage ?? store.coverage;
    return {
      status: coverage === "empty" ? "empty" : "ready",
      coverage,
      lifecycle: store.lifecycle,
      generation: store.generation,
      spaceId: store.spaceId,
      scope,
    };
  };

  const overlayBlocks = async (
    overlays: readonly SemanticQueryOverlay[],
    signal?: AbortSignal,
  ): Promise<{ extras: SemanticOverlayBlock[]; gaps: SemanticSearchResult["gaps"] }> => {
    const embedder = embedderOf();
    const extras: SemanticOverlayBlock[] = [];
    const gaps: SemanticSearchResult["gaps"] = [];
    for (const overlay of overlays) {
      if (overlay.content === null) {
        if (overlay.gap) gaps.push({ path: overlay.path, reason: overlay.gap });
        continue;
      }
      const languageId = languageIdForPath(overlay.path) ?? null;
      const outline = languageId
        ? await options.structureSource.outline({
          path: overlay.path,
          languageId,
          text: overlay.content,
          revision: overlay.revision,
        })
        : { status: "unsupported" as const, symbols: [] };
      const chunks = chunkDocument({
        documentId: overlay.path,
        text: overlay.content,
        languageId,
        outline,
        maxTokens: embedder.space.maxTokens,
        countTokens: (text) => embedder.countTokens(text),
      });
      const vectors: number[][] = [];
      const missing: Array<{ chunk: typeof chunks[number]; index: number }> = [];
      for (const [index, chunk] of chunks.entries()) {
        const cached = queryCache.get({ spaceId: spaceIdOf(embedder.space), purpose: "document", embedText: chunk.embedText });
        if (cached) vectors[index] = cached;
        else missing.push({ chunk, index });
      }
      if (missing.length > 0) {
        try {
          signal?.throwIfAborted();
          const fresh = await waitWithSignal(scheduler.enqueue("foreground", async () => {
            await embedder.prepare();
            return embedder.embed(missing.map((item) => item.chunk.embedText), { purpose: "document", ...(signal ? { signal } : {}) });
          }), signal);
          for (const [offset, item] of missing.entries()) {
            const vector = fresh[offset]!;
            vectors[item.index] = vector;
            queryCache.set({
              spaceId: spaceIdOf(embedder.space),
              purpose: "document",
              embedText: item.chunk.embedText,
            }, vector);
          }
        } catch (error) {
          if (error instanceof Error && error.name === "AbortError") throw error;
          gaps.push({
            path: overlay.path,
            reason: overlay.origin === "thread" ? "thread-vector-pending" : "draft-unavailable",
          });
          continue;
        }
      }
      if (vectors.some((vector) => !vector)) {
        gaps.push({
          path: overlay.path,
          reason: overlay.origin === "thread" ? "thread-vector-pending" : "draft-vector-pending",
        });
        continue;
      }
      for (const [index, chunk] of chunks.entries()) {
        extras.push({
          documentId: overlay.path,
          revision: overlay.revision,
          blockId: chunk.blockId,
          parentUnitId: chunk.parentUnitId,
          parentName: chunk.parentName,
          parentKind: chunk.parentKind,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          contentHash: chunk.contentHash,
          fallback: chunk.fallback,
          body: chunk.body,
          vector: vectors[index]!,
        });
      }
    }
    return { extras, gaps };
  };

  const search = async (
    scope: SemanticScopeKey,
    question: string,
    limit: number,
    searchOptions?: SemanticSearchRequest,
  ): Promise<SemanticSearchResult> => {
    const signal = searchOptions?.signal;
    signal?.throwIfAborted();
    const embedder = await ensureEmbedderSpace(signal);
    const status = statusFor(scope);
    if (status.status === "unavailable") return { status, hits: [], gaps: [] };
    const key = scopeKey(scope);
    try {
      if (
        searchOptions?.waitForFirstPublish !== false
        && inFlightScans.has(key)
        && !firstPublishGate(key).resolved
      ) {
        await waitWithSignal(firstPublishGate(key).promise, signal);
      }
      signal?.throwIfAborted();
      await waitWithSignal(embedder.prepare(), signal);
      signal?.throwIfAborted();
      const spaceId = spaceIdOf(embedder.space);
      let queryVector = queryCache.get({ spaceId, purpose: "query", embedText: question });
      if (!queryVector) {
        const [vector] = await waitWithSignal(scheduler.enqueue("foreground", async () => (
          embedder.embed([question], { purpose: "query", ...(signal ? { signal } : {}) })
        )), signal);
        signal?.throwIfAborted();
        if (vector) {
          queryVector = vector;
          queryCache.set({ spaceId, purpose: "query", embedText: question }, vector);
        }
      }
      const overlays = searchOptions?.overlays ?? [];
      const maskPaths = overlays.map((overlay) => overlay.path);
      const overlay = overlays.length > 0
        ? await overlayBlocks(overlays, signal)
        : { extras: [] as SemanticOverlayBlock[], gaps: [] as SemanticSearchResult["gaps"] };
      const store = storeFor(scope);
      const hits = queryVector
        ? await waitWithSignal(store.search(queryVector, limit, {
          maskPaths,
          extras: overlay.extras,
          disk: searchOptions?.view !== "working-state",
          ...(searchOptions?.roots === undefined ? {} : { roots: searchOptions.roots }),
        }), signal)
        : [];
      signal?.throwIfAborted();
      return {
        status: {
          ...status,
          status: hits.length === 0 && overlay.gaps.length === 0 ? "empty" : hits.length === 0 && overlay.gaps.length > 0 ? "empty" : "ready",
          coverage: store.coverage,
          lifecycle: store.lifecycle,
          generation: store.generation,
          spaceId: store.spaceId,
        },
        hits,
        gaps: overlay.gaps,
      };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw error;
      try { options.onError?.(error); } catch { /* query failure is a status */ }
      return { status: { ...status, status: "failed" }, hits: [], gaps: [] };
    }
  };

  const drain = async (): Promise<void> => {
    while (pending.size > 0 || inFlightScans.size > 0) {
      await Promise.allSettled([...pending, ...inFlightScans.values()]);
    }
  };

  const dispose = async (): Promise<void> => {
    disposed = true;
    for (const controller of scanControllers.values()) controller.abort();
    scanControllers.clear();
    await drain();
    await Promise.allSettled([...stores.values()].map((store) => store.close()));
    stores.clear();
  };

  return {
    observeDocumentMutation,
    scanScope,
    scanWorkspace: (workspaceId: string, scanOptions?: SemanticScanOptions) => (
      scanScope(workspaceScope(workspaceId), scanOptions)
    ),
    statusFor,
    search,
    drain,
    dispose,
    scheduler,
  };
}

export type SemanticIndexRuntime = ReturnType<typeof createSemanticIndexRuntime>;
