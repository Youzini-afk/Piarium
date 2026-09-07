import type { SymbolMatchTier } from "../knowledge/store.js";

export const DEFAULT_GRAPH_DEFINITION_BUDGET = 40;
export const DEFAULT_GRAPH_CONNECTION_BUDGET = 16;
export const DEFAULT_GRAPH_IMPORT_PER_SEED = 6;
export const DEFAULT_GRAPH_IMPORT_BUDGET = 12;
export const DEFAULT_GRAPH_DEFINITIONS_PER_TERM = 8;

export const GRAPH_DEFINITION_WEIGHT = 10;
export const GRAPH_CONNECTION_WEIGHT = 7;
export const GRAPH_IMPORT_WEIGHT = 3;

export interface ExploreGraphDefinition {
  name: string;
  path: string;
  kind: string;
  match: SymbolMatchTier;
}

export interface ExploreGraphLink {
  path: string;
  kind: string;
  value: string;
  callee?: string;
}

export interface ExploreGraphRecall {
  catalogStats(): Promise<{ symbolCount: number }>;
  searchDefinitions(query: string, k: number): Promise<ExploreGraphDefinition[]>;
  findLinks(value: string): Promise<ExploreGraphLink[]>;
  fileRelations(path: string): Promise<{
    connections: Array<{ callee: string; literal: string }>;
    linksIncomplete: boolean;
  } | null>;
  findImporters(path: string): Promise<{ resolved: Array<{ path: string; specifier: string }> }>;
}

export function pathInRoots(candidate: string, roots: readonly string[] | undefined): boolean {
  if (!roots || roots.length === 0) return true;
  const path = candidate.replace(/\\/g, "/").replace(/^\.\//, "");
  return roots.some((root) => {
    const prefix = root.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
    return !prefix || path === prefix || path.startsWith(`${prefix}/`);
  });
}

export function locateIdentifierLines(lines: readonly string[], name: string): number[] {
  if (!name) return [];
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(?<![\\p{L}\\p{N}_$])${escaped}(?![\\p{L}\\p{N}_$])`, "u");
  const hits: number[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (re.test(lines[index]!)) hits.push(index + 1);
    re.lastIndex = 0;
  }
  return hits;
}

export function locateLiteralLines(lines: readonly string[], literal: string): number[] {
  if (!literal) return [];
  const hits: number[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index]!.includes(literal)) hits.push(index + 1);
  }
  return hits;
}

export function dirnameOf(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  const slash = normalized.lastIndexOf("/");
  return slash === -1 ? "" : normalized.slice(0, slash);
}

export function rankReverseImporters(
  seedPath: string,
  importers: ReadonlyArray<{ path: string; specifier: string }>,
  limit: number,
): Array<{ path: string; specifier: string }> {
  const seedDir = dirnameOf(seedPath);
  return [...importers]
    .toSorted((left, right) => {
      const leftSame = dirnameOf(left.path) === seedDir ? 0 : 1;
      const rightSame = dirnameOf(right.path) === seedDir ? 0 : 1;
      if (leftSame !== rightSame) return leftSame - rightSame;
      const leftHops = (left.specifier.match(/\.\.\//g) ?? []).length;
      const rightHops = (right.specifier.match(/\.\.\//g) ?? []).length;
      return leftHops - rightHops || left.path.localeCompare(right.path) || left.specifier.localeCompare(right.specifier);
    })
    .slice(0, limit);
}
