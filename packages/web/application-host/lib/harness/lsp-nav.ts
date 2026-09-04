import type { JsonValue, LspNavigationResult } from "@piarium/protocol";
import type { DocumentAuthority } from "../documents/authority.js";
import type { createLanguageSupervisor } from "../lsp/supervisor.js";
import type { HarnessService, HarnessServiceContext } from "./router.js";
import { languageIdForPath } from "./language-id.js";

type LanguageSupervisor = Pick<ReturnType<typeof createLanguageSupervisor>,
  "hasSyncedDocument" | "syncedDocumentVersion" | "syncDocument" | "workspaceSymbols" | "definition" | "references" | "hover">;

interface LspNavigationDeps {
  documents: Pick<DocumentAuthority, "read">;
  supervisor: LanguageSupervisor;
}

const recordOf = (value: unknown): Record<string, unknown> => (
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
);

const unavailable = (message: string): LspNavigationResult => ({ status: "unavailable", text: message });
const empty = (message: string): LspNavigationResult => ({ status: "empty", text: message });

const prepareDocument = async (
  path: string,
  ctx: HarnessServiceContext,
  deps: LspNavigationDeps,
): Promise<{ documentVersion: number; languageId: string; resource: { workspaceId: string; resourceId: string } } | LspNavigationResult> => {
  if (!ctx.workspaceId) return unavailable("LSP unavailable: no workspace");
  const resourceId = ctx.authorizedPaths.find((entry) => entry.inputPath === path)?.resourceId ?? path;
  const languageId = languageIdForPath(resourceId);
  if (!languageId) return unavailable(`LSP unavailable: unsupported file type for ${path}`);
  const resource = { workspaceId: ctx.workspaceId, resourceId };
  let documentVersion = deps.supervisor.syncedDocumentVersion(ctx.workspaceId, languageId, resourceId);
  if (!deps.supervisor.hasSyncedDocument(ctx.workspaceId, languageId, resourceId) || documentVersion === null) {
    const snapshot = await deps.documents.read(resource);
    if (snapshot.status !== "ready") {
      return unavailable(`LSP unavailable: cannot read ${path} (${snapshot.status})`);
    }
    const synced = await deps.supervisor.syncDocument({
      resource,
      languageId,
      documentVersion: 0,
      content: snapshot.content,
      reason: "open",
    });
    const syncStatus = recordOf(synced).status;
    if (syncStatus !== "synced" && syncStatus !== "stale") {
      return unavailable(`LSP unavailable: ${String(recordOf(synced).message ?? syncStatus ?? "document sync failed")}`);
    }
    documentVersion = typeof recordOf(synced).documentVersion === "number"
      ? recordOf(synced).documentVersion as number
      : 0;
  }
  return { documentVersion, languageId, resource };
};

const featureValue = (result: unknown): { failure?: string; value?: unknown } => {
  const record = recordOf(result);
  if (record.status !== "ready") {
    return { failure: String(record.message ?? `language service ${record.status ?? "unavailable"}`) };
  }
  return { value: record.value };
};

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

const symbolLines = (value: unknown, inheritedPath: string): string[] => {
  if (!Array.isArray(value)) return [];
  const lines: string[] = [];
  const visit = (raw: unknown, fallbackPath: string): void => {
    const symbol = recordOf(raw);
    if (typeof symbol.name !== "string") return;
    const path = resourcePath(symbol) ?? fallbackPath;
    const start = startOf(symbol);
    lines.push(`${path}${start ? `:${start.line}:${start.character}` : ""} — ${symbol.name}${typeof symbol.kind === "number" ? ` (kind ${symbol.kind})` : ""}`);
    if (Array.isArray(symbol.children)) for (const child of symbol.children) visit(child, path);
  };
  for (const symbol of value) visit(symbol, inheritedPath);
  return lines;
};

const locationLines = (value: unknown): string[] => (
  Array.isArray(value) ? value.flatMap((entry) => {
    const path = resourcePath(entry);
    const start = startOf(entry);
    return path && start ? [`${path}:${start.line}:${start.character}`] : [];
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

const ready = (text: string, value: unknown): LspNavigationResult => ({
  status: "ready",
  text,
  ...(value === undefined ? {} : { value: value as JsonValue }),
});

export function createLspNavigationServices(deps: LspNavigationDeps): {
  symbols: HarnessService<"lsp.symbols">;
  definition: HarnessService<"lsp.definition">;
  references: HarnessService<"lsp.references">;
  hover: HarnessService<"lsp.hover">;
} {
  return {
    symbols: {
      handle: async (params, ctx) => {
        const prepared = await prepareDocument(params.path, ctx, deps);
        if ("status" in prepared) return prepared;
        const result = featureValue(await deps.supervisor.workspaceSymbols({
          resource: prepared.resource,
          languageId: prepared.languageId,
          documentVersion: prepared.documentVersion,
          query: params.query,
        }));
        if (result.failure) return unavailable(`Symbols unavailable: ${result.failure}`);
        const lines = symbolLines(result.value, params.path);
        return lines.length === 0 ? empty("No symbols found") : ready(`${lines.length} symbols\n${lines.join("\n")}`, result.value);
      },
    },
    definition: {
      handle: async (params, ctx) => {
        const prepared = await prepareDocument(params.path, ctx, deps);
        if ("status" in prepared) return prepared;
        const result = featureValue(await deps.supervisor.definition({
          resource: prepared.resource,
          languageId: prepared.languageId,
          documentVersion: prepared.documentVersion,
          position: { line: params.line - 1, character: (params.character ?? 1) - 1 },
        }));
        if (result.failure) return unavailable(`Definition unavailable: ${result.failure}`);
        const lines = locationLines(result.value);
        return lines.length === 0 ? empty("No definition found") : ready(lines.join("\n"), result.value);
      },
    },
    references: {
      handle: async (params, ctx) => {
        const prepared = await prepareDocument(params.path, ctx, deps);
        if ("status" in prepared) return prepared;
        const result = featureValue(await deps.supervisor.references({
          resource: prepared.resource,
          languageId: prepared.languageId,
          documentVersion: prepared.documentVersion,
          position: { line: params.line - 1, character: (params.character ?? 1) - 1 },
        }));
        if (result.failure) return unavailable(`References unavailable: ${result.failure}`);
        const lines = locationLines(result.value);
        return lines.length === 0 ? empty("No references found") : ready(`${lines.length} references\n${lines.join("\n")}`, result.value);
      },
    },
    hover: {
      handle: async (params, ctx) => {
        const prepared = await prepareDocument(params.path, ctx, deps);
        if ("status" in prepared) return prepared;
        const result = featureValue(await deps.supervisor.hover({
          resource: prepared.resource,
          languageId: prepared.languageId,
          documentVersion: prepared.documentVersion,
          position: { line: params.line - 1, character: (params.character ?? 1) - 1 },
        }));
        if (result.failure) return unavailable(`Hover unavailable: ${result.failure}`);
        const text = hoverText(result.value);
        return text ? ready(text, result.value) : empty("No hover information");
      },
    },
  };
}
