import type { JsonValue, LspNavigationResult } from "@piarium/protocol";
import type { DocumentAuthority } from "../documents/authority.js";
import type { createLanguageSupervisor } from "../lsp/supervisor.js";
import { AGENT_LANGUAGE_VIEW } from "../lsp/supervisor.js";
import { createLanguageViewBinder, type LanguageTextSource } from "../lsp/language-view.js";
import type { HarnessService, HarnessServiceContext } from "./router.js";
import { languageIdForPath } from "./language-id.js";

type LanguageSupervisor = Pick<ReturnType<typeof createLanguageSupervisor>,
  "syncDocument" | "workspaceSymbols" | "definition" | "references" | "hover">;

interface LspNavigationDeps {
  documents: Pick<DocumentAuthority, "read" | "readAgentInputSnapshot">;
  supervisor: LanguageSupervisor;
}

interface PreparedDocument {
  languageId: string;
  resource: { workspaceId: string; resourceId: string };
  revision: string;
  source: LanguageTextSource;
}

const recordOf = (value: unknown): Record<string, unknown> => (
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
);

const unavailable = (message: string): LspNavigationResult => ({ status: "unavailable", text: message });
const empty = (message: string): LspNavigationResult => ({ status: "empty", text: message });

const startOf = (value: unknown): { line: number; character: number } | null => {
  const record = recordOf(value);
  const range = recordOf(record.targetSelectionRange ?? record.targetRange ?? record.range);
  const start = recordOf(range.start);
  return typeof start.line === "number" && typeof start.character === "number"
    ? { line: start.line + 1, character: start.character + 1 }
    : null;
};

const resourcePath = (value: unknown): string | null => {
  const resource = recordOf(recordOf(value).resource);
  return typeof resource.resourceId === "string" ? resource.resourceId : null;
};

/**
 * Piarium synchronizes the queried document, so its positions are bound to a
 * named revision. Positions in other files come from the language server's own
 * read of those files and LSP does not report the version it used, so they are
 * reported as unpinned rather than claimed against a revision (D-087).
 */
const UNPINNED_NOTE = "[unpinned] positions came from the language server's own file read, not a bound revision; re-read those files before acting.";

interface AnnotatedLines {
  lines: string[];
  unpinnedPaths: string[];
}

const annotate = (
  entries: Array<{ path: string; text: string }>,
  prepared: PreparedDocument,
): AnnotatedLines => {
  const unpinned = new Set<string>();
  const lines = entries.map((entry) => {
    if (entry.path === prepared.resource.resourceId) return entry.text;
    unpinned.add(entry.path);
    return `${entry.text} [unpinned]`;
  });
  return { lines, unpinnedPaths: [...unpinned].sort() };
};

const symbolEntries = (value: unknown, inheritedPath: string): Array<{ path: string; text: string }> => {
  if (!Array.isArray(value)) return [];
  const entries: Array<{ path: string; text: string }> = [];
  const visit = (raw: unknown, fallbackPath: string): void => {
    const symbol = recordOf(raw);
    if (typeof symbol.name !== "string") return;
    const path = resourcePath(symbol) ?? fallbackPath;
    const start = startOf(symbol);
    entries.push({
      path,
      text: `${path}${start ? `:${start.line}:${start.character}` : ""} — ${symbol.name}${typeof symbol.kind === "number" ? ` (kind ${symbol.kind})` : ""}`,
    });
    if (Array.isArray(symbol.children)) for (const child of symbol.children) visit(child, path);
  };
  for (const symbol of value) visit(symbol, inheritedPath);
  return entries;
};

const locationEntries = (value: unknown): Array<{ path: string; text: string }> => (
  Array.isArray(value) ? value.flatMap((entry) => {
    const path = resourcePath(entry);
    const start = startOf(entry);
    return path && start ? [{ path, text: `${path}:${start.line}:${start.character}` }] : [];
  }) : []
);

const hoverText = (value: unknown): string => {
  const contents = recordOf(value).contents;
  if (!Array.isArray(contents)) return "";
  return contents.flatMap((entry) => {
    const text = recordOf(entry).value;
    return typeof text === "string" && text.trim() ? [text.trim()] : [];
  }).join("\n\n");
};

const boundTo = (prepared: PreparedDocument): string => (
  `${prepared.resource.resourceId} @ ${prepared.revision} (${prepared.source})`
);

const ready = (
  prepared: PreparedDocument,
  text: string,
  value: unknown,
  unpinnedPaths: string[] = [],
): LspNavigationResult => ({
  status: "ready",
  text: unpinnedPaths.length > 0 ? `${text}\n${UNPINNED_NOTE}` : text,
  revision: prepared.revision,
  source: prepared.source,
  ...(unpinnedPaths.length > 0 ? { unpinnedPaths } : {}),
  ...(value === undefined ? {} : { value: value as JsonValue }),
});

export function createLspNavigationServices(deps: LspNavigationDeps): {
  symbols: HarnessService<"lsp.symbols">;
  definition: HarnessService<"lsp.definition">;
  references: HarnessService<"lsp.references">;
  hover: HarnessService<"lsp.hover">;
} {
  const binder = createLanguageViewBinder({ documents: deps.documents, supervisor: deps.supervisor });

  const prepareDocument = async (
    path: string,
    ctx: HarnessServiceContext,
  ): Promise<PreparedDocument | LspNavigationResult> => {
    if (!ctx.workspaceId) return unavailable("LSP unavailable: no workspace");
    const resourceId = ctx.authorizedPaths.find((entry) => entry.inputPath === path)?.resourceId ?? path;
    const languageId = languageIdForPath(resourceId);
    if (!languageId) return unavailable(`LSP unavailable: unsupported file type for ${path}`);
    const resource = { workspaceId: ctx.workspaceId, resourceId };
    // Navigation follows the same fixed source as read/grep for this turn, so a
    // reported position refers to text the agent can actually obtain.
    const bound = await binder.bind({
      workspaceId: ctx.workspaceId,
      resourceId,
      languageId,
      text: "input-context",
      ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
      ...(ctx.inputContext ? { inputContext: ctx.inputContext } : {}),
    });
    if (bound.status !== "bound") return unavailable(`LSP unavailable: ${bound.message}`);
    return { languageId, resource, revision: bound.revision, source: bound.source };
  };

  /**
   * Binds the document, asks the language server, and re-binds once when the
   * view moved to another revision between the two steps. A second stale answer
   * is reported instead of looping.
   */
  const query = async (
    path: string,
    ctx: HarnessServiceContext,
    run: (prepared: PreparedDocument) => Promise<unknown>,
  ): Promise<{ prepared: PreparedDocument; value: unknown } | LspNavigationResult> => {
    let lastStatus = "unavailable";
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const prepared = await prepareDocument(path, ctx);
      if ("status" in prepared) return prepared;
      const result = recordOf(await run(prepared));
      if (result.status === "ready") return { prepared, value: result.value };
      lastStatus = typeof result.status === "string" ? result.status : "unavailable";
      if (lastStatus === "stale") continue;
      return unavailable(`LSP unavailable: ${String(result.message ?? `language service ${lastStatus}`)}`);
    }
    return unavailable(`LSP unavailable: ${path} changed while the language view was answering`);
  };

  const requestFor = (prepared: PreparedDocument) => ({
    view: AGENT_LANGUAGE_VIEW,
    resource: prepared.resource,
    languageId: prepared.languageId,
    expectedRevision: prepared.revision,
  });

  return {
    symbols: {
      handle: async (params, ctx) => {
        const outcome = await query(params.path, ctx, (prepared) => deps.supervisor.workspaceSymbols({
          ...requestFor(prepared),
          query: params.query,
        }));
        if ("status" in outcome) return outcome;
        const { lines, unpinnedPaths } = annotate(symbolEntries(outcome.value, params.path), outcome.prepared);
        if (lines.length === 0) return empty("No symbols found");
        return ready(
          outcome.prepared,
          `${lines.length} symbols · queried ${boundTo(outcome.prepared)}\n${lines.join("\n")}`,
          outcome.value,
          unpinnedPaths,
        );
      },
    },
    definition: {
      handle: async (params, ctx) => {
        const outcome = await query(params.path, ctx, (prepared) => deps.supervisor.definition({
          ...requestFor(prepared),
          position: { line: params.line - 1, character: (params.character ?? 1) - 1 },
        }));
        if ("status" in outcome) return outcome;
        const { lines, unpinnedPaths } = annotate(locationEntries(outcome.value), outcome.prepared);
        if (lines.length === 0) return empty("No definition found");
        return ready(
          outcome.prepared,
          `queried ${boundTo(outcome.prepared)}\n${lines.join("\n")}`,
          outcome.value,
          unpinnedPaths,
        );
      },
    },
    references: {
      handle: async (params, ctx) => {
        const outcome = await query(params.path, ctx, (prepared) => deps.supervisor.references({
          ...requestFor(prepared),
          position: { line: params.line - 1, character: (params.character ?? 1) - 1 },
        }));
        if ("status" in outcome) return outcome;
        const { lines, unpinnedPaths } = annotate(locationEntries(outcome.value), outcome.prepared);
        if (lines.length === 0) return empty("No references found");
        return ready(
          outcome.prepared,
          `${lines.length} references · queried ${boundTo(outcome.prepared)}\n${lines.join("\n")}`,
          outcome.value,
          unpinnedPaths,
        );
      },
    },
    hover: {
      handle: async (params, ctx) => {
        const outcome = await query(params.path, ctx, (prepared) => deps.supervisor.hover({
          ...requestFor(prepared),
          position: { line: params.line - 1, character: (params.character ?? 1) - 1 },
        }));
        if ("status" in outcome) return outcome;
        const text = hoverText(outcome.value);
        if (!text) return empty("No hover information");
        return ready(outcome.prepared, `${boundTo(outcome.prepared)}\n${text}`, outcome.value);
      },
    },
  };
}
