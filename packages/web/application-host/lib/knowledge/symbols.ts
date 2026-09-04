/** Event-driven file/symbol graph projection owned by the Application Host. */

import type {
  KnowledgeStore,
  SymbolGraphSymbolInput,
} from "./store.js";

export interface SymbolCollectorDeps {
  store: Pick<KnowledgeStore, "touchFile" | "replaceFileSymbols" | "removeFileSymbols">;
  getDocumentSymbols(path: string, language: string): Promise<SymbolGraphSymbolInput[] | null>;
  getLanguage(path: string): string | null;
  onError?: (error: unknown) => void;
}

export interface SymbolDocumentChange {
  path: string;
  kind: "created" | "modified" | "deleted";
}

/**
 * Replaces one file graph at a time. A null LSP result means unavailable and
 * preserves the last known symbols while refreshing the file fact; an empty
 * array is an authoritative successful result and removes stale symbols.
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
    const symbols = await deps.getDocumentSymbols(change.path, language);
    if (symbols === null) await deps.store.touchFile(change.path, language);
    else await deps.store.replaceFileSymbols(change.path, language, symbols);
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
