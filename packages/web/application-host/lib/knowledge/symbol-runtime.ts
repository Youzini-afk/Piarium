import type { DocumentMutationObservation } from "../documents/authority.js";
import type { DocumentAuthority } from "../documents/authority.js";
import type { FileSearchItem } from "../fs/types.js";
import type { createLanguageSupervisor } from "../lsp/supervisor.js";
import { AGENT_LANGUAGE_VIEW } from "../lsp/supervisor.js";
import { createLanguageViewBinder } from "../lsp/language-view.js";
import { languageIdForPath } from "../harness/language-id.js";
import { classifyLiteralCall } from "../structure/connections.js";
import { CATALOG_SCAN_LANGUAGES } from "../structure/languages.js";
import type { StructureSource, StructureSymbol } from "../structure/types.js";
import { CATALOG_EXTRACTOR_VERSION, createSymbolCollector, type CollectedSymbols, type SymbolCollector } from "./symbols.js";
import type {
  KnowledgeStore,
  SymbolGraphLinkInput,
  SymbolGraphRange,
  SymbolGraphSymbolInput,
} from "./store.js";

type LanguageSupervisor = Pick<ReturnType<typeof createLanguageSupervisor>,
  "syncDocument" | "documentSymbols">;

export { CATALOG_SCAN_LANGUAGES };
/**
 * Distinct paths handed to the collector at once. The collector serializes per
 * path and runs different paths concurrently, so this is also the store's write
 * burst size — the measurement script imports it rather than restating it, so
 * the recorded numbers describe the shape the product runs (D-140).
 */
export const CATALOG_SCAN_BATCH = 8;

export interface SymbolGraphRuntimeOptions {
  getStore(workspaceId: string): Promise<KnowledgeStore | null>;
  documents: Pick<DocumentAuthority, "read" | "readAgentInputSnapshot"> & {
    inspectWorkspace?: DocumentAuthority["inspectWorkspace"];
  };
  supervisor: LanguageSupervisor;
  structureSource?: StructureSource;
  searchFilesystemFiles?: (
    rootPath: string,
    options: { query: string; respectGitignore?: boolean; signal?: AbortSignal },
  ) => Promise<FileSearchItem[]>;
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

/**
 * Structure outlines carry inclusive 1-based line spans with no columns, while
 * the graph stores a 0-based character range. Ending at column 0 of the last
 * line would exclude that line and make a single-line symbol zero-width, so the
 * end column comes from the real line length (D-110).
 */
const flattenOutlineSymbols = (
  symbols: readonly StructureSymbol[],
  lineLengths: readonly number[],
): SymbolGraphSymbolInput[] => {
  const result: SymbolGraphSymbolInput[] = [];
  const visit = (symbol: StructureSymbol): void => {
    if (symbol.name.trim()) {
      const startLine = Math.max(0, symbol.range.startLine - 1);
      const endLine = Math.max(startLine, symbol.range.endLine - 1);
      result.push({
        name: symbol.name,
        kind: symbol.kind,
        range: {
          startLine,
          startCharacter: 0,
          endLine,
          endCharacter: lineLengths[endLine] ?? 0,
        },
      });
    }
    for (const child of symbol.children ?? []) visit(child);
  };
  for (const symbol of symbols) visit(symbol);
  return result;
};

const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => {
  setTimeout(resolve, 0);
});

export function createSymbolGraphRuntime(options: SymbolGraphRuntimeOptions) {
  const collectors = new Map<string, Promise<SymbolCollector | null>>();
  const pending = new Set<Promise<void>>();
  const binder = createLanguageViewBinder({ documents: options.documents, supervisor: options.supervisor });
  const catalogControllers = new Map<string, AbortController>();
  const suppressedCandidates = new Map<string, Set<string>>();
  let disposed = false;

  /**
   * The graph holds committed facts, so collection binds the Host language view
   * to the file's disk text and never reads an editor buffer. The range set is
   * returned with that revision, or null so the last known graph survives
   * (D-087).
   */
  const loadSymbolsFromLsp = async (workspaceId: string, path: string, languageId: string): Promise<CollectedSymbols | null> => {
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

  const loadGraphFacts = async (workspaceId: string, path: string, languageId: string): Promise<CollectedSymbols | null> => {
    if (!options.structureSource) return loadSymbolsFromLsp(workspaceId, path, languageId);
    let snapshot: Awaited<ReturnType<DocumentAuthority["read"]>>;
    try {
      snapshot = await options.documents.read({ workspaceId, resourceId: path });
    } catch {
      return null;
    }
    if (snapshot.status !== "ready") return null;
    const request = {
      path,
      languageId,
      text: snapshot.content,
      revision: snapshot.revision,
      workspaceId,
    };
    const [outline, importsResult, callsResult] = await Promise.all([
      options.structureSource.outline(request),
      options.structureSource.imports(request),
      options.structureSource.literalCalls(request),
    ]);
    if (outline.status === "cancelled" || importsResult.status === "cancelled" || callsResult.status === "cancelled") {
      return null;
    }
    /**
     * The outline decides whether this generation may be written at all: an
     * empty symbol set is only authoritative when a provider actually answered.
     * A blocked link query never suppresses a working outline — a wasm failure
     * must degrade to defines-only, not freeze the file forever (D-111).
     */
    if (outline.status !== "ready" && outline.status !== "empty") {
      if (outline.status === "unsupported") return loadSymbolsFromLsp(workspaceId, path, languageId);
      return null;
    }
    const answered = (status: string): boolean => status === "ready" || status === "empty" || status === "unsupported";
    const linksIncomplete = !answered(importsResult.status) || !answered(callsResult.status);
    const links: SymbolGraphLinkInput[] = [];
    if (importsResult.status === "ready") {
      for (const item of importsResult.imports) {
        if (item.source.trim() && Number.isSafeInteger(item.line) && item.line >= 1) {
          links.push({ kind: "import", value: item.source, line: item.line });
        }
      }
    }
    if (callsResult.status === "ready") {
      const usable = callsResult.calls.filter((call) => (
        classifyLiteralCall(call) !== null && Number.isSafeInteger(call.line) && call.line >= 1
      ));
      const candidates = usable.filter((call) => classifyLiteralCall(call) === "associates");
      /**
       * plan 3.11 marks a *same-name* string as an association candidate, so a
       * literal only qualifies once it is a confirmed connection value
       * somewhere. Without this gate every `it("…")` and `join("…")` becomes a
       * graph node (D-109).
       */
      // A file that both registers and mentions the same literal is the
      // clearest same-name case, and the store has not seen this generation
      // yet, so the gate consults this batch as well as the graph (D-109).
      const localConnections = new Set(usable
        .filter((call) => classifyLiteralCall(call) === "connects")
        .map((call) => call.literal));
      const unresolved = [...new Set(candidates
        .map((call) => call.literal)
        .filter((literal) => !localConnections.has(literal)))];
      const store = unresolved.length > 0 ? await options.getStore(workspaceId) : null;
      const knownLiterals = store ? await store.connectionLiterals(unresolved) : new Set<string>();
      let suppressed = false;
      for (const call of usable) {
        const classified = classifyLiteralCall(call)!;
        if (classified === "associates" && !localConnections.has(call.literal) && !knownLiterals.has(call.literal)) {
          suppressed = true;
          continue;
        }
        links.push({ kind: classified, value: call.literal, line: call.line, callee: call.name });
      }
      // The gate only sees connections collected so far, so a file visited
      // before the file that registers its literal loses the candidate. Record
      // it and let the cold scan make one more pass (D-109).
      if (suppressed) {
        const paths = suppressedCandidates.get(workspaceId) ?? new Set<string>();
        paths.add(path);
        suppressedCandidates.set(workspaceId, paths);
      }
    }
    const lineLengths = snapshot.content.split("\n").map((line) => line.replace(/\r$/u, "").length);
    return {
      symbols: flattenOutlineSymbols(outline.symbols, lineLengths),
      links,
      ...(linksIncomplete ? { linksIncomplete: true } : {}),
      documentRevision: snapshot.revision,
    };
  };

  const collectorFor = (workspaceId: string): Promise<SymbolCollector | null> => {
    const existing = collectors.get(workspaceId);
    if (existing) return existing;
    const loading = options.getStore(workspaceId).then((store) => store ? createSymbolCollector({
      store,
      getLanguage: languageIdForPath,
      getDocumentSymbols: (path, language) => loadGraphFacts(workspaceId, path, language),
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

  const scanWorkspace = async (workspaceId: string, optionsForScan?: { signal?: AbortSignal }): Promise<void> => {
    if (disposed || !options.searchFilesystemFiles || !options.documents.inspectWorkspace) return;
    catalogControllers.get(workspaceId)?.abort();
    const controller = new AbortController();
    catalogControllers.set(workspaceId, controller);
    const signal = optionsForScan?.signal
      ? AbortSignal.any([controller.signal, optionsForScan.signal])
      : controller.signal;
    try {
      if (signal.aborted) return;
      let root: string;
      try {
        root = (await options.documents.inspectWorkspace!(workspaceId)).root;
      } catch {
        return;
      }
      const files = await options.searchFilesystemFiles(root, {
        query: "",
        respectGitignore: true,
        signal,
      });
      if (signal.aborted) return;
      const store = await options.getStore(workspaceId);
      const collector = await collectorFor(workspaceId);
      if (!store || !collector) return;
      const catalogFiles = files.filter((file) => CATALOG_SCAN_LANGUAGES.has(languageIdForPath(file.relativePath) ?? ""));
      for (let offset = 0; offset < catalogFiles.length; offset += CATALOG_SCAN_BATCH) {
        if (disposed || signal.aborted) return;
        const batch = catalogFiles.slice(offset, offset + CATALOG_SCAN_BATCH);
        for (const file of batch) {
          if (disposed || signal.aborted) return;
          let snapshot: Awaited<ReturnType<DocumentAuthority["read"]>>;
          try {
            snapshot = await options.documents.read({ workspaceId, resourceId: file.relativePath });
          } catch {
            continue;
          }
          if (snapshot.status !== "ready") continue;
          const existing = await store.getFileRelations(file.relativePath);
          // Current only if both the source and the extractor that read it are
          // unchanged; rows from an older extractor are recomputed (D-143).
          if (existing?.documentRevision === snapshot.revision && existing.extractor === CATALOG_EXTRACTOR_VERSION) continue;
          collector.observe({ path: file.relativePath, kind: "modified" });
        }
        await collector.drain();
        await yieldToEventLoop();
      }
      // One more pass over the files whose association candidates were gated
      // before their connection literal existed. Parses are content-hashed, so
      // this re-collect is cheap, and it does not recurse (D-109).
      const revisit = [...(suppressedCandidates.get(workspaceId) ?? [])];
      suppressedCandidates.delete(workspaceId);
      for (let offset = 0; offset < revisit.length; offset += CATALOG_SCAN_BATCH) {
        if (disposed || signal.aborted) return;
        for (const revisitPath of revisit.slice(offset, offset + CATALOG_SCAN_BATCH)) {
          collector.observe({ path: revisitPath, kind: "modified" });
        }
        await collector.drain();
        await yieldToEventLoop();
      }
      suppressedCandidates.delete(workspaceId);
    } catch (error) {
      if (signal.aborted || disposed) return;
      try { options.onError?.(error); } catch { /* catalog failures stay observational */ }
    } finally {
      if (catalogControllers.get(workspaceId) === controller) catalogControllers.delete(workspaceId);
    }
  };

  const drain = async (): Promise<void> => {
    while (pending.size > 0) await Promise.allSettled([...pending]);
    const loaded = await Promise.allSettled(collectors.values());
    await Promise.allSettled(loaded.flatMap((result) => result.status === "fulfilled" && result.value ? [result.value.drain()] : []));
  };

  const dispose = async (): Promise<void> => {
    disposed = true;
    for (const controller of catalogControllers.values()) controller.abort();
    catalogControllers.clear();
    await drain();
    const loaded = await Promise.allSettled(collectors.values());
    await Promise.allSettled(loaded.flatMap((result) => result.status === "fulfilled" && result.value ? [result.value.dispose()] : []));
    collectors.clear();
  };

  return { observeDocumentMutation, scanWorkspace, drain, dispose };
}

export type SymbolGraphRuntime = ReturnType<typeof createSymbolGraphRuntime>;
