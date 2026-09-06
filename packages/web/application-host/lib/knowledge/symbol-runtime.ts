import type { DocumentMutationObservation } from "../documents/authority.js";
import type { DocumentAuthority } from "../documents/authority.js";
import type { createLanguageSupervisor } from "../lsp/supervisor.js";
import { AGENT_LANGUAGE_VIEW } from "../lsp/supervisor.js";
import { createLanguageViewBinder } from "../lsp/language-view.js";
import { languageIdForPath } from "../harness/language-id.js";
import { createSymbolCollector, type CollectedSymbols, type SymbolCollector } from "./symbols.js";
import type { KnowledgeStore, SymbolGraphSymbolInput, SymbolGraphRange } from "./store.js";

type LanguageSupervisor = Pick<ReturnType<typeof createLanguageSupervisor>,
  "syncDocument" | "documentSymbols">;

export interface SymbolGraphRuntimeOptions {
  getStore(workspaceId: string): Promise<KnowledgeStore | null>;
  documents: Pick<DocumentAuthority, "read" | "readAgentInputSnapshot">;
  supervisor: LanguageSupervisor;
  onError?: (error: unknown) => void;
}

const recordOf = (value: unknown): Record<string, unknown> => (
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
);

const symbolRange = (value: unknown): SymbolGraphRange | null => {
  const symbol = recordOf(value);
  const range = recordOf(symbol.selectionRange ?? symbol.range);
  const start = recordOf(range.start);
  const end = recordOf(range.end);
  return [start.line, start.character, end.line, end.character].every((part) => Number.isSafeInteger(part) && Number(part) >= 0)
    ? {
        startLine: Number(start.line),
        startCharacter: Number(start.character),
        endLine: Number(end.line),
        endCharacter: Number(end.character),
      }
    : null;
};

const flattenSymbols = (value: unknown): SymbolGraphSymbolInput[] => {
  if (!Array.isArray(value)) return [];
  const result: SymbolGraphSymbolInput[] = [];
  const visit = (raw: unknown): void => {
    const symbol = recordOf(raw);
    const range = symbolRange(symbol);
    if (typeof symbol.name === "string" && symbol.name.trim() && range) {
      result.push({
        name: symbol.name,
        kind: typeof symbol.kind === "number" || typeof symbol.kind === "string" ? String(symbol.kind) : "unknown",
        range,
      });
    }
    if (Array.isArray(symbol.children)) for (const child of symbol.children) visit(child);
  };
  for (const symbol of value) visit(symbol);
  return result;
};

export function createSymbolGraphRuntime(options: SymbolGraphRuntimeOptions) {
  const collectors = new Map<string, Promise<SymbolCollector | null>>();
  const pending = new Set<Promise<void>>();
  const binder = createLanguageViewBinder({ documents: options.documents, supervisor: options.supervisor });
  let disposed = false;

  /**
   * The graph holds committed facts, so collection binds the Host language view
   * to the file's disk text and never reads an editor buffer. The range set is
   * returned with that revision, or null so the last known graph survives
   * (D-087).
   */
  const loadSymbols = async (workspaceId: string, path: string, languageId: string): Promise<CollectedSymbols | null> => {
    const bound = await binder.bind({ workspaceId, resourceId: path, languageId, text: "disk" });
    if (bound.status !== "bound") return null;
    const response = await options.supervisor.documentSymbols({
      view: AGENT_LANGUAGE_VIEW,
      resource: { workspaceId, resourceId: path },
      languageId,
      expectedRevision: bound.revision,
    });
    const result = recordOf(response);
    if (result.status !== "ready") return null;
    return { symbols: flattenSymbols(result.value), documentRevision: bound.revision };
  };

  const collectorFor = (workspaceId: string): Promise<SymbolCollector | null> => {
    const existing = collectors.get(workspaceId);
    if (existing) return existing;
    const loading = options.getStore(workspaceId).then((store) => store ? createSymbolCollector({
      store,
      getLanguage: languageIdForPath,
      getDocumentSymbols: (path, language) => loadSymbols(workspaceId, path, language),
      ...(options.onError ? { onError: options.onError } : {}),
    }) : null);
    collectors.set(workspaceId, loading);
    void loading.catch(() => {
      if (collectors.get(workspaceId) === loading) collectors.delete(workspaceId);
    });
    void loading.then((collector) => {
      if (!collector && collectors.get(workspaceId) === loading) collectors.delete(workspaceId);
    }, () => undefined);
    return loading;
  };

  const track = (task: Promise<void>): void => {
    pending.add(task);
    void task.catch((error) => {
      try { options.onError?.(error); } catch { /* diagnostics cannot break observation */ }
    }).finally(() => pending.delete(task));
  };

  const observeDocumentMutation = (event: DocumentMutationObservation): void => {
    if (disposed) return;
    track(collectorFor(event.workspaceId).then((collector) => {
      collector?.observe({ path: event.resourceId, kind: event.kind });
    }));
  };

  const drain = async (): Promise<void> => {
    while (pending.size > 0) await Promise.allSettled([...pending]);
    const loaded = await Promise.allSettled(collectors.values());
    await Promise.allSettled(loaded.flatMap((result) => result.status === "fulfilled" && result.value ? [result.value.drain()] : []));
  };

  const dispose = async (): Promise<void> => {
    disposed = true;
    await drain();
    const loaded = await Promise.allSettled(collectors.values());
    await Promise.allSettled(loaded.flatMap((result) => result.status === "fulfilled" && result.value ? [result.value.dispose()] : []));
    collectors.clear();
  };

  return { observeDocumentMutation, drain, dispose };
}

export type SymbolGraphRuntime = ReturnType<typeof createSymbolGraphRuntime>;
