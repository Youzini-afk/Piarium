/** Event-driven file/symbol graph projection owned by the Application Host. */

import type {
  KnowledgeStore,
  SymbolGraphLinkInput,
  SymbolGraphSymbolInput,
} from "./store.js";

/**
 * Identity of everything that turns a file into graph rows: the tree-sitter
 * queries in `structure/queries.ts`, `classifyLiteralCall` in
 * `structure/connections.ts`, and the outline flatten in `symbol-runtime.ts`.
 * Bump it whenever any of those changes what it emits. A file whose disk
 * revision is unchanged but whose stored extractor is older is re-collected by
 * the next catalog scan, so a fixed query actually reaches the graph instead
 * of waiting for every affected file to be edited (D-143).
 *
 * History: 1 = D-105/D-106 first link extraction; 2 = literal-call query pins
 * the string to the first argument and matches awaited generic calls; 3 =
 * preserve gated association candidates as compact file metadata so the gate
 * can be resolved without re-reading the source.
 */
export const CATALOG_EXTRACTOR_VERSION = 3;

export interface CollectedSymbols {
  symbols: SymbolGraphSymbolInput[];
  links?: SymbolGraphLinkInput[];
  /** Association call facts retained compactly for connect-gate re-evaluation. */
  associationCandidates?: SymbolGraphLinkInput[];
  /** Link extraction was blocked, so `links` is a floor rather than the set. */
  linksIncomplete?: boolean;
  /** Disk revision the ranges were computed from. */
  documentRevision: string;
}

export interface SymbolCollectorDeps {
  store: Pick<KnowledgeStore, "touchFile" | "replaceFileSymbols" | "removeFileSymbols">;
  getDocumentSymbols(path: string, language: string, signal?: AbortSignal): Promise<CollectedSymbols | null>;
  getLanguage(path: string): string | null;
  onError?: (error: unknown) => void;
}

export interface SymbolDocumentChange {
  path: string;
  kind: "created" | "modified" | "deleted";
  signal?: AbortSignal;
}

/**
 * Replaces one file graph at a time. A null LSP result means unavailable and
 * preserves the last known symbols while refreshing the file fact; an empty
 * array is an authoritative successful result and removes stale symbols. Ranges
 * are always stored with the disk revision they were computed from (D-087).
 */
export function createSymbolCollector(deps: SymbolCollectorDeps) {
  const tails = new Map<string, Promise<void>>();
  const pending = new Set<Promise<void>>();
  let disposed = false;

  const run = async (change: SymbolDocumentChange): Promise<void> => {
    if (change.kind === "deleted") {
      await deps.store.removeFileSymbols(change.path);
      return;
    }
    const language = deps.getLanguage(change.path) ?? "unknown";
    if (language === "unknown") {
      await deps.store.touchFile(change.path, language);
      return;
    }
    const collected = await deps.getDocumentSymbols(change.path, language, change.signal);
    if (change.signal?.aborted) return;
    if (collected === null) await deps.store.touchFile(change.path, language);
    else await deps.store.replaceFileSymbols(
      change.path,
      language,
      collected.symbols,
      collected.documentRevision,
      collected.links,
      {
        ...(collected.linksIncomplete ? { linksIncomplete: true } : {}),
        ...(collected.associationCandidates ? { associationCandidates: collected.associationCandidates } : {}),
        extractor: CATALOG_EXTRACTOR_VERSION,
      },
    );
  };

  const observe = (change: SymbolDocumentChange): void => {
    if (disposed) return;
    const previous = tails.get(change.path) ?? Promise.resolve();
    const operation = previous.then(() => run(change));
    const settled = operation.catch((error) => {
      try { deps.onError?.(error); } catch { /* diagnostics cannot stop later collection */ }
    }).finally(() => {
      pending.delete(settled);
      if (tails.get(change.path) === settled) tails.delete(change.path);
    });
    tails.set(change.path, settled);
    pending.add(settled);
  };

  const drain = async (): Promise<void> => {
    while (pending.size > 0) await Promise.allSettled([...pending]);
  };

  const dispose = async (): Promise<void> => {
    disposed = true;
    await drain();
    tails.clear();
  };

  return { observe, drain, dispose };
}

export type SymbolCollector = ReturnType<typeof createSymbolCollector>;
