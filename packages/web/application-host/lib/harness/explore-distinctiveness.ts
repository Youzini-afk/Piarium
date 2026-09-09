/**
 * Query-internal term weights for one explore() call.
 *
 * This is not corpus IDF. N and df are the unique files in this call's
 * candidate pool after hit-budget truncation (D-153). Variants of one
 * group share one row; repeating a term inside a file does not raise df.
 */

import type { ExploreDistinctivenessDetails, ExploreTermCoverage, ExploreTermWeight } from "@piarium/protocol";
import type { TermGroup, TermGroupKind } from "./explore-query.js";

/** Ordinary match contribution. Extra distinctiveness is added only when coverage is complete. */
export const ORDINARY_MATCH_WEIGHT = 1;

export interface PatternCoverage {
  coverage: ExploreTermCoverage;
  filesDropped: number;
}

export interface FileGroupPresence {
  groups: ReadonlySet<string>;
  distinctive: ReadonlySet<string>;
}

const kindOf = (kind: TermGroupKind): ExploreTermWeight["kind"] => {
  if (kind === "anchor") return "anchor";
  if (kind === "question" || kind === "plan") return "content";
  return "object";
};

const worseCoverage = (left: ExploreTermCoverage, right: ExploreTermCoverage): ExploreTermCoverage => {
  if (left === "lower-bound" || right === "lower-bound") return "lower-bound";
  if (left === "unknown" || right === "unknown") return "unknown";
  return "complete";
};

export function coverageFromSearch(input: {
  filesDropped: number;
  fileCoverage?: ExploreTermCoverage;
  partial: boolean;
}): ExploreTermCoverage {
  if (input.fileCoverage) return input.fileCoverage;
  if (input.filesDropped > 0) return "lower-bound";
  if (input.partial) return "unknown";
  return "complete";
}

/**
 * Unique-file coverage for one search-service call. Per-file hit caps and
 * display-budget trims do not belong here.
 */
export function uniqueFileCoverage(input: {
  filesDropped: number;
  backendIncomplete: boolean;
  backendCapped: boolean;
}): ExploreTermCoverage {
  if (input.filesDropped > 0 || input.backendIncomplete) return "lower-bound";
  if (input.backendCapped) return "unknown";
  return "complete";
}

/**
 * w(g) = 1 + ln((N+1)/(df+1)) when unique-file coverage is complete.
 * Truncated or unknown coverage keeps the ordinary match contribution and
 * does not receive an unproven rarity bonus.
 */
export function queryInternalWeight(poolFiles: number, uniqueFiles: number, coverage: ExploreTermCoverage): number {
  if (coverage !== "complete" || poolFiles <= 0) return ORDINARY_MATCH_WEIGHT;
  return ORDINARY_MATCH_WEIGHT + Math.log((poolFiles + 1) / (uniqueFiles + 1));
}

export function matchStrength(presence: FileGroupPresence, groupId: string): number {
  if (presence.distinctive.has(groupId)) return 1;
  if (presence.groups.has(groupId)) return 0.5;
  return 0;
}

export function weightedCoverage(
  presence: FileGroupPresence,
  groups: readonly TermGroup[],
  weights: ReadonlyMap<string, number>,
): number {
  let sum = 0;
  for (const group of groups) {
    const match = matchStrength(presence, group.id);
    if (match === 0) continue;
    sum += (weights.get(group.id) ?? ORDINARY_MATCH_WEIGHT) * match;
  }
  return sum;
}

export function buildTermWeightTable(
  groups: readonly TermGroup[],
  byFile: ReadonlyMap<string, FileGroupPresence>,
  launched: ReadonlyMap<string, PatternCoverage>,
  searchVariants: (group: TermGroup) => readonly string[],
): ExploreDistinctivenessDetails {
  const poolFiles = byFile.size;
  const terms: ExploreTermWeight[] = groups.map((group) => {
    let uniqueFiles = 0;
    for (const evidence of byFile.values()) {
      if (evidence.groups.has(group.id)) uniqueFiles += 1;
    }
    const variants = searchVariants(group);
    let coverage: ExploreTermCoverage = variants.length === 0 ? "unknown" : "complete";
    let sawLaunched = false;
    for (const variant of variants) {
      const pattern = launched.get(variant);
      if (!pattern) continue;
      sawLaunched = true;
      coverage = worseCoverage(coverage, pattern.coverage);
    }
    if (!sawLaunched) coverage = "unknown";
    return {
      term: group.distinctive,
      kind: kindOf(group.kind),
      uniqueFiles,
      coverage,
      variants: [...variants],
      weight: queryInternalWeight(poolFiles, uniqueFiles, coverage),
    };
  });
  return { scope: "query-pool", poolFiles, terms };
}

export function weightByGroupId(
  groups: readonly TermGroup[],
  table: ExploreDistinctivenessDetails,
): Map<string, number> {
  const byTerm = new Map(table.terms.map((row) => [row.term, row.weight]));
  const weights = new Map<string, number>();
  for (const group of groups) {
    weights.set(group.id, byTerm.get(group.distinctive) ?? ORDINARY_MATCH_WEIGHT);
  }
  return weights;
}
