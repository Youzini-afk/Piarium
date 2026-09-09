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
import { workspaceScope, type SemanticScopeKey } from "./identity.js";
import {
  createSemanticGenerationStore,
  type SemanticDocumentPublication,
  type SemanticGenerationStore,
  type SemanticHit,
} from "./store.js";

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
  onError?: (error: unknown) => void;
}

export function createSemanticIndexRuntime(options: SemanticIndexRuntimeOptions) {
  const stores = new Map<string, SemanticGenerationStore>();
  const pending = new Set<Promise<void>>();
  const scanControllers = new Map<string, AbortController>();
  let disposed = false;

  const scopeKey = (scope: SemanticScopeKey): string => `${scope.scopeKind}\0${scope.scopeId}`;

  const storeFor = (scope: SemanticScopeKey): SemanticGenerationStore => {
    const key = scopeKey(scope);
    const existing = stores.get(key);
    if (existing) return existing;
    const created = createSemanticGenerationStore({
      dataDir: options.dataDir,
      hostId: options.hostId,
      scope,
      embedder: options.embedder,
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

  const prepareDocument = async (
    scope: SemanticScopeKey,
    store: SemanticGenerationStore,
    documentId: string,
  ): Promise<SemanticDocumentPublication | null> => {
    if (scope.scopeKind !== "workspace") return null;
    let snapshot: Awaited<ReturnType<DocumentAuthority["read"]>>;
    try {
      snapshot = await options.documents.read({ workspaceId: scope.scopeId, resourceId: documentId });
    } catch {
      return null;
    }
    if (snapshot.status !== "ready") return null;
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
    const chunks = chunkDocument({
      documentId,
      text: snapshot.content,
      languageId,
      outline,
      maxTokens: options.embedder.space.maxTokens,
      countTokens: (text) => options.embedder.countTokens(text),
    });
    return { documentId, revision: snapshot.revision, chunks };
  };

  const indexDocument = async (scope: SemanticScopeKey, documentId: string, kind: "modified" | "deleted"): Promise<void> => {
    if (disposed || options.embedder.status !== "ready") return;
    const store = storeFor(scope);
    if (kind === "deleted") {
      await store.removeDocument(documentId);
      return;
    }
    await options.embedder.prepare();
    const publication = await prepareDocument(scope, store, documentId);
    if (publication) await store.publishDocument(publication);
  };

  const observeDocumentMutation = (event: DocumentMutationObservation): void => {
    if (disposed) return;
    const languageId = languageIdForPath(event.resourceId);
    if (!languageId || !SEMANTIC_SCAN_LANGUAGES.has(languageId)) return;
    track(indexDocument(workspaceScope(event.workspaceId), event.resourceId, event.kind === "deleted" ? "deleted" : "modified"));
  };

  const scanScope = async (scope: SemanticScopeKey, optionsForScan?: SemanticScanOptions): Promise<void> => {
    if (disposed || !options.searchFilesystemFiles || options.embedder.status !== "ready") return;
    if (scope.scopeKind !== "workspace") return;
    const key = scopeKey(scope);
    scanControllers.get(key)?.abort();
    const controller = new AbortController();
    scanControllers.set(key, controller);
    const signal = optionsForScan?.signal
      ? AbortSignal.any([controller.signal, optionsForScan.signal])
      : controller.signal;
    const store = storeFor(scope);
    store.markBuilding(store.lifecycle === "ready" ? "rebuilding" : "building");
    try {
      await options.embedder.prepare();
      let root: string;
      try {
        root = (await options.documents.inspectWorkspace(scope.scopeId)).root;
      } catch {
        return;
      }
      const files = await options.searchFilesystemFiles(root, {
        query: "",
        respectGitignore: true,
        signal,
      });
      if (signal.aborted) return;
      const catalog = files.filter((file) => SEMANTIC_SCAN_LANGUAGES.has(languageIdForPath(file.relativePath) ?? ""));
      for (let offset = 0; offset < catalog.length; offset += CATALOG_SCAN_BATCH) {
        if (disposed || signal.aborted) return;
        const batch = catalog.slice(offset, offset + CATALOG_SCAN_BATCH);
        const publications = await Promise.all(batch.map((file) => (
          prepareDocument(scope, store, file.relativePath)
        )));
        if (disposed || signal.aborted) return;
        await store.publishDocuments(publications.filter((publication): publication is SemanticDocumentPublication => publication !== null));
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
      if (!disposed && !signal.aborted) store.markReady(true);
    } catch (error) {
      if (signal.aborted || disposed) return;
      try { options.onError?.(error); } catch { /* catalog failures stay observational */ }
    } finally {
      if (scanControllers.get(key) === controller) scanControllers.delete(key);
    }
  };

  const statusFor = (scope: SemanticScopeKey): SemanticIndexStatus => {
    if (options.embedder.status !== "ready") {
      return {
        status: "unavailable",
        coverage: "empty",
        lifecycle: "idle",
        generation: null,
        spaceId: null,
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

  const search = async (
    scope: SemanticScopeKey,
    question: string,
    limit: number,
    searchOptions?: { signal?: AbortSignal },
  ): Promise<{
    status: SemanticIndexStatus;
    hits: SemanticHit[];
  }> => {
    const signal = searchOptions?.signal;
    signal?.throwIfAborted();
    const status = statusFor(scope);
    if (status.status === "unavailable") return { status, hits: [] };
    try {
      await waitWithSignal(options.embedder.prepare(), signal);
      signal?.throwIfAborted();
      const [vector] = await waitWithSignal(options.embedder.embed([question]), signal);
      signal?.throwIfAborted();
      const store = storeFor(scope);
      const hits = vector ? await waitWithSignal(store.search(vector, limit), signal) : [];
      signal?.throwIfAborted();
      return {
        status: {
          ...status,
          status: hits.length === 0 ? "empty" : "ready",
          coverage: store.coverage,
          lifecycle: store.lifecycle,
          generation: store.generation,
        },
        hits,
      };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw error;
      try { options.onError?.(error); } catch { /* query failure is a status */ }
      return { status: { ...status, status: "failed" }, hits: [] };
    }
  };

  const drain = async (): Promise<void> => {
    while (pending.size > 0) await Promise.allSettled([...pending]);
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
  };
}

export type SemanticIndexRuntime = ReturnType<typeof createSemanticIndexRuntime>;
