/**
 * related — file-level import topology and connection endpoints.
 *
 * Answers what a path (or symbol name) defines, imports, is imported by, and
 * which connection literals it sits on. This is not `lsp.references`: it does
 * not list symbol reference sites and does not need a language server.
 *
 * Design: agent-harness.md §6.2
 * Plan: agent-harness-plan.md §3.12
 */

import type { RelatedQueryResult, RelatedQueryStatus } from "@piarium/protocol";
import { resolveImportSpecifier } from "../knowledge/import-resolve.js";
import type { KnowledgeStore } from "../knowledge/store.js";

export interface RelatedQueryInput {
  anchor: string;
}

const looksLikePath = (anchor: string): boolean => (
  /[\\/]/.test(anchor) || /\.[a-zA-Z][a-zA-Z0-9]*$/.test(anchor)
);

const compareText = (left: string, right: string): number => left.localeCompare(right);

export async function executeRelated(
  input: RelatedQueryInput,
  store: KnowledgeStore,
): Promise<RelatedQueryResult> {
  const anchor = input.anchor.trim();
  const empty = (status: RelatedQueryStatus, kind: "path" | "name", message: string): RelatedQueryResult => ({
    text: message,
    status,
    anchor: { kind, value: anchor },
    definitions: [],
    imports: { items: [], unresolved: [], incomplete: false },
    importers: { items: [], incomplete: false },
    connections: { items: [], incomplete: false },
  });
  if (!anchor) {
    return empty("failed", "name", "related failed: provide a path or symbol name.");
  }

  const stats = await store.catalogStats();
  if (stats.symbolCount === 0 && stats.fileCount === 0) {
    return empty(
      "empty",
      looksLikePath(anchor) ? "path" : "name",
      "related empty: the symbol catalog has no files. Catalog languages are TypeScript and JavaScript (including JSX); other languages are not missing, they are not collected.",
    );
  }

  const known = new Set(stats.paths);
  const kind = looksLikePath(anchor) ? "path" : "name";
  let focusPaths: string[] = [];
  if (kind === "path") {
    const normalized = anchor.replace(/\\/g, "/");
    if (!known.has(normalized)) {
      return empty("empty", "path", `related empty: the catalog has not collected ${normalized}.`);
    }
    focusPaths = [normalized];
  } else {
    const exact = (await store.searchSymbols(anchor, 32)).filter((entry) => entry.match === "exact");
    focusPaths = [...new Set(exact.map((entry) => entry.path))];
    if (focusPaths.length === 0) {
      const links = await store.findLinks(anchor);
      focusPaths = [...new Set(links.map((entry) => entry.path))];
    }
  }
  if (focusPaths.length === 0) {
    return empty(
      "empty",
      kind,
      `related empty: nothing in the catalog matched ${anchor}.`,
    );
  }

  const definitions: RelatedQueryResult["definitions"] = [];
  const importItems: RelatedQueryResult["imports"]["items"] = [];
  const unresolved: RelatedQueryResult["imports"]["unresolved"] = [];
  const importerItems: RelatedQueryResult["importers"]["items"] = [];
  const connectionItems: RelatedQueryResult["connections"]["items"] = [];
  let importsIncomplete = false;
  let importersIncomplete = false;
  let connectionsIncomplete = false;

  for (const path of focusPaths.toSorted(compareText)) {
    for (const symbol of await store.getDefinedSymbols(path)) {
      definitions.push({ name: symbol.name, kind: symbol.kind, path: symbol.path });
    }
    const relations = await store.getFileRelations(path);
    if (!relations) continue;
    if (relations.linksIncomplete) {
      importsIncomplete = true;
      importersIncomplete = true;
      connectionsIncomplete = true;
    }
    for (const item of relations.imports) {
      const resolved = resolveImportSpecifier(path, item.specifier, known);
      if (resolved.status === "resolved") {
        importItems.push({ specifier: item.specifier, path, resolvedPath: resolved.resolvedPath });
      } else {
        unresolved.push({ specifier: item.specifier, path, reason: resolved.status });
      }
    }
    const importers = await store.findImporters(path);
    importerItems.push(...importers.resolved);
    for (const connection of relations.connections) {
      const ends = await store.findLinks(connection.literal);
      connectionItems.push({
        literal: connection.literal,
        callee: connection.callee,
        path,
        otherEnds: ends
          .filter((end) => end.path !== path)
          .map((end) => ({
            path: end.path,
            kind: end.kind,
            ...(end.callee ? { callee: end.callee } : {}),
          })),
      });
    }
  }

  const result: RelatedQueryResult = {
    text: "",
    status: "ready",
    anchor: { kind, value: anchor },
    definitions: definitions.toSorted((left, right) => left.path.localeCompare(right.path) || left.name.localeCompare(right.name)),
    imports: {
      items: importItems.toSorted((left, right) => left.path.localeCompare(right.path) || left.specifier.localeCompare(right.specifier)),
      unresolved: unresolved.toSorted((left, right) => left.path.localeCompare(right.path) || left.specifier.localeCompare(right.specifier)),
      incomplete: importsIncomplete,
    },
    importers: {
      items: importerItems.toSorted((left, right) => left.path.localeCompare(right.path) || left.specifier.localeCompare(right.specifier)),
      incomplete: importersIncomplete,
    },
    connections: {
      items: connectionItems.toSorted((left, right) => left.path.localeCompare(right.path) || left.literal.localeCompare(right.literal)),
      incomplete: connectionsIncomplete,
    },
  };
  result.text = formatRelatedText(result);
  return result;
}

function formatRelatedText(result: RelatedQueryResult): string {
  const lines: string[] = [
    `related ${result.anchor.value} (${result.anchor.kind}) · ${result.status}`,
    "File-level import topology and connection endpoints from the symbol graph. Use lsp.references for precise who-references-this-symbol at a position; related does not need a language server.",
  ];
  if (result.definitions.length === 0) lines.push("Defines: none");
  else {
    lines.push("Defines:");
    for (const item of result.definitions) lines.push(`- ${item.path} ${item.name} (${item.kind})`);
  }
  if (result.imports.items.length === 0 && result.imports.unresolved.length === 0) {
    lines.push(result.imports.incomplete ? "Imports: incomplete (edge extraction was blocked for this revision)" : "Imports: none");
  } else {
    lines.push("Imports:");
    for (const item of result.imports.items) {
      lines.push(`- ${item.path} ${item.specifier} → ${item.resolvedPath ?? "resolved"}`);
    }
    for (const item of result.imports.unresolved) {
      lines.push(`- ${item.path} ${item.specifier} [unresolved: ${item.reason}]`);
    }
    if (result.imports.incomplete) lines.push("- import edges are incomplete for this revision");
  }
  if (result.importers.items.length === 0) {
    lines.push(result.importers.incomplete ? "Imported by: incomplete" : "Imported by: none");
  } else {
    lines.push("Imported by:");
    for (const item of result.importers.items) lines.push(`- ${item.path} via ${item.specifier}`);
    if (result.importers.incomplete) lines.push("- reverse imports may be incomplete");
  }
  if (result.connections.items.length === 0) {
    lines.push(result.connections.incomplete ? "Connections: incomplete" : "Connections: none");
  } else {
    lines.push("Connections:");
    for (const item of result.connections.items) {
      const ends = item.otherEnds.length === 0
        ? "no other end in the catalog"
        : item.otherEnds.map((end) => `${end.path}${end.callee ? ` ${end.callee}` : ""}`).join(", ");
      lines.push(`- ${item.path} ${item.callee}("${item.literal}") — ${ends}`);
    }
    if (result.connections.incomplete) lines.push("- connection edges are incomplete for this revision");
  }
  return lines.join("\n");
}
