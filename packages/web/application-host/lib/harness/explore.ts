import { languageIdForPath, type ExploreGraphDetails, type ExploreGraphStatus, type HarnessServiceMap } from "@piarium/protocol";
import type { ExploreFileSnapshot } from "./explore-file-reader.js";
import { STRUCTURE_HIT_CLASS_SCORE } from "../structure/constants.js";
import { outlineUsableForText, sliceStructureWindows } from "../structure/slice.js";
import type { StructureHitClass, StructureOutlineResult, StructureSource } from "../structure/types.js";
import {
  DEFAULT_GRAPH_CONNECTION_BUDGET,
  DEFAULT_GRAPH_DEFINITION_BUDGET,
  DEFAULT_GRAPH_DEFINITIONS_PER_TERM,
  DEFAULT_GRAPH_IMPORT_BUDGET,
  DEFAULT_GRAPH_IMPORT_PER_SEED,
  GRAPH_CONNECTION_WEIGHT,
  GRAPH_DEFINITION_WEIGHT,
  GRAPH_IMPORT_WEIGHT,
  locateIdentifierLines,
  locateLiteralLines,
  pathInRoots,
  rankReverseImporters,
  type ExploreGraphRecall,
} from "./explore-graph.js";

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
  graph?: ExploreGraphRecall;
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
  graphWhy: string[];
  graphSources: Set<GraphCandidateSource>;
  graphLocate: Array<{ text: string; kind: "identifier" | "literal" }>;
}

type GraphCandidateSource = "definition" | "connection" | "import";

/**
 * Pack-time boost per graph source. Complementary packing does not read the RRF
 * ranking, so a mention would otherwise outrank the file that defines the name.
 */
const GRAPH_PACK_BOOST: Record<GraphCandidateSource, number> = {
  definition: 30,
  connection: 16,
  import: 4,
};

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
  graphBoost: number;
}

const emptyEvidence = (): FileEvidence => ({
  hits: new Map(),
  groups: new Set(),
  distinctive: new Set(),
  anchors: new Set(),
  graphWhy: [],
  graphSources: new Set(),
  graphLocate: [],
});

function attachGraphWhy(
  evidence: FileEvidence,
  source: GraphCandidateSource,
  why: string,
  locate: FileEvidence["graphLocate"][number],
): void {
  evidence.graphSources.add(source);
  if (!evidence.graphWhy.includes(why)) evidence.graphWhy.push(why);
  if (!evidence.graphLocate.some((item) => item.kind === locate.kind && item.text === locate.text)) {
    evidence.graphLocate.push(locate);
  }
}

function applyGraphLocate(lines: readonly string[], evidence: FileEvidence): void {
  for (const locate of evidence.graphLocate) {
    const found = locate.kind === "identifier"
      ? locateIdentifierLines(lines, locate.text)
      : locateLiteralLines(lines, locate.text);
    for (const line of found) {
      if (evidence.hits.has(line)) continue;
      evidence.hits.set(line, {
        text: lines[line - 1]!,
        groups: new Set(),
        distinctive: new Set(),
      });
    }
  }
}

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

function rankCandidates(
  byFile: Map<string, FileEvidence>,
  groups: TermGroup[],
  extra: ReadonlyArray<{ weight: number; paths: readonly string[] }> = [],
): RankedCandidate[] {
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
  for (const source of extra) {
    source.paths.forEach((path, rank) => {
      bump(path, source.weight / (RRF_K + rank + 1));
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
    const matched = names.length === 1
      ? `matched ${names[0]}`
      : names.length > 1
        ? `matched ${names.length} term groups (${names.join(", ")})`
        : "";
    const why = evidence.graphWhy.length > 0
      ? (matched ? `${evidence.graphWhy.join("; ")}; ${matched}` : evidence.graphWhy.join("; "))
      : (matched || "matched search terms");
    const graphBoost = [...evidence.graphSources]
      .reduce((best, source) => Math.max(best, GRAPH_PACK_BOOST[source]), 0);
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
      why,
      ...(slice.unit ? { unit: slice.unit } : {}),
      ...(structure ? { structure } : {}),
      hitLines: slice.hitLines,
      graphBoost,
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
  return (window.hasAnchor ? 100 : 0) + (window.hasDistinctive ? 20 : 0) + newGroups * 10 + newFile * 8 + window.groups.size + hitClassScore + window.graphBoost;
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

  const extraRanks: Array<{ weight: number; paths: string[] }> = [];
  let graphStatus: ExploreGraphStatus = deps.graph ? "unavailable" : "not-requested";
  let graphDefinitions = 0;
  let graphConnections = 0;
  let graphImports = 0;
  let graphFilesDropped = 0;
  let graphPartial = false;

  if (deps.graph) {
    try {
      const stats = await deps.graph.catalogStats();
      if (stats.symbolCount === 0) {
        graphStatus = "empty";
      } else {
        const exactPaths: string[] = [];
        const containsPaths: string[] = [];
        const seen = new Set<string>();
        let definitionDropped = 0;
        const terms = groups
          .filter((group) => group.kind === "anchor" || group.kind === "literal" || group.kind === "identifier")
          .map((group) => group.distinctive);
        const definitionCount = (): number => exactPaths.length + containsPaths.length;
        const acceptDefinition = (path: string, match: "exact" | "name-contains"): boolean => {
          if (seen.has(path)) return true;
          if (definitionCount() >= DEFAULT_GRAPH_DEFINITION_BUDGET) return false;
          seen.add(path);
          if (match === "exact") exactPaths.push(path);
          else containsPaths.push(path);
          return true;
        };
        for (const term of terms) {
          signal.throwIfAborted();
          const hits = await deps.graph.searchDefinitions(term, DEFAULT_GRAPH_DEFINITIONS_PER_TERM);
          for (const hit of hits) {
            if (hit.match === "path-contains" || !pathInRoots(hit.path, input.paths)) continue;
            const already = byFile.has(hit.path);
            if (!already && !acceptDefinition(hit.path, hit.match)) {
              definitionDropped += 1;
              continue;
            }
            if (already) acceptDefinition(hit.path, hit.match);
            const evidence = byFile.get(hit.path) ?? emptyEvidence();
            attachGraphWhy(evidence, "definition", `definition of ${hit.name} (${hit.kind})`, { text: hit.name, kind: "identifier" });
            byFile.set(hit.path, evidence);
            graphDefinitions += 1;
          }
        }
        if (definitionDropped > 0) {
          graphFilesDropped = Math.max(graphFilesDropped, definitionDropped);
          graphPartial = true;
        }
        extraRanks.push({ weight: GRAPH_DEFINITION_WEIGHT, paths: [...exactPaths, ...containsPaths] });
        graphStatus = "ready";
      }
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw error;
      const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
      graphStatus = code === "unavailable" ? "unavailable" : "failed";
    }
  }

  const ranked = rankCandidates(byFile, groups, extraRanks);
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

  const materializeBatch = async (batch: readonly RankedCandidate[]): Promise<void> => {
    const snapshots = await Promise.all(batch.map(async (candidate) => {
      signal.throwIfAborted();
      try {
        return [candidate, await deps.readFile(candidate.path)] as const;
      } catch {
        signal.throwIfAborted();
        return [candidate, { status: "failed" as const, message: "Document read failed. Search again or inspect workspace availability." }] as const;
      }
    }));
    signal.throwIfAborted();
    for (const [candidate, snapshot] of snapshots) {
      if (snapshot.status !== "ready") {
        issues.push({ path: candidate.path, status: snapshot.status, message: snapshot.message });
        markProvenance(candidate.path, snapshot.status, snapshot);
        continue;
      }
      const lines = snapshot.content.split(/\r\n|\n|\r/);
      applyGraphLocate(lines, candidate.evidence);
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
      if (sliced.stale) {
        issues.push({
          path: candidate.path,
          status: "stale",
          message: "Some search hits no longer match this document revision; those hits were omitted.",
        });
      }
      if (windows.length === 0) {
        markProvenance(candidate.path, sliced.stale ? "stale" : "empty", snapshot);
        continue;
      }
      markProvenance(candidate.path, "ready", snapshot);
      prepared.push(...windows);
    }
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
    reads += batch.length;
    await materializeBatch(batch);
  }

  let latestRanked = ranked;
  if (deps.graph && graphStatus === "ready") {
    const provisional = packComplementary(prepared, excerptLimit);
    try {
      const seedPaths = [...new Set(provisional.map((window) => window.path))];
      const connectionPaths: string[] = [];
      const importPaths: string[] = [];
      const seenNew = new Set<string>();
      const literals = new Set<string>();
      for (const snippet of provisional) {
        signal.throwIfAborted();
        const relations = await deps.graph.fileRelations(snippet.path);
        if (!relations) continue;
        for (const conn of relations.connections) {
          if (snippet.text.includes(conn.literal)) literals.add(conn.literal);
        }
      }
      let connectionDropped = 0;
      for (const literal of literals) {
        signal.throwIfAborted();
        for (const end of await deps.graph.findLinks(literal)) {
          if (seedPaths.includes(end.path) || !pathInRoots(end.path, input.paths)) continue;
          const already = byFile.has(end.path);
          if (!already && connectionPaths.length >= DEFAULT_GRAPH_CONNECTION_BUDGET) {
            connectionDropped += 1;
            continue;
          }
          const evidence = byFile.get(end.path) ?? emptyEvidence();
          attachGraphWhy(evidence, "connection", `other end of connection "${literal}"`, { text: literal, kind: "literal" });
          byFile.set(end.path, evidence);
          graphConnections += 1;
          if (already || seenNew.has(end.path)) continue;
          seenNew.add(end.path);
          connectionPaths.push(end.path);
        }
      }
      let importDropped = 0;
      for (const seed of seedPaths) {
        signal.throwIfAborted();
        const rankedImporters = rankReverseImporters(
          seed,
          (await deps.graph.findImporters(seed)).resolved,
          DEFAULT_GRAPH_IMPORT_PER_SEED,
        );
        for (const importer of rankedImporters) {
          if (seedPaths.includes(importer.path) || !pathInRoots(importer.path, input.paths)) continue;
          const already = byFile.has(importer.path);
          if (!already && importPaths.length >= DEFAULT_GRAPH_IMPORT_BUDGET) {
            importDropped += 1;
            continue;
          }
          const evidence = byFile.get(importer.path) ?? emptyEvidence();
          attachGraphWhy(evidence, "import", `imports ${seed}`, { text: importer.specifier, kind: "literal" });
          byFile.set(importer.path, evidence);
          graphImports += 1;
          if (already || seenNew.has(importer.path)) continue;
          seenNew.add(importer.path);
          importPaths.push(importer.path);
        }
      }
      if (connectionDropped > 0 || importDropped > 0) {
        graphFilesDropped = Math.max(graphFilesDropped, connectionDropped, importDropped);
        graphPartial = true;
      }
      extraRanks.push({ weight: GRAPH_CONNECTION_WEIGHT, paths: connectionPaths });
      extraRanks.push({ weight: GRAPH_IMPORT_WEIGHT, paths: importPaths });
      latestRanked = rankCandidates(byFile, groups, extraRanks);
      const preparedPaths = new Set(prepared.map((window) => window.path));
      const newcomers = latestRanked.filter((candidate) => (
        (connectionPaths.includes(candidate.path) || importPaths.includes(candidate.path))
        && !preparedPaths.has(candidate.path)
        && !issues.some((issue) => issue.path === candidate.path)
      ));
      // Graph newcomers get an independent read budget so they can still
      // compete when rg already filled the pack, but they reuse the main
      // materialization shape instead of one wide fan-out. Newcomers past the
      // budget stay ranked candidates and are reported `not-requested` (D-139).
      const extraBatch = newcomers.slice(0, maxMaterializeReads(newcomers.length, excerptLimit));
      for (let offset = 0; offset < extraBatch.length; offset += DEFAULT_READ_PARALLELISM) {
        signal.throwIfAborted();
        const slice = extraBatch.slice(offset, offset + DEFAULT_READ_PARALLELISM);
        reads += slice.length;
        await materializeBatch(slice);
      }
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw error;
      graphPartial = true;
    }
  }

  filesDropped = Math.max(filesDropped, graphFilesDropped);
  if (graphFilesDropped > 0) searchIncomplete = true;

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
  const unread = latestRanked
    .map((candidate) => candidate.path)
    .filter((path) => !provenance.has(path) || provenance.get(path)?.status === "not-requested");
  for (const path of unread) markProvenance(path, "not-requested");

  const graphDetails: ExploreGraphDetails = {
    status: graphStatus,
    definitions: graphDefinitions,
    connections: graphConnections,
    imports: graphImports,
    ...(graphFilesDropped > 0 ? { filesDropped: graphFilesDropped } : {}),
    ...(graphPartial ? { partial: true } : {}),
  };
  const snippets = packed.map(snippetFrom);
  const partial = issues.length > 0 || omittedFromPack.length > 0 || unread.length > 0 || searchIncomplete || snippets.length < prepared.length || graphPartial;
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
      graph: graphDetails,
    },
  };
}

export type ExploreFormatInput = Pick<
  ExploreResult,
  "snippets" | "issues" | "notRequested" | "omitted" | "partial" | "searchIncomplete" | "searched"
> & {
  relations?: NonNullable<WireResult["details"]["relations"]>;
  graph?: ExploreGraphDetails;
};

/**
 * Relations are an annotation, so they are capped per file and never printed
 * as current when the graph revision differs from the excerpt: a moved line
 * number is worse than no line number (agent-harness 7.2, D-112).
 */
const RELATION_LINES_PER_FILE = 12;

function relationLines(relations: NonNullable<WireResult["details"]["relations"]> | undefined): string[] {
  if (!relations) return [];
  const files = relations.files.filter((file) => (
    file.imports.length > 0 || file.connections.length > 0 || file.associations.length > 0
  ));
  const lines: string[] = [];
  if (relations.status !== "ready") {
    lines.push(`Relations ${relations.status}: the symbol graph could not answer for every excerpt path.`);
  }
  if (files.length === 0) return lines;
  lines.push("Relations (graph; associates are same-string candidates, not confirmed connections):");
  for (const file of files) {
    const where = file.stale
      ? `${file.path} [stale @${file.documentRevision ?? "unknown"}; line numbers are from that revision]`
      : file.path;
    const items = [
      ...file.connections.map((item) => `connects ${item.callee}("${item.literal}")${file.stale ? "" : ` (L${item.line})`}`),
      ...file.imports.map((item) => `imports ${item.specifier}${file.stale ? "" : ` (L${item.line})`}`),
      ...file.associations.map((item) => `associates ${item.callee}("${item.literal}")${file.stale ? "" : ` (L${item.line})`} [candidate]`),
    ];
    for (const item of items.slice(0, RELATION_LINES_PER_FILE)) lines.push(`- ${where} ${item}`);
    const dropped = items.length - RELATION_LINES_PER_FILE;
    if (dropped > 0) lines.push(`- ${file.path} … ${dropped} more edge(s) omitted`);
    if (file.incomplete) lines.push(`- ${file.path} edge extraction was incomplete for this revision`);
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
  if (result.graph && result.graph.status !== "not-requested" && result.graph.status !== "ready") {
    header.push(`Graph ${result.graph.status}: the symbol catalog did not contribute path candidates.`);
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
  if (omittedLines.length > 0) storedParts.push("Omitted supports:", ...omittedLines);
  if (unreadLine) storedParts.push(unreadLine);
  storedParts.push(...issueLines);
  if (graphLines.length > 0) storedParts.push(...graphLines);
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
  // Relations come last: they annotate excerpts the agent already has, so they
  // must not crowd out omitted supports, unread candidates or issues, which are
  // how the agent learns what this result does not contain (D-112).
  for (const line of graphLines) pushIfFits(line);

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
