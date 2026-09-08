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

import type { HarnessFileRoleDecision, RelatedQueryResult, RelatedQueryStatus } from "@piarium/protocol";
import { resolveImportSpecifier } from "../knowledge/import-resolve.js";
import type { KnowledgeStore } from "../knowledge/store.js";
import { classifyFileRoleDecision } from "./file-role.js";

export interface RelatedQueryInput {
  anchor: string;
}

/**
 * Visible caps so a hub file or a common name cannot hand the generic 32 KiB
 * tool-result truncation the decision of which section disappears. `details`
 * still carries every item; only the text is capped, and it says how many it
 * left out (D-139).
 */
export const RELATED_SECTION_LIMIT = 40;
export const RELATED_FOCUS_LIMIT = 8;

function capped<T>(items: readonly T[], limit: number): { shown: readonly T[]; omitted: number } {
  return items.length <= limit
    ? { shown: items, omitted: 0 }
    : { shown: items.slice(0, limit), omitted: items.length - limit };
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
    roles: [],
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

  const focus = capped(focusPaths.toSorted(compareText), RELATED_FOCUS_LIMIT);
  for (const path of focus.shown) {
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
    roles: [],
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
  result.roles = rolesForRelated(result);
  result.text = formatRelatedText(result, focus.omitted);
  return result;
}

function rolesForRelated(result: RelatedQueryResult): HarnessFileRoleDecision[] {
  const paths = new Set<string>();
  if (result.anchor.kind === "path" && result.anchor.value) paths.add(result.anchor.value.replace(/\\/g, "/"));
  for (const item of result.definitions) paths.add(item.path);
  for (const item of result.imports.items) {
    paths.add(item.path);
    if (item.resolvedPath) paths.add(item.resolvedPath);
  }
  for (const item of result.imports.unresolved) paths.add(item.path);
  for (const item of result.importers.items) paths.add(item.path);
  for (const item of result.connections.items) {
    paths.add(item.path);
    for (const end of item.otherEnds) paths.add(end.path);
  }
  return [...paths].toSorted(compareText).map((path) => {
    const decision = classifyFileRoleDecision(path);
    return { path, role: decision.role, ground: decision.ground };
  });
}

function formatRelatedText(result: RelatedQueryResult, focusOmitted: number): string {
  const lines: string[] = [
    `related ${result.anchor.value} (${result.anchor.kind}) · ${result.status}`,
    "File-level import topology and connection endpoints from the symbol graph. Use lsp.references for precise who-references-this-symbol at a position; related does not need a language server.",
  ];
  if (focusOmitted > 0) {
    lines.push(`Anchor matched ${focusOmitted} more file(s) than were walked; the first ${RELATED_FOCUS_LIMIT} in path order are below. Narrow the anchor to a path for the rest.`);
  }
  if (result.roles.length > 0) {
    lines.push("Roles (query-time, not stored on the graph):");
    const shown = capped(result.roles, RELATED_SECTION_LIMIT);
    for (const item of shown.shown) lines.push(`- ${item.path} ${item.role} · ${item.ground}`);
    if (shown.omitted > 0) lines.push(`- … ${shown.omitted} more (full list in details)`);
  }
  const note = (omitted: number): void => {
    if (omitted > 0) lines.push(`- … ${omitted} more (full list in details)`);
  };
  if (result.definitions.length === 0) lines.push("Defines: none");
  else {
    lines.push("Defines:");
    const shown = capped(result.definitions, RELATED_SECTION_LIMIT);
    for (const item of shown.shown) lines.push(`- ${item.path} ${item.name} (${item.kind})`);
    note(shown.omitted);
  }
  if (result.imports.items.length === 0 && result.imports.unresolved.length === 0) {
    lines.push(result.imports.incomplete ? "Imports: incomplete (edge extraction was blocked for this revision)" : "Imports: none");
  } else {
    lines.push("Imports:");
    const shown = capped(result.imports.items, RELATED_SECTION_LIMIT);
    for (const item of shown.shown) {
      lines.push(`- ${item.path} ${item.specifier} → ${item.resolvedPath ?? "resolved"}`);
    }
    note(shown.omitted);
    const unresolved = capped(result.imports.unresolved, RELATED_SECTION_LIMIT);
    for (const item of unresolved.shown) {
      lines.push(`- ${item.path} ${item.specifier} [unresolved: ${item.reason}]`);
    }
    note(unresolved.omitted);
    if (result.imports.incomplete) lines.push("- import edges are incomplete for this revision");
  }
  if (result.importers.items.length === 0) {
    lines.push(result.importers.incomplete ? "Imported by: incomplete" : "Imported by: none");
  } else {
    lines.push("Imported by:");
    const shown = capped(result.importers.items, RELATED_SECTION_LIMIT);
    for (const item of shown.shown) lines.push(`- ${item.path} via ${item.specifier}`);
    note(shown.omitted);
    if (result.importers.incomplete) lines.push("- reverse imports may be incomplete");
  }
  if (result.connections.items.length === 0) {
    lines.push(result.connections.incomplete ? "Connections: incomplete" : "Connections: none");
  } else {
    lines.push("Connections:");
    const shown = capped(result.connections.items, RELATED_SECTION_LIMIT);
    for (const item of shown.shown) {
      const ends = capped(item.otherEnds, RELATED_SECTION_LIMIT);
      const rendered = ends.shown.map((end) => `${end.path}${end.callee ? ` ${end.callee}` : ""}`).join(", ");
      const text = item.otherEnds.length === 0
        ? "no other end in the catalog"
        : ends.omitted > 0 ? `${rendered}, … ${ends.omitted} more` : rendered;
      lines.push(`- ${item.path} ${item.callee}("${item.literal}") — ${text}`);
    }
    note(shown.omitted);
    if (result.connections.incomplete) lines.push("- connection edges are incomplete for this revision");
  }
  return lines.join("\n");
}
