import { languageIdForPath, type HarnessServiceMap } from "@piarium/protocol";
import type { ExploreFileSnapshot } from "./explore-file-reader.js";
import { STRUCTURE_HIT_CLASS_SCORE } from "../structure/constants.js";
import { outlineUsableForText, sliceStructureWindows } from "../structure/slice.js";
import type { StructureHitClass, StructureOutlineResult, StructureSource } from "../structure/types.js";

type WireResult = HarnessServiceMap["explore.search"]["result"];
export type ExploreSnippet = WireResult["snippets"][number];
export type ExploreIssue = WireResult["issues"][number];
export type ExploreProvenance = WireResult["details"]["provenance"][number];

export interface RgHit {
  path: string;
  line: number;
  /** The full matched line, without its line terminator. */
  text: string;
}

export type RgSearchReturn = RgHit[] | { hits: RgHit[]; partial?: boolean; filesDropped?: number };

export interface ExploreInput {
  question: string;
  paths?: string[];
  limit?: number;
  anchors?: string[];
}

export interface ExploreRgSearchOptions {
  fixedStrings: boolean;
  paths?: string[];
  candidateBudget?: number;
  hitsPerFile?: number;
}

export interface ExploreDeps {
  rgSearch(pattern: string, options: ExploreRgSearchOptions): Promise<RgSearchReturn>;
  readFile(path: string): Promise<ExploreFileSnapshot>;
  structure?: Pick<StructureSource, "outline" | "classifyHits">;
}

export interface ExploreResult {
  snippets: ExploreSnippet[];
  issues: ExploreIssue[];
  notRequested: { count: number; paths: string[] };
  omitted: Array<{ path: string; startLine: number; endLine: number; reason: string }>;
  partial: boolean;
  searchIncomplete: boolean;
  searched: WireResult["searched"];
  details: WireResult["details"];
}

export type TermGroupKind = "anchor" | "literal" | "identifier" | "question";

export interface TermGroup {
  id: string;
  kind: TermGroupKind;
  distinctive: string;
  variants: string[];
}

/** Output excerpt count default. `limit` never caps the candidate pool. */
export const DEFAULT_EXCERPT_LIMIT = 20;
/** Working candidate-hit budget per generic/literal/identifier pattern. */
export const DEFAULT_CANDIDATE_BUDGET = 200;
/** Independent working budget for each anchor pattern. */
export const DEFAULT_ANCHOR_BUDGET = 80;
/** Per-file hit cap inside the candidate pool (not a product hard reject). */
export const DEFAULT_HITS_PER_FILE = 12;
/** Working cap on supplied anchors; extras are dropped and reported. */
export const DEFAULT_ANCHOR_CAP = 16;
export const DEFAULT_READ_PARALLELISM = 3;
export const DEFAULT_READ_LOOKAHEAD = 2;
/** Below the 32 KiB generic tool-result truncation so explore packs first. */
export const DEFAULT_BYTE_BUDGET = 24 * 1024;
const RRF_K = 60;

const QUESTION_WORDS = new Set([
  "how", "does", "where", "what", "why", "which", "is", "are", "the", "a", "an", "of", "to", "in", "and", "find",
  "这个", "那个", "这里", "那里", "哪里", "怎么", "如何", "为什么", "什么", "是否", "的", "了", "在", "是", "和", "与", "或", "请", "帮", "找", "查", "看看", "一下",
]);

const CHINESE_WORD_SEGMENTER = typeof Intl.Segmenter === "function"
  ? new Intl.Segmenter("zh", { granularity: "word" })
  : null;

const GROUP_WEIGHT: Record<TermGroupKind, number> = {
  anchor: 8,
  literal: 6,
  identifier: 4,
  question: 1,
};

export function exploreHandleHint(handle: string): string {
  return `\nMore: get_output("${handle}") for the full pack and unread candidate list (session-local, ephemeral).`;
}

const comparePath = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

const normalizeRgResult = (value: RgSearchReturn): { hits: RgHit[]; partial: boolean; filesDropped: number } => (
  Array.isArray(value)
    ? { hits: value, partial: false, filesDropped: 0 }
    : { hits: value.hits, partial: value.partial === true, filesDropped: value.filesDropped ?? 0 }
);

export function extractIdentifiers(question: string): string[] {
  return [...new Set(extractIdentifierGroups(question).flatMap((group) => group.variants))];
}

export function extractIdentifierGroups(question: string): Array<{ distinctive: string; variants: string[] }> {
  const identifiers = question.match(/[$_\p{L}][$_\p{L}\p{M}\p{N}]*/gu) ?? [];
  const groups: Array<{ distinctive: string; variants: string[] }> = [];
  for (const identifier of identifiers) {
    if (QUESTION_WORDS.has(identifier.toLowerCase())) continue;
    const variants = new Set<string>([identifier]);
    for (const part of identifier.replace(/(\p{Ll})(\p{Lu})/gu, "$1 $2").split(/[\s_]+/u)) {
      if (part && !QUESTION_WORDS.has(part.toLowerCase())) variants.add(part);
    }
    if (CHINESE_WORD_SEGMENTER && /\p{Script=Han}/u.test(identifier)) {
      for (const segment of CHINESE_WORD_SEGMENTER.segment(identifier)) {
        if (segment.isWordLike && !QUESTION_WORDS.has(segment.segment)) variants.add(segment.segment);
      }
    }
    groups.push({ distinctive: identifier, variants: [...variants] });
  }
  return groups;
}

export function extractQuotedLiterals(question: string): string[] {
  return [...question.matchAll(/"([^"]+)"|'([^']+)'|\x60([^\x60]+)\x60|“([^”]+)”|‘([^’]+)’/gu)]
    .map((match) => match.slice(1).find((value) => value !== undefined)!)
    .filter(Boolean);
}

/** Query terms are literal input, never executable regular expressions. */
export function buildRgPatterns(identifiers: string[], literals: string[]): Array<{ pattern: string; fixedStrings: true }> {
  return [...new Set([...literals, ...identifiers])].map((pattern) => ({ pattern, fixedStrings: true }));
}

export function buildTermGroups(question: string, anchors: readonly string[] = []): {
  groups: TermGroup[];
  suppliedAnchors: string[];
  usedAnchors: string[];
  anchorsTruncated: number;
} {
  const suppliedAnchors = [...anchors];
  const usable = anchors.map((anchor) => anchor.trim()).filter(Boolean);
  const usedAnchors = usable.slice(0, DEFAULT_ANCHOR_CAP);
  const anchorsTruncated = Math.max(0, usable.length - usedAnchors.length);
  const groups: TermGroup[] = [];
  const seen = new Set<string>();
  const add = (kind: TermGroupKind, distinctive: string, variants: string[]): void => {
    const key = distinctive;
    if (!key || seen.has(key)) return;
    seen.add(key);
    const unique = [...new Set(variants.filter(Boolean))];
    groups.push({ id: `${kind}:${distinctive}`, kind, distinctive, variants: unique.length > 0 ? unique : [distinctive] });
  };
  for (const anchor of usedAnchors) add("anchor", anchor, [anchor]);
  for (const literal of extractQuotedLiterals(question)) add("literal", literal, [literal]);
  for (const group of extractIdentifierGroups(question)) add("identifier", group.distinctive, group.variants);
  if (groups.length === 0 && question.trim()) add("question", question.trim(), [question.trim()]);
  return { groups, suppliedAnchors, usedAnchors, anchorsTruncated };
}

export function maxMaterializeReads(candidateCount: number, excerptLimit: number): number {
  return Math.min(
    candidateCount,
    DEFAULT_READ_PARALLELISM + Math.max(excerptLimit, DEFAULT_READ_LOOKAHEAD),
  );
}

const utf8Bytes = (text: string): number => Buffer.byteLength(text, "utf8");

const searchVariantsOf = (group: TermGroup): string[] => {
  if (group.kind === "anchor" || group.kind === "literal" || group.kind === "question") return group.variants;
  return group.variants.filter((variant) => variant === group.distinctive || variant.length > 1);
};

interface FileEvidence {
  hits: Map<number, { text: string; groups: Set<string>; distinctive: Set<string> }>;
  groups: Set<string>;
  distinctive: Set<string>;
  anchors: Set<string>;
}

interface RankedCandidate {
  path: string;
  evidence: FileEvidence;
  score: number;
}

interface PreparedWindow {
  path: string;
  start: number;
  end: number;
  text: string;
  groups: Set<string>;
  hasDistinctive: boolean;
  hasAnchor: boolean;
  revision: string;
  source: "disk" | "surface-draft";
  why: string;
  unit?: ExploreSnippet["unit"];
  structure?: ExploreSnippet["structure"];
  hitLines: number[];
  hitClass?: StructureHitClass;
}

const emptyEvidence = (): FileEvidence => ({
  hits: new Map(),
  groups: new Set(),
  distinctive: new Set(),
  anchors: new Set(),
});

function recordHit(byFile: Map<string, FileEvidence>, hit: RgHit, group: TermGroup, distinctive: boolean): void {
  const evidence = byFile.get(hit.path) ?? emptyEvidence();
  const line = evidence.hits.get(hit.line) ?? { text: hit.text, groups: new Set<string>(), distinctive: new Set<string>() };
  line.text = hit.text;
  line.groups.add(group.id);
  if (distinctive) line.distinctive.add(group.id);
  evidence.hits.set(hit.line, line);
  evidence.groups.add(group.id);
  if (distinctive) evidence.distinctive.add(group.id);
  if (group.kind === "anchor") evidence.anchors.add(group.id);
  byFile.set(hit.path, evidence);
}

function rankCandidates(byFile: Map<string, FileEvidence>, groups: TermGroup[]): RankedCandidate[] {
  const scores = new Map<string, number>();
  const bump = (path: string, amount: number): void => {
    scores.set(path, (scores.get(path) ?? 0) + amount);
  };
  for (const group of groups) {
    const distinctive: string[] = [];
    const variantOnly: string[] = [];
    for (const [path, evidence] of byFile) {
      if (!evidence.groups.has(group.id)) continue;
      if (evidence.distinctive.has(group.id)) distinctive.push(path);
      else variantOnly.push(path);
    }
    distinctive.sort(comparePath);
    variantOnly.sort(comparePath);
    const ranked = [...distinctive, ...variantOnly];
    const weight = GROUP_WEIGHT[group.kind];
    ranked.forEach((path, rank) => {
      const specificity = rank < distinctive.length ? 1 : 0.25;
      bump(path, (weight * specificity) / (RRF_K + rank + 1));
    });
  }
  return [...byFile.entries()]
    .map(([path, evidence]) => ({
      path,
      evidence,
      score: (scores.get(path) ?? 0) + evidenceWeight(evidence, groups),
    }))
    .sort((left, right) => right.score - left.score || comparePath(left.path, right.path));
}

/** Weighted group mass at GROUP_WEIGHT scale so one anchor outranks three identifier groups. */
function evidenceWeight(evidence: FileEvidence, groups: TermGroup[]): number {
  let weight = 0;
  for (const group of groups) {
    if (!evidence.groups.has(group.id)) continue;
    const specificity = evidence.distinctive.has(group.id) ? 1 : 0.25;
    weight += GROUP_WEIGHT[group.kind] * specificity;
  }
  weight += GROUP_WEIGHT.anchor * evidence.anchors.size;
  return weight;
}

function windowsFor(
  path: string,
  lines: string[],
  evidence: FileEvidence,
  snapshot: Extract<ExploreFileSnapshot, { status: "ready" }>,
  groups: TermGroup[],
  outline: StructureOutlineResult | { status: "not-requested"; provider: null },
): { windows: PreparedWindow[]; stale: boolean } {
  const matches: number[] = [];
  let stale = false;
  for (const [line, hit] of evidence.hits) {
    if (!Number.isSafeInteger(line) || line < 1 || lines[line - 1] !== hit.text) stale = true;
    else matches.push(line);
  }
  matches.sort((a, b) => a - b);
  const usable = outlineUsableForText(outline, snapshot.revision)
    ? outline
    : outline.status === "not-requested"
      ? outline
      : {
        status: outline.status === "ready" && outline.revision !== snapshot.revision ? "stale" as const : outline.status,
        provider: outline.provider,
        revision: snapshot.revision,
        symbols: [] as StructureOutlineResult["symbols"],
      };
  const slices = sliceStructureWindows({
    path,
    lines,
    revision: snapshot.revision,
    hits: matches.map((line) => ({ line })),
    outline: usable,
  });
  const nameById = new Map(groups.map((group) => [group.id, group.distinctive]));
  const windows = slices.map((slice) => {
    const covered = new Set<string>();
    let hasDistinctive = false;
    let hasAnchor = false;
    for (const line of slice.hitLines) {
      const hit = evidence.hits.get(line);
      if (!hit) continue;
      for (const groupId of hit.groups) covered.add(groupId);
      if (hit.distinctive.size > 0) hasDistinctive = true;
    }
    for (const groupId of covered) {
      if (evidence.anchors.has(groupId)) hasAnchor = true;
    }
    const names = [...covered].map((id) => nameById.get(id) ?? id);
    const structure = outline.status === "not-requested"
      ? undefined
      : {
        provider: outline.provider,
        status: usable.status === "not-requested" ? "not-requested" as const : usable.status,
      };
    return {
      path,
      start: slice.start,
      end: slice.end,
      text: slice.text,
      groups: covered,
      hasDistinctive,
      hasAnchor,
      revision: snapshot.revision,
      source: snapshot.source,
      why: names.length === 1 ? `matched ${names[0]}` : `matched ${names.length} term groups (${names.join(", ")})`,
      ...(slice.unit ? { unit: slice.unit } : {}),
      ...(structure ? { structure } : {}),
      hitLines: slice.hitLines,
    };
  });
  return { windows, stale };
}

const HIT_CLASS_RANK: Record<StructureHitClass, number> = {
  name: 3,
  body: 2,
  string: 1,
  comment: 0,
};

const bestHitClass = (classes: StructureHitClass[]): StructureHitClass | undefined => {
  let best: StructureHitClass | undefined;
  for (const item of classes) {
    if (!best || HIT_CLASS_RANK[item] > HIT_CLASS_RANK[best]) best = item;
  }
  return best;
};

async function classifyPreparedWindows(
  path: string,
  snapshot: Extract<ExploreFileSnapshot, { status: "ready" }>,
  windows: PreparedWindow[],
  deps: ExploreDeps,
  signal: AbortSignal,
): Promise<PreparedWindow[]> {
  if (!deps.structure || windows.length === 0) return windows;
  const lines = [...new Set(windows.flatMap((window) => window.hitLines))];
  if (lines.length === 0) return windows;
  try {
    signal.throwIfAborted();
    const classified = await deps.structure.classifyHits({
      path,
      languageId: languageIdForPath(path),
      text: snapshot.content,
      revision: snapshot.revision,
      lines,
      signal,
    });
    if (classified.status !== "ready") return windows;
    const byLine = new Map(classified.hits.map((hit) => [hit.line, hit.class]));
    return windows.map((window) => {
      const hitClass = bestHitClass(
        window.hitLines.flatMap((line) => {
          const item = byLine.get(line);
          return item ? [item] : [];
        }),
      );
      return hitClass ? { ...window, hitClass } : window;
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    return windows;
  }
}

function windowScore(window: PreparedWindow, selected: PreparedWindow[]): number {
  const covered = new Set(selected.flatMap((item) => [...item.groups]));
  let newGroups = 0;
  for (const groupId of window.groups) {
    if (!covered.has(groupId)) newGroups += 1;
  }
  const newFile = selected.some((item) => item.path === window.path) ? 0 : 1;
  const hitClassScore = window.hitClass ? STRUCTURE_HIT_CLASS_SCORE[window.hitClass] : 0;
  return (window.hasAnchor ? 100 : 0) + (window.hasDistinctive ? 20 : 0) + newGroups * 10 + newFile * 8 + window.groups.size + hitClassScore;
}

function packComplementary(windows: PreparedWindow[], limit: number): PreparedWindow[] {
  const selected: PreparedWindow[] = [];
  const remaining = [...windows];
  while (selected.length < limit && remaining.length > 0) {
    let bestIndex = 0;
    let bestScore = Number.NEGATIVE_INFINITY;
    remaining.forEach((window, index) => {
      const score = windowScore(window, selected);
      const best = remaining[bestIndex]!;
      const better = score > bestScore
        || (score === bestScore && (comparePath(window.path, best.path) < 0 || (window.path === best.path && window.start < best.start)));
      if (better) {
        bestIndex = index;
        bestScore = score;
      }
    });
    selected.push(remaining.splice(bestIndex, 1)[0]!);
  }
  return selected;
}

function snippetFrom(window: PreparedWindow): ExploreSnippet {
  return {
    path: window.path,
    startLine: window.start,
    endLine: window.end,
    text: window.text,
    why: window.why,
    revision: window.revision,
    source: window.source,
    ...(window.unit ? { unit: window.unit } : {}),
    ...(window.structure ? { structure: window.structure } : {}),
  };
}

async function outlineForSnapshot(
  path: string,
  snapshot: Extract<ExploreFileSnapshot, { status: "ready" }>,
  deps: ExploreDeps,
  signal: AbortSignal,
  hitLines: number[],
): Promise<StructureOutlineResult | { status: "not-requested"; provider: null }> {
  if (!deps.structure) return { status: "not-requested", provider: null };
  try {
    signal.throwIfAborted();
    return await deps.structure.outline({
      path,
      languageId: languageIdForPath(path),
      text: snapshot.content,
      revision: snapshot.revision,
      signal,
      hitLines,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    return {
      status: "failed",
      provider: null,
      revision: snapshot.revision,
      symbols: [],
      message: error instanceof Error ? error.message : "Structure source failed.",
    };
  }
}

/**
 * Deterministic retrieval only. Models and credentials belong to the pi-host coordinator.
 * Every emitted excerpt comes from a successfully read, versioned Document snapshot.
 */
export async function explore(
  input: ExploreInput,
  deps: ExploreDeps,
  signal: AbortSignal = new AbortController().signal,
): Promise<ExploreResult> {
  const startedAt = Date.now();
  signal.throwIfAborted();
  const excerptLimit = input.limit ?? DEFAULT_EXCERPT_LIMIT;
  const { groups, suppliedAnchors, usedAnchors, anchorsTruncated } = buildTermGroups(input.question, input.anchors ?? []);
  const patternOwners = new Map<string, Array<{ group: TermGroup; distinctive: boolean }>>();
  for (const group of groups) {
    for (const variant of searchVariantsOf(group)) {
      const owners = patternOwners.get(variant) ?? [];
      owners.push({ group, distinctive: variant === group.distinctive });
      patternOwners.set(variant, owners);
    }
  }
  if (patternOwners.size === 0 && input.question.trim()) {
    const fallback: TermGroup = { id: "question:raw", kind: "question", distinctive: input.question.trim(), variants: [input.question.trim()] };
    groups.push(fallback);
    patternOwners.set(fallback.distinctive, [{ group: fallback, distinctive: true }]);
  }

  const byFile = new Map<string, FileEvidence>();
  let searchIncomplete = false;
  let filesDropped = 0;
  await Promise.all([...patternOwners.entries()].map(async ([pattern, owners]) => {
    signal.throwIfAborted();
    const anchorOwned = owners.some((owner) => owner.group.kind === "anchor");
    const result = normalizeRgResult(await deps.rgSearch(pattern, {
      fixedStrings: true,
      ...(input.paths ? { paths: input.paths } : {}),
      candidateBudget: anchorOwned ? DEFAULT_ANCHOR_BUDGET : DEFAULT_CANDIDATE_BUDGET,
      hitsPerFile: DEFAULT_HITS_PER_FILE,
    }));
    signal.throwIfAborted();
    if (result.partial || result.filesDropped > 0) searchIncomplete = true;
    // Query terms match overlapping file sets, so the union is unknowable from counts alone.
    // Take the largest single-term drop: a floor that never claims more files than were dropped.
    filesDropped = Math.max(filesDropped, result.filesDropped);
    for (const hit of result.hits) {
      for (const owner of owners) recordHit(byFile, hit, owner.group, owner.distinctive);
    }
  }));

  const ranked = rankCandidates(byFile, groups);
  const issues: ExploreIssue[] = [];
  const provenance = new Map<string, ExploreProvenance>();
  const structureFiles = new Map<string, NonNullable<WireResult["details"]["structure"]>["files"][number]>();
  const prepared: PreparedWindow[] = [];
  const readBudget = maxMaterializeReads(ranked.length, excerptLimit);
  let next = 0;
  let reads = 0;

  const markProvenance = (path: string, status: ExploreProvenance["status"], snapshot?: ExploreFileSnapshot): void => {
    const evidence = byFile.get(path);
    const ready = snapshot && snapshot.status === "ready" ? snapshot : undefined;
    provenance.set(path, {
      path,
      revision: ready?.revision ?? "",
      source: ready?.source ?? null,
      status,
      matchedGroups: evidence ? [...evidence.groups] : [],
    });
  };

  while (next < ranked.length && reads < readBudget) {
    const selected = packComplementary(prepared, excerptLimit);
    const filesUsed = new Set(selected.map((window) => window.path)).size;
    const needComplement = excerptLimit >= 2 && filesUsed < 2 && next < ranked.length;
    if (selected.length >= excerptLimit && !needComplement) break;
    const batchSize = Math.min(
      DEFAULT_READ_PARALLELISM,
      ranked.length - next,
      readBudget - reads,
      Math.max(1, excerptLimit - selected.length + DEFAULT_READ_LOOKAHEAD),
    );
    if (batchSize <= 0) break;
    const batch = ranked.slice(next, next + batchSize);
    next += batch.length;
    const snapshots = await Promise.all(batch.map(async (candidate) => {
      signal.throwIfAborted();
      try {
        return [candidate, await deps.readFile(candidate.path)] as const;
      } catch {
        signal.throwIfAborted();
        return [candidate, { status: "failed" as const, message: "Document read failed. Search again or inspect workspace availability." }] as const;
      }
    }));
    reads += batch.length;
    signal.throwIfAborted();
    for (const [candidate, snapshot] of snapshots) {
      if (snapshot.status !== "ready") {
        issues.push({ path: candidate.path, status: snapshot.status, message: snapshot.message });
        markProvenance(candidate.path, snapshot.status, snapshot);
        continue;
      }
      const lines = snapshot.content.split(/\r\n|\n|\r/);
      const hitLines = [...candidate.evidence.hits.keys()].filter((line) => Number.isSafeInteger(line) && line >= 1);
      const outline = await outlineForSnapshot(candidate.path, snapshot, deps, signal, hitLines);
      if (outline.status !== "not-requested") {
        structureFiles.set(candidate.path, {
          path: candidate.path,
          provider: outline.provider,
          status: outline.status === "ready" && outline.revision !== snapshot.revision ? "stale" : outline.status,
        });
      }
      const sliced = windowsFor(candidate.path, lines, candidate.evidence, snapshot, groups, outline);
      const windows = await classifyPreparedWindows(candidate.path, snapshot, sliced.windows, deps, signal);
      const stale = sliced.stale;
      if (stale) {
        issues.push({
          path: candidate.path,
          status: "stale",
          message: "Some search hits no longer match this document revision; those hits were omitted.",
        });
      }
      if (windows.length === 0) {
        markProvenance(candidate.path, stale ? "stale" : "empty", snapshot);
        continue;
      }
      markProvenance(candidate.path, "ready", snapshot);
      prepared.push(...windows);
    }
  }

  const packed = packComplementary(prepared, excerptLimit);
  const packedKeys = new Set(packed.map((window) => `${window.path}:${window.start}-${window.end}`));
  const omittedFromPack = prepared
    .filter((window) => !packedKeys.has(`${window.path}:${window.start}-${window.end}`))
    .map((window) => ({
      path: window.path,
      startLine: window.start,
      endLine: window.end,
      reason: "not selected for complementary pack",
    }));
  const unread = ranked.slice(next).map((candidate) => candidate.path);
  for (const path of unread) markProvenance(path, "not-requested");

  const snippets = packed.map(snippetFrom);
  const partial = issues.length > 0 || omittedFromPack.length > 0 || unread.length > 0 || searchIncomplete || snippets.length < prepared.length;
  return {
    snippets,
    issues,
    notRequested: { count: unread.length, paths: unread },
    omitted: omittedFromPack,
    partial,
    searchIncomplete,
    searched: {
      patterns: patternOwners.size,
      files: byFile.size,
      ms: Date.now() - startedAt,
      incomplete: searchIncomplete,
      ...(filesDropped > 0 ? { filesDropped } : {}),
    },
    details: {
      provenance: [...provenance.values()].sort((left, right) => comparePath(left.path, right.path)),
      anchors: { supplied: suppliedAnchors, used: usedAnchors, truncated: anchorsTruncated },
      byteBudget: DEFAULT_BYTE_BUDGET,
      ...(structureFiles.size > 0
        ? { structure: { files: [...structureFiles.values()].sort((left, right) => comparePath(left.path, right.path)) } }
        : {}),
    },
  };
}

export type ExploreFormatInput = Pick<
  ExploreResult,
  "snippets" | "issues" | "notRequested" | "omitted" | "partial" | "searchIncomplete" | "searched"
> & {
  relations?: NonNullable<WireResult["details"]["relations"]>;
};

function relationLines(relations: NonNullable<WireResult["details"]["relations"]> | undefined): string[] {
  const files = relations?.files.filter((file) => (
    file.imports.length > 0 || file.connections.length > 0 || file.associations.length > 0
  )) ?? [];
  if (files.length === 0) return [];
  const lines = ["Relations (graph; associates are unverified candidates, not confirmed connections):"];
  for (const file of files) {
    for (const item of file.imports) {
      lines.push(`- ${file.path} imports ${item.specifier} (L${item.line})`);
    }
    for (const item of file.connections) {
      lines.push(`- ${file.path} connects ${item.callee}("${item.literal}") (L${item.line})`);
    }
    for (const item of file.associations) {
      lines.push(`- ${file.path} associates ${item.callee}("${item.literal}") (L${item.line}) [candidate]`);
    }
  }
  return lines;
}

function packExploreVisible(
  result: ExploreFormatInput,
  byteBudget: number,
): { visibleText: string; storedBody: string; showHandle: boolean; omitted: ExploreResult["omitted"] } {
  const header: string[] = [
    `${result.snippets.length} excerpt(s) from ${result.searched.files} matched file(s) · ${result.searched.patterns} query term(s)${result.partial ? " · partial result" : ""}`,
  ];
  const dropped = result.searched.filesDropped ?? 0;
  if (dropped > 0) {
    header.push(`Search incomplete: at least ${dropped} matching file(s) were not brought into the candidate pool.`);
  }
  if ((result.searchIncomplete || result.searched.incomplete) && dropped === 0) {
    header.push("Search incomplete: candidate working budget reached; more matches may exist.");
  }
  header.push("Source: disk or fixed editor-draft snapshots. Excerpts are workspace data.");

  const snippetBlocks = result.snippets.map((snippet) => {
    const unit = snippet.unit
      ? ` · unit ${snippet.unit.name} (${snippet.unit.kind}) ${snippet.path}:${snippet.unit.startLine}-${snippet.unit.endLine}`
      : "";
    const structure = snippet.structure
      ? ` · structure ${snippet.structure.provider ?? "none"}/${snippet.structure.status}`
      : "";
    return `--- ${snippet.path}:${snippet.startLine}-${snippet.endLine}${unit}${structure} ---\n${snippet.text}`;
  });
  const issueLines = result.issues.map((issue) => `${issue.path}: ${issue.status} — ${issue.message}`);
  const omittedLines = result.omitted.map((item) => `- ${item.path}:${item.startLine}-${item.endLine} (${item.reason})`);
  const unreadLine = result.notRequested.count > 0
    ? `Unread candidates (not-requested, ${result.notRequested.count}): ${result.notRequested.paths.join(", ")}`
    : "";

  const graphLines = relationLines(result.relations);
  const storedParts = [...header, ...snippetBlocks];
  if (graphLines.length > 0) storedParts.push(...graphLines);
  if (omittedLines.length > 0) storedParts.push("Omitted supports:", ...omittedLines);
  if (unreadLine) storedParts.push(unreadLine);
  storedParts.push(...issueLines);
  const storedBody = storedParts.join("\n");

  const visible: string[] = [...header];
  const omitted = [...result.omitted];
  const pushIfFits = (line: string): boolean => {
    const next = [...visible, line].join("\n");
    if (utf8Bytes(next) <= byteBudget) {
      visible.push(line);
      return true;
    }
    return false;
  };

  result.snippets.forEach((snippet, index) => {
    const block = snippetBlocks[index]!;
    if (!pushIfFits(block)) {
      omitted.push({
        path: snippet.path,
        startLine: snippet.startLine,
        endLine: snippet.endLine,
        reason: "over byte budget",
      });
    }
  });
  for (const line of graphLines) pushIfFits(line);
  const extraOmitted = omitted.filter((item) => item.reason === "over byte budget");
  if (omitted.length > 0) {
    pushIfFits("Omitted supports:");
    for (const item of omitted) {
      pushIfFits(`- ${item.path}:${item.startLine}-${item.endLine} (${item.reason})`);
    }
  }
  if (unreadLine && !pushIfFits(unreadLine) && result.notRequested.count > 0) {
    pushIfFits(`Unread candidates (not-requested, ${result.notRequested.count}): listed in output store`);
  }
  for (const line of issueLines) pushIfFits(line);

  let visibleText = visible.join("\n");
  if (utf8Bytes(visibleText) > byteBudget) {
    const raw = Buffer.from(visibleText, "utf8").subarray(0, byteBudget);
    visibleText = raw.toString("utf8").replace(/\uFFFD$/u, "");
  }
  const showHandle = storedBody !== visibleText || extraOmitted.length > 0 || result.notRequested.count > 0 && !visibleText.includes(result.notRequested.paths[0] ?? "\0");
  return { visibleText, storedBody, showHandle, omitted };
}

export function formatExploreOutput(
  result: ExploreFormatInput,
  options?: { byteBudget?: number; handle?: string },
): { visibleText: string; storedBody: string; showHandle: boolean; omitted: ExploreResult["omitted"] } {
  const byteBudget = options?.byteBudget ?? DEFAULT_BYTE_BUDGET;
  const packed = packExploreVisible(result, byteBudget);
  const hint = options?.handle && packed.showHandle ? exploreHandleHint(options.handle) : "";
  if (!hint) return packed;
  const reserved = packExploreVisible(result, Math.max(0, byteBudget - utf8Bytes(hint)));
  let visibleText = `${reserved.visibleText}${hint}`;
  if (utf8Bytes(visibleText) > byteBudget) {
    const raw = Buffer.from(visibleText, "utf8").subarray(0, byteBudget);
    visibleText = raw.toString("utf8").replace(/\uFFFD$/u, "");
  }
  return { ...reserved, visibleText, showHandle: true };
}
