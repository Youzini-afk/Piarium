import { languageIdForPath, type ExploreDistinctivenessDetails, type ExploreEvidenceGrade, type ExploreGraphDetails, type ExploreGraphStatus, type ExploreTermCoverage, type ExploreWindowTrace, type HarnessServiceMap } from "@piarium/protocol";
import type { ExploreFileSnapshot } from "./explore-file-reader.js";
import { SMALL_STRUCTURE_SPAN_LINES } from "../structure/constants.js";
import { classifyLiteralCall } from "../structure/connections.js";
import { outlineUsableForText, sliceStructureWindows } from "../structure/slice.js";
import type { StructureHitClass, StructureOutlineResult, StructureSource } from "../structure/types.js";
import {
  DEFAULT_ANCHOR_CAP,
  buildRgPatterns,
  buildTermGroups,
  classifyFileRole,
  extractIdentifierGroups,
  extractIdentifiers,
  extractQuotedLiterals,
  fileRoleFit,
  looksLikeConnectionValue,
  looksLikePathObject,
  looksLikeSymbolName,
  parseExploreQuery,
  type ExploreQueryParse,
  type TermGroup,
  type TermGroupKind,
} from "./explore-query.js";
import {
  buildTermWeightTable,
  coverageFromSearch,
  weightByGroupId,
  weightedCoverage,
  type PatternCoverage,
} from "./explore-distinctiveness.js";
import {
  DEFAULT_GRAPH_CONNECTION_BUDGET,
  DEFAULT_GRAPH_DEFINITION_BUDGET,
  DEFAULT_GRAPH_DEFINITIONS_PER_TERM,
  DEFAULT_GRAPH_IMPORT_BUDGET,
  DEFAULT_GRAPH_IMPORT_PER_SEED,
  locateIdentifierLines,
  locateLiteralLines,
  pathInRoots,
  rankReverseImporters,
  type ExploreGraphRecall,
} from "./explore-graph.js";

export {
  DEFAULT_ANCHOR_CAP,
  buildRgPatterns,
  buildTermGroups,
  extractIdentifierGroups,
  extractIdentifiers,
  extractQuotedLiterals,
  parseExploreQuery,
};
export type { TermGroup, TermGroupKind };

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

export type RgSearchReturn = RgHit[] | {
  hits: RgHit[];
  partial?: boolean;
  filesDropped?: number;
  fileCoverage?: ExploreTermCoverage;
};

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
  structure?: Pick<StructureSource, "outline" | "classifyHits"> & Partial<Pick<StructureSource, "literalCalls">>;
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

/** Output excerpt count default. `limit` is a cap, not a quota. */
export const DEFAULT_EXCERPT_LIMIT = 20;
/** Working candidate-hit budget per generic/literal/identifier pattern. */
export const DEFAULT_CANDIDATE_BUDGET = 200;
/** Independent working budget for each anchor pattern. */
export const DEFAULT_ANCHOR_BUDGET = 80;
/** Per-file hit cap inside the candidate pool (not a product hard reject). */
export const DEFAULT_HITS_PER_FILE = 12;
export const DEFAULT_READ_PARALLELISM = 3;
export const DEFAULT_READ_LOOKAHEAD = 2;
/** Below the 32 KiB generic tool-result truncation so explore packs first. */
export const DEFAULT_BYTE_BUDGET = 24 * 1024;

export function exploreHandleHint(handle: string): string {
  return `\nMore: get_output("${handle}") for the full pack and unread candidate list (session-local, ephemeral).`;
}

const comparePath = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

const normalizeRgResult = (value: RgSearchReturn): {
  hits: RgHit[];
  partial: boolean;
  filesDropped: number;
  fileCoverage: ExploreTermCoverage;
} => {
  if (Array.isArray(value)) {
    return { hits: value, partial: false, filesDropped: 0, fileCoverage: "unknown" };
  }
  const filesDropped = value.filesDropped ?? 0;
  const partial = value.partial === true;
  return {
    hits: value.hits,
    partial,
    filesDropped,
    fileCoverage: coverageFromSearch({
      filesDropped,
      ...(value.fileCoverage ? { fileCoverage: value.fileCoverage } : {}),
      partial,
    }),
  };
};

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

type GraphCandidateSource = "definition" | "connection" | "association" | "import";
type EvidenceGrade = ExploreEvidenceGrade;

interface GraphClue {
  source: GraphCandidateSource;
  why: string;
  locate: { text: string; kind: "identifier" | "literal" };
  edgeKind?: "connects" | "associates";
  match?: "exact" | "name-contains";
  callee?: string;
  /**
   * Reached by completing a wire whose literal is unrelated to the question
   * object. A registration table window holds every service it registers, so
   * expanding it would otherwise pack unrelated counterparts at connects grade
   * (D-151).
   */
  offTopic?: true;
}

interface FileEvidence {
  hits: Map<number, { text: string; groups: Set<string>; distinctive: Set<string>; clues: GraphClue[] }>;
  groups: Set<string>;
  distinctive: Set<string>;
  anchors: Set<string>;
  graphClues: GraphClue[];
  verifiedRelation: boolean;
  verifiedCallees: Set<string>;
}

interface RankedCandidate {
  path: string;
  evidence: FileEvidence;
  tier: number;
  roleFit: number;
  weightedCoverage: number;
}

interface PreparedWindow {
  path: string;
  start: number;
  end: number;
  text: string;
  groups: Set<string>;
  distinctive: Set<string>;
  hasDistinctive: boolean;
  hasAnchor: boolean;
  offTopic: boolean;
  windowWeight: number;
  revision: string;
  source: "disk" | "surface-draft";
  why: string;
  unit?: ExploreSnippet["unit"];
  structure?: ExploreSnippet["structure"];
  hitLines: number[];
  hitClass?: StructureHitClass;
  grade: EvidenceGrade;
  verifiedCallees: string[];
  factKey: string;
  roleFit: number;
}

const emptyEvidence = (): FileEvidence => ({
  hits: new Map(),
  groups: new Set(),
  distinctive: new Set(),
  anchors: new Set(),
  graphClues: [],
  verifiedRelation: false,
  verifiedCallees: new Set(),
});

const GRADE_RANK: Record<EvidenceGrade, number> = {
  "verified-relation": 5,
  "connects-clue": 4,
  "exact-definition": 3,
  "full-object": 2,
  support: 1,
  lexical: 0,
};

function attachGraphClue(evidence: FileEvidence, clue: GraphClue): void {
  if (evidence.graphClues.some((item) => item.source === clue.source && item.why === clue.why && item.locate.text === clue.locate.text)) {
    return;
  }
  evidence.graphClues.push(clue);
}

function applyGraphLocate(lines: readonly string[], evidence: FileEvidence): void {
  for (const clue of evidence.graphClues) {
    const found = clue.locate.kind === "identifier"
      ? locateIdentifierLines(lines, clue.locate.text)
      : locateLiteralLines(lines, clue.locate.text);
    for (const line of found) {
      const existing = evidence.hits.get(line);
      if (existing) {
        if (!existing.clues.some((item) => item.why === clue.why && item.locate.text === clue.locate.text)) {
          existing.clues.push(clue);
        }
        continue;
      }
      evidence.hits.set(line, {
        text: lines[line - 1]!,
        groups: new Set(),
        distinctive: new Set(),
        clues: [clue],
      });
    }
  }
}

function recordHit(byFile: Map<string, FileEvidence>, hit: RgHit, group: TermGroup, distinctive: boolean): void {
  const evidence = byFile.get(hit.path) ?? emptyEvidence();
  const line = evidence.hits.get(hit.line) ?? {
    text: hit.text,
    groups: new Set<string>(),
    distinctive: new Set<string>(),
    clues: [],
  };
  line.text = hit.text;
  line.groups.add(group.id);
  if (distinctive) line.distinctive.add(group.id);
  evidence.hits.set(hit.line, line);
  evidence.groups.add(group.id);
  if (distinctive) evidence.distinctive.add(group.id);
  if (group.kind === "anchor") evidence.anchors.add(group.id);
  byFile.set(hit.path, evidence);
}

function objectGroupsOf(groups: TermGroup[]): TermGroup[] {
  return groups.filter((group) => group.kind === "anchor" || group.kind === "literal" || group.kind === "identifier");
}

function contentGroupsOf(groups: TermGroup[]): TermGroup[] {
  return groups.filter((group) => group.kind === "question");
}

const termLocate = (lines: readonly string[], term: string, group: TermGroup): number[] => {
  if (!term) return [];
  if (group.kind === "literal" || looksLikeConnectionValue(term) || term.includes("-")) {
    return locateLiteralLines(lines, term);
  }
  return locateIdentifierLines(lines, term);
};

/**
 * After a snapshot is in hand, check every live group against the body.
 * rg's candidate budget can drop the line we need; the file is already paid
 * for. Seed at most one hit per group that has no hit yet (D-155).
 */
function rescanBodyGroups(lines: readonly string[], groups: readonly TermGroup[], evidence: FileEvidence): void {
  for (const group of groups) {
    const found: Array<{ line: number; distinctive: boolean }> = [];
    for (const variant of searchVariantsOf(group)) {
      const distinctive = variant === group.distinctive;
      for (const line of termLocate(lines, variant, group)) {
        const existing = found.find((item) => item.line === line);
        if (existing) {
          if (distinctive) existing.distinctive = true;
          continue;
        }
        found.push({ line, distinctive });
      }
    }
    if (found.length === 0) continue;
    evidence.groups.add(group.id);
    if (found.some((item) => item.distinctive)) evidence.distinctive.add(group.id);
    if (group.kind === "anchor") evidence.anchors.add(group.id);
    // Seed original-term lines that are not already inside an existing
    // hit's small container. One early mention must not hide a later
    // cluster of the same group (D-155).
    if (!found.some((item) => item.distinctive)) continue;
    const existing = [...evidence.hits.entries()]
      .filter(([, hit]) => hit.groups.has(group.id))
      .map(([line]) => line);
    let seeded = 0;
    for (const seed of found.filter((item) => item.distinctive)) {
      if (existing.some((line) => Math.abs(line - seed.line) < SMALL_STRUCTURE_SPAN_LINES)) continue;
      const line = evidence.hits.get(seed.line) ?? {
        text: lines[seed.line - 1]!,
        groups: new Set<string>(),
        distinctive: new Set<string>(),
        clues: [],
      };
      line.groups.add(group.id);
      line.distinctive.add(group.id);
      evidence.hits.set(seed.line, line);
      existing.push(seed.line);
      seeded += 1;
      if (seeded >= 3) break;
    }
  }
}

function candidateTier(evidence: FileEvidence, parsed: ExploreQueryParse, groups: TermGroup[]): number {
  if (evidence.verifiedRelation) return 0;
  const objectIds = new Set(objectGroupsOf(groups).map((group) => group.id));
  const hasConnects = evidence.graphClues.some((clue) => clue.source === "connection");
  const hasExactObjectDef = evidence.graphClues.some((clue) => (
    clue.source === "definition"
    && clue.match === "exact"
    && parsed.objects.includes(clue.locate.text)
  ));
  const hasFullObject = [...evidence.distinctive].some((id) => objectIds.has(id)) || evidence.anchors.size > 0;
  if (hasConnects || hasExactObjectDef) return 1;
  if (hasFullObject) return 2;
  if (evidence.graphClues.some((clue) => clue.source === "association" || clue.source === "import" || clue.match === "name-contains")) {
    return 3;
  }
  return 4;
}

/** Same-tier order is weighted coverage, then bounded role preference (D-154). */
function rankCandidates(
  byFile: Map<string, FileEvidence>,
  groups: TermGroup[],
  parsed: ExploreQueryParse,
  table: ExploreDistinctivenessDetails,
): RankedCandidate[] {
  const weights = weightByGroupId(groups, table);
  return [...byFile.entries()]
    .map(([path, evidence]) => {
      const role = classifyFileRole(path);
      const fit = fileRoleFit(role, parsed.domain, parsed.preferTests);
      const tier = candidateTier(evidence, parsed, groups);
      return {
        path,
        evidence,
        tier,
        roleFit: fit,
        weightedCoverage: weightedCoverage(evidence, groups, weights),
      };
    })
    .sort((left, right) => (
      left.tier - right.tier
      || right.weightedCoverage - left.weightedCoverage
      || right.roleFit - left.roleFit
      || comparePath(left.path, right.path)
    ));
}

function primaryObjectFor(evidence: FileEvidence, groups: TermGroup[], parsed: ExploreQueryParse): string {
  for (const object of parsed.objects) {
    const group = groups.find((item) => item.distinctive === object);
    if (group && (evidence.distinctive.has(group.id) || evidence.groups.has(group.id))) return object;
    if (evidence.graphClues.some((clue) => clue.locate.text === object)) return object;
  }
  return parsed.objects[0] ?? "";
}

function isDirectClue(evidence: FileEvidence, groups: TermGroup[], parsed: ExploreQueryParse): boolean {
  if (evidence.graphClues.some((clue) => clue.source === "connection")) return true;
  if (evidence.graphClues.some((clue) => (
    clue.source === "definition"
    && clue.match === "exact"
    && parsed.objects.includes(clue.locate.text)
  ))) return true;
  if (evidence.anchors.size > 0) return true;
  return objectGroupsOf(groups).some((group) => (
    (group.kind === "literal" || group.kind === "anchor") && evidence.distinctive.has(group.id)
  ));
}

function scheduleReads(ranked: RankedCandidate[], groups: TermGroup[], parsed: ExploreQueryParse): RankedCandidate[] {
  const directs = ranked.filter((candidate) => isDirectClue(candidate.evidence, groups, parsed));
  const rest = ranked.filter((candidate) => !isDirectClue(candidate.evidence, groups, parsed));
  const buckets = new Map<string, RankedCandidate[]>();
  for (const candidate of directs) {
    const key = primaryObjectFor(candidate.evidence, groups, parsed) || candidate.path;
    const bucket = buckets.get(key) ?? [];
    bucket.push(candidate);
    buckets.set(key, bucket);
  }
  const interleaved: RankedCandidate[] = [];
  const queues = [...buckets.values()];
  let index = 0;
  while (queues.some((queue) => queue.length > 0)) {
    const queue = queues[index % queues.length]!;
    const next = queue.shift();
    if (next) interleaved.push(next);
    index += 1;
  }
  return [...interleaved, ...rest];
}

function windowLooksLikeCallee(text: string, callee: string, object: string): boolean {
  const escaped = object.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`${callee}\\(\\s*["'\`]${escaped}`, "u").test(text);
}

/**
 * Cheap identity of "what this file's evidence says right now". Windows are
 * rebuilt when it moves, so a hit or clue that arrived after the read still
 * reaches the model.
 */
function evidenceSignature(evidence: FileEvidence): string {
  const lines = [...evidence.hits.keys()].sort((left, right) => left - right).join(",");
  const groups = [...evidence.groups].sort().join(",");
  return `${lines}|${groups}|${evidence.graphClues.length}|${evidence.verifiedRelation ? 1 : 0}`;
}

/**
 * A wire literal found by reading is off topic when the question named an
 * object and the literal is neither that object nor part of it. No object
 * means we cannot judge off-topic — that is not the same as proven on-topic
 * (D-156).
 */
function literalOffTopic(literal: string, parsed: ExploreQueryParse): boolean {
  if (parsed.objects.length === 0) return false;
  return !parsed.objects.some((object) => (
    literal === object || literal.includes(object) || object.includes(literal)
  ));
}

function windowGrade(windowClues: GraphClue[], hasDistinctiveObject: boolean, hasAnchor: boolean, verified: boolean): EvidenceGrade {
  if (verified) return "verified-relation";
  if (windowClues.some((clue) => clue.source === "connection" && !clue.offTopic)) return "connects-clue";
  if (windowClues.some((clue) => clue.source === "definition" && clue.match === "exact")) return "exact-definition";
  if (hasAnchor || hasDistinctiveObject) return "full-object";
  if (windowClues.some((clue) => (
    clue.source === "association" || clue.source === "import" || clue.match === "name-contains" || clue.offTopic
  ))) {
    return "support";
  }
  return "lexical";
}

function windowsFor(
  path: string,
  lines: string[],
  evidence: FileEvidence,
  snapshot: Extract<ExploreFileSnapshot, { status: "ready" }>,
  groups: TermGroup[],
  outline: StructureOutlineResult | { status: "not-requested"; provider: null },
  parsed: ExploreQueryParse,
  weights: ReadonlyMap<string, number>,
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
  const objectIds = new Set(objectGroupsOf(groups).map((group) => group.id));
  const windows = slices.map((slice) => {
    const covered = new Set<string>();
    const distinctive = new Set<string>();
    const windowClues: GraphClue[] = [];
    let hasAnchor = false;
    for (const line of slice.hitLines) {
      const hit = evidence.hits.get(line);
      if (!hit) continue;
      for (const groupId of hit.groups) covered.add(groupId);
      for (const groupId of hit.distinctive) distinctive.add(groupId);
      for (const clue of hit.clues) {
        if (!windowClues.some((item) => item.why === clue.why && item.locate.text === clue.locate.text)) {
          windowClues.push(clue);
        }
      }
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
    const whyParts = windowClues.map((clue) => clue.why);
    const why = whyParts.length > 0
      ? (matched ? `${whyParts.join("; ")}; ${matched}` : whyParts.join("; "))
      : (matched || "matched search terms");
    const hasDistinctiveObject = [...covered].some((id) => objectIds.has(id) && distinctive.has(id));
    const verified = evidence.verifiedRelation && windowClues.some((clue) => clue.source === "connection" || clue.why.startsWith("verified "));
    const looksLikeRegister = parsed.objects.some((object) => windowLooksLikeCallee(slice.text, "register", object));
    const grade = looksLikeRegister && parsed.relation === "register"
      ? (verified ? "verified-relation" : "connects-clue")
      : windowGrade(windowClues, hasDistinctiveObject, hasAnchor, verified || evidence.verifiedRelation && hasDistinctiveObject);
    const offTopic = windowClues.some((clue) => clue.offTopic)
      && !hasDistinctiveObject
      && !verified
      && !windowClues.some((clue) => clue.source === "connection" && !clue.offTopic);
    const structure = outline.status === "not-requested"
      ? undefined
      : {
        provider: outline.provider,
        status: usable.status === "not-requested" ? "not-requested" as const : usable.status,
      };
    const factKey = windowClues[0]
      ? `${path}:${windowClues[0]!.source}:${windowClues[0]!.locate.text}`
      : `${path}:${slice.start}:${[...covered].sort().join(",")}`;
    const roleFit = fileRoleFit(classifyFileRole(path), parsed.domain, parsed.preferTests);
    return {
      path,
      start: slice.start,
      end: slice.end,
      text: slice.text,
      groups: covered,
      distinctive,
      hasDistinctive: distinctive.size > 0,
      hasAnchor,
      offTopic,
      windowWeight: weightedCoverage({ groups: covered, distinctive }, groups, weights),
      revision: snapshot.revision,
      source: snapshot.source,
      why,
      ...(slice.unit ? { unit: slice.unit } : {}),
      ...(structure ? { structure } : {}),
      hitLines: slice.hitLines,
      grade,
      verifiedCallees: [...evidence.verifiedCallees],
      factKey,
      roleFit,
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

function weakenUnverifiedConnectionWhy(windows: PreparedWindow[], objects: readonly string[]): PreparedWindow[] {
  return windows.map((window) => {
    if (window.grade === "verified-relation") return window;
    if (!objects.some((object) => window.text.includes(object))) return window;
    if (!/graph pointed here|other end of connection|associated mention/.test(window.why)) return window;
    if (/verified register|verified request|verified connection/.test(window.why)) return window;
    return {
      ...window,
      why: window.why.includes("full literal hit")
        ? window.why
        : `${window.why}; full literal hit; graph pointed here`,
    };
  });
}

async function verifyMaterializedRelations(
  path: string,
  snapshot: Extract<ExploreFileSnapshot, { status: "ready" }>,
  evidence: FileEvidence,
  windows: PreparedWindow[],
  parsed: ExploreQueryParse,
  deps: ExploreDeps,
  signal: AbortSignal,
): Promise<PreparedWindow[]> {
  const objects = [...parsed.objects, ...parsed.usedAnchors].filter(Boolean);
  if (objects.length === 0) return windows;
  if (!deps.structure?.literalCalls) {
    return weakenUnverifiedConnectionWhy(windows, objects);
  }
  try {
    signal.throwIfAborted();
    const calls = await deps.structure.literalCalls({
      path,
      languageId: languageIdForPath(path),
      text: snapshot.content,
      revision: snapshot.revision,
      signal,
    });
    if (calls.status !== "ready") return weakenUnverifiedConnectionWhy(windows, objects);
    const verified: Array<{ line: number; name: string; literal: string; kind: "connects" | "associates" }> = [];
    for (const call of calls.calls) {
      if (!objects.includes(call.literal)) continue;
      const kind = classifyLiteralCall(call);
      if (!kind) continue;
      verified.push({ line: call.line, name: call.name, literal: call.literal, kind });
    }
    if (verified.length === 0) return weakenUnverifiedConnectionWhy(windows, objects);
    return windows.map((window) => {
      const hit = verified.find((item) => item.line >= window.start && item.line <= window.end);
      if (!hit) return window;
      if (hit.kind === "associates") {
        const why = `associated mention of "${hit.literal}" via ${hit.name}()`;
        return {
          ...window,
          grade: window.grade === "verified-relation" ? window.grade : "support",
          why: window.why.includes(why) ? window.why : (window.why ? `${why}; ${window.why}` : why),
        };
      }
      evidence.verifiedRelation = parsed.relation === "unknown" || parsed.relation === "register" || hit.name === "register" || hit.name === "request";
      evidence.verifiedCallees.add(hit.name);
      const why = `verified ${hit.name}("${hit.literal}")`;
      return {
        ...window,
        grade: "verified-relation",
        verifiedCallees: [...new Set([...window.verifiedCallees, hit.name])],
        why: window.why.includes(why) ? window.why : (window.why ? `${why}; ${window.why}` : why),
        factKey: `${path}:verified:${hit.name}:${hit.literal}`,
      };
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    return weakenUnverifiedConnectionWhy(windows, objects);
  }
}

function questionWantsAllSites(question: string): boolean {
  return /\b(all|every)\b/iu.test(question) || /所有/.test(question);
}

function hasVerifiedRegister(windows: readonly PreparedWindow[]): boolean {
  return windows.some((window) => (
    window.grade === "verified-relation"
    && (window.verifiedCallees.includes("register") || window.why.includes("verified register(") || /register\("/.test(window.text))
  ));
}

function hasBothConnectsEnds(windows: readonly PreparedWindow[]): boolean {
  const callees = new Set(windows.flatMap((window) => window.verifiedCallees));
  const registerEnd = callees.has("register") || windows.some((window) => /register\(["'`]/.test(window.text));
  const requestEnd = callees.has("request") || windows.some((window) => /request\(["'`]/.test(window.text));
  return registerEnd && requestEnd;
}

function groupContribution(window: PreparedWindow, groupId: string, weights: ReadonlyMap<string, number>): number {
  const match = window.distinctive.has(groupId) ? 1 : window.groups.has(groupId) ? 0.5 : 0;
  if (match === 0) return 0;
  return (weights.get(groupId) ?? 1) * match;
}

/**
 * Own relevance, added evidence, and body cost. Same-file complements keep
 * their added-local value; switching files is not a bonus (D-155).
 */
function isImplementationUnit(window: PreparedWindow): boolean {
  return window.unit?.kind === "function" || window.unit?.kind === "method";
}

function windowScore(
  window: PreparedWindow,
  selected: PreparedWindow[],
  weights: ReadonlyMap<string, number>,
): number {
  const sameFact = selected.some((item) => item.factKey === window.factKey);
  const coveredEnds = new Set(selected.flatMap((item) => item.verifiedCallees));
  const coveredGroups = new Set(selected.flatMap((item) => [...item.groups]));
  const sameFile = selected.filter((item) => item.path === window.path);
  const implementation = isImplementationUnit(window);
  const localImplGroups = new Set(
    sameFile.filter(isImplementationUnit).flatMap((item) => [...item.groups]),
  );
  let newEnd = 0;
  for (const callee of window.verifiedCallees) {
    if (!coveredEnds.has(callee)) newEnd += 1;
  }
  let addedGlobal = 0;
  let addedLocal = 0;
  for (const groupId of window.groups) {
    const value = groupContribution(window, groupId, weights);
    if (!coveredGroups.has(groupId)) addedGlobal += value;
    else if (implementation && sameFile.length > 0 && !localImplGroups.has(groupId)) addedLocal += value;
  }
  const complement = addedLocal > 0 ? 36 : 0;
  const unitBonus = implementation ? 15 : 0;
  const hitClassScore = window.hitClass === "name" ? 6 : window.hitClass === "body" ? 2 : window.hitClass === "comment" ? -2 : 0;
  const cost = Math.log(1 + utf8Bytes(window.text) / 200);
  return window.windowWeight * 10
    + addedGlobal * 12
    + addedLocal * 20
    + complement
    + unitBonus
    + GRADE_RANK[window.grade] * 8
    + window.roleFit * 3
    + (window.hasAnchor ? 8 : 0)
    + newEnd * 20
    + hitClassScore
    - cost
    - (sameFact ? 80 : 0);
}

/** A window whose grade came from the relation the question asked about. */
function carriesAskedRelation(window: PreparedWindow): boolean {
  return GRADE_RANK[window.grade] >= GRADE_RANK["exact-definition"];
}

/**
 * D-148 asks for the production entry when relation evidence is comparable,
 * and a test fixture that registers the same value is comparable: both bodies
 * hold the call. A weight cannot express that — the fixture can always win on
 * weighted coverage — so it is a rank above the score, and only for a question
 * that explicitly wants production (D-157).
 */
function relationRoleRank(window: PreparedWindow, preferProduction: boolean): number {
  if (!preferProduction || !carriesAskedRelation(window)) return 0;
  return Math.max(0, window.roleFit);
}

function packComplementary(
  windows: PreparedWindow[],
  limit: number,
  weights: ReadonlyMap<string, number>,
  locatingDone: boolean,
  preferProduction: boolean,
): PreparedWindow[] {
  const selected: PreparedWindow[] = [];
  const remaining = locatingDone ? windows.filter((window) => !window.offTopic) : [...windows];
  while (selected.length < limit && remaining.length > 0) {
    let bestIndex = 0;
    let bestRank = Number.NEGATIVE_INFINITY;
    let bestScore = Number.NEGATIVE_INFINITY;
    remaining.forEach((window, index) => {
      const rank = relationRoleRank(window, preferProduction);
      const score = windowScore(window, selected, weights);
      const best = remaining[bestIndex]!;
      const better = rank > bestRank
        || (rank === bestRank && score > bestScore)
        || (rank === bestRank && score === bestScore
          && (comparePath(window.path, best.path) < 0 || (window.path === best.path && window.start < best.start)));
      if (better) {
        bestIndex = index;
        bestRank = rank;
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

function collectPatterns(groups: TermGroup[]): Map<string, Array<{ group: TermGroup; distinctive: boolean }>> {
  const patternOwners = new Map<string, Array<{ group: TermGroup; distinctive: boolean }>>();
  for (const group of groups) {
    for (const variant of searchVariantsOf(group)) {
      const owners = patternOwners.get(variant) ?? [];
      owners.push({ group, distinctive: variant === group.distinctive });
      patternOwners.set(variant, owners);
    }
  }
  return patternOwners;
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
  const parsed = parseExploreQuery(input.question, input.anchors ?? []);
  const groups = parsed.groups;
  const { suppliedAnchors, usedAnchors, anchorsTruncated } = parsed;
  const objectPatterns = collectPatterns(objectGroupsOf(groups));
  const contentPatterns = collectPatterns(contentGroupsOf(groups));
  if (objectPatterns.size === 0 && contentPatterns.size === 0 && input.question.trim()) {
    const fallback: TermGroup = { id: "question:raw", kind: "question", distinctive: input.question.trim(), variants: [input.question.trim()] };
    groups.push(fallback);
    contentPatterns.set(fallback.distinctive, [{ group: fallback, distinctive: true }]);
  }

  const byFile = new Map<string, FileEvidence>();
  let searchIncomplete = false;
  let filesDropped = 0;
  let launchedPatterns = 0;
  const skippedContent: string[] = [];
  const launchedCoverage = new Map<string, PatternCoverage>();
  const rankNow = (): RankedCandidate[] => rankCandidates(
    byFile,
    groups,
    parsed,
    buildTermWeightTable(groups, byFile, launchedCoverage, searchVariantsOf),
  );

  const runRg = async (patterns: Map<string, Array<{ group: TermGroup; distinctive: boolean }>>): Promise<void> => {
    launchedPatterns += patterns.size;
    await Promise.all([...patterns.entries()].map(async ([pattern, owners]) => {
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
      filesDropped = Math.max(filesDropped, result.filesDropped);
      const previous = launchedCoverage.get(pattern);
      launchedCoverage.set(pattern, {
        coverage: previous
          ? (previous.coverage === "lower-bound" || result.fileCoverage === "lower-bound"
            ? "lower-bound"
            : previous.coverage === "unknown" || result.fileCoverage === "unknown"
              ? "unknown"
              : "complete")
          : result.fileCoverage,
        filesDropped: Math.max(previous?.filesDropped ?? 0, result.filesDropped),
      });
      for (const hit of result.hits) {
        for (const owner of owners) recordHit(byFile, hit, owner.group, owner.distinctive);
      }
    }));
  };

  for (const object of parsed.objects) {
    if (!looksLikePathObject(object) || !pathInRoots(object, input.paths)) continue;
    if (!byFile.has(object)) byFile.set(object, emptyEvidence());
  }

  let graphStatus: ExploreGraphStatus = deps.graph ? "unavailable" : "not-requested";
  const definitionFiles = new Set<string>();
  const connectionFiles = new Set<string>();
  const associateFiles = new Set<string>();
  const importFiles = new Set<string>();
  let graphFilesDropped = 0;
  let graphPartial = false;

  const runGraphSeeds = async (): Promise<void> => {
    if (!deps.graph) return;
    try {
      const stats = await deps.graph.catalogStats();
      if (stats.symbolCount === 0) {
        graphStatus = "empty";
        return;
      }
      graphStatus = "ready";
      const seenDefinitions = new Set<string>();
      const droppedDefinitions = new Set<string>();
      let newDefinitionPaths = 0;
      const acceptDefinition = (path: string): boolean => {
        if (seenDefinitions.has(path)) return true;
        if (!byFile.has(path)) {
          if (newDefinitionPaths >= DEFAULT_GRAPH_DEFINITION_BUDGET) return false;
          newDefinitionPaths += 1;
        }
        seenDefinitions.add(path);
        return true;
      };
      for (const object of parsed.objects) {
        if (!looksLikeSymbolName(object)) continue;
        signal.throwIfAborted();
        const hits = await deps.graph.searchDefinitions(object, DEFAULT_GRAPH_DEFINITIONS_PER_TERM);
        for (const hit of hits) {
          if (hit.match === "path-contains" || !pathInRoots(hit.path, input.paths)) continue;
          if (!acceptDefinition(hit.path)) {
            droppedDefinitions.add(hit.path);
            continue;
          }
          const evidence = byFile.get(hit.path) ?? emptyEvidence();
          attachGraphClue(evidence, {
            source: "definition",
            why: `definition of ${hit.name} (${hit.kind})`,
            locate: { text: hit.name, kind: "identifier" },
            match: hit.match === "exact" ? "exact" : "name-contains",
          });
          byFile.set(hit.path, evidence);
          definitionFiles.add(hit.path);
        }
      }
      if (droppedDefinitions.size > 0) {
        graphFilesDropped = Math.max(graphFilesDropped, droppedDefinitions.size);
        graphPartial = true;
      }
      let connectionDropped = 0;
      for (const object of parsed.objects) {
        if (!looksLikeConnectionValue(object)) continue;
        signal.throwIfAborted();
        for (const end of await deps.graph.findLinks(object)) {
          if (!pathInRoots(end.path, input.paths)) continue;
          const connects = end.kind === "connects";
          if (!connects && end.kind !== "associates") continue;
          const alreadyReadHint = byFile.has(end.path);
          if (!alreadyReadHint && connects && connectionFiles.size >= DEFAULT_GRAPH_CONNECTION_BUDGET) {
            connectionDropped += 1;
            continue;
          }
          const evidence = byFile.get(end.path) ?? emptyEvidence();
          attachGraphClue(evidence, {
            source: connects ? "connection" : "association",
            why: connects
              ? `other end of connection "${object}"`
              : `associated mention of "${object}"`,
            locate: { text: object, kind: "literal" },
            edgeKind: connects ? "connects" : "associates",
            ...(end.callee ? { callee: end.callee } : {}),
          });
          byFile.set(end.path, evidence);
          if (connects) connectionFiles.add(end.path);
          else associateFiles.add(end.path);
        }
      }
      if (connectionDropped > 0) {
        graphFilesDropped = Math.max(graphFilesDropped, connectionDropped);
        graphPartial = true;
      }
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw error;
      const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
      graphStatus = code === "unavailable" ? "unavailable" : "failed";
    }
  };

  await Promise.all([runRg(objectPatterns), runGraphSeeds()]);

  const issues: ExploreIssue[] = [];
  const provenance = new Map<string, ExploreProvenance>();
  const structureFiles = new Map<string, NonNullable<WireResult["details"]["structure"]>["files"][number]>();
  const prepared: PreparedWindow[] = [];
  const snapshots = new Map<string, ExploreFileSnapshot>();
  const readPaths = new Set<string>();
  /** Evidence signature each read path's windows were last built against. */
  const windowedEvidence = new Map<string, string>();
  let reads = 0;

  const replacePrepared = (path: string, windows: readonly PreparedWindow[]): void => {
    const kept = prepared.filter((window) => window.path !== path);
    prepared.splice(0, prepared.length, ...kept, ...windows);
  };

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
    const snapshotsNeeded = await Promise.all(batch.map(async (candidate) => {
      signal.throwIfAborted();
      const cached = snapshots.get(candidate.path);
      if (cached) return [candidate, cached] as const;
      try {
        const snapshot = await deps.readFile(candidate.path);
        snapshots.set(candidate.path, snapshot);
        return [candidate, snapshot] as const;
      } catch {
        signal.throwIfAborted();
        const failed = { status: "failed" as const, message: "Document read failed. Search again or inspect workspace availability." };
        snapshots.set(candidate.path, failed);
        return [candidate, failed] as const;
      }
    }));
    signal.throwIfAborted();
    for (const [candidate, snapshot] of snapshotsNeeded) {
      readPaths.add(candidate.path);
      if (snapshot.status !== "ready") {
        issues.push({ path: candidate.path, status: snapshot.status, message: snapshot.message });
        markProvenance(candidate.path, snapshot.status, snapshot);
        continue;
      }
      await buildWindowsFrom(candidate.path, snapshot, candidate.evidence);
    }
  };

  /**
   * Turn one already-acquired snapshot into windows against the evidence this
   * file carries *now*. Safe to run again on the same snapshot: the snapshot
   * cache means no disk read, and the structure providers key their parse cache
   * on the content hash, so a second pass over the same text is a cache hit.
   */
  const buildWindowsFrom = async (
    path: string,
    snapshot: Extract<ExploreFileSnapshot, { status: "ready" }>,
    evidence: FileEvidence,
  ): Promise<void> => {
    const lines = snapshot.content.split(/\r\n|\n|\r/);
    applyGraphLocate(lines, evidence);
    for (const object of parsed.objects) {
      if (!looksLikePathObject(path) && path !== object) continue;
      for (const line of locateLiteralLines(lines, object)) {
        if (evidence.hits.has(line)) continue;
        evidence.hits.set(line, {
          text: lines[line - 1]!,
          groups: new Set(),
          distinctive: new Set(),
          clues: [],
        });
      }
    }
    rescanBodyGroups(lines, groups, evidence);
    const hitLines = [...evidence.hits.keys()].filter((line) => Number.isSafeInteger(line) && line >= 1);
    const outline = await outlineForSnapshot(path, snapshot, deps, signal, hitLines);
    if (outline.status !== "not-requested") {
      structureFiles.set(path, {
        path,
        provider: outline.provider,
        status: outline.status === "ready" && outline.revision !== snapshot.revision ? "stale" : outline.status,
      });
    }
    const weights = weightByGroupId(groups, buildTermWeightTable(groups, byFile, launchedCoverage, searchVariantsOf));
    const sliced = windowsFor(path, lines, evidence, snapshot, groups, outline, parsed, weights);
    const classified = await classifyPreparedWindows(path, snapshot, sliced.windows, deps, signal);
    const windows = await verifyMaterializedRelations(path, snapshot, evidence, classified, parsed, deps, signal);
    if (sliced.stale && !issues.some((issue) => issue.path === path && issue.status === "stale")) {
      issues.push({
        path,
        status: "stale",
        message: "Some search hits no longer match this document revision; those hits were omitted.",
      });
    }
    replacePrepared(path, windows);
    if (windows.length === 0) {
      markProvenance(path, sliced.stale ? "stale" : "empty", snapshot);
      windowedEvidence.set(path, evidenceSignature(evidence));
      return;
    }
    markProvenance(path, "ready", snapshot);
    windowedEvidence.set(path, evidenceSignature(evidence));
  };

  /**
   * New hits arriving after a file was read do not reach the model unless its
   * windows are rebuilt: the object pass freezes a window around the object
   * mention, and the later content-word pass skips the file because it is
   * already read. Reuse the snapshot and recompute (D-152).
   */
  const refreshReadEvidence = async (): Promise<void> => {
    for (const path of readPaths) {
      signal.throwIfAborted();
      const snapshot = snapshots.get(path);
      if (!snapshot || snapshot.status !== "ready") continue;
      const evidence = byFile.get(path);
      if (!evidence) continue;
      if (windowedEvidence.get(path) === evidenceSignature(evidence)) continue;
      await buildWindowsFrom(path, snapshot, evidence);
    }
  };

  const locating = parsed.relation === "register" && parsed.objects.some((object) => looksLikeConnectionValue(object));
  const wantsBothEnds = parsed.relation === "unknown" && parsed.objects.some((object) => looksLikeConnectionValue(object));
  const allSites = questionWantsAllSites(input.question);

  const shouldStop = (scheduled: readonly RankedCandidate[], next: number, budget: number): boolean => {
    if (next >= scheduled.length || reads >= budget) return true;
    if (!allSites && locating && hasVerifiedRegister(prepared)) return true;
    if (!allSites && wantsBothEnds && hasBothConnectsEnds(prepared)) return true;
    // `limit` is an output cap, not a reason to stop reading. Locating
    // and both-ends questions already returned above. How-questions use
    // the remaining read budget.
    return false;
  };

  const materializeScheduled = async (scheduled: RankedCandidate[], budget: number): Promise<void> => {
    let next = 0;
    while (next < scheduled.length && reads < budget) {
      if (shouldStop(scheduled, next, budget)) break;
      const batch: RankedCandidate[] = [];
      while (next < scheduled.length && batch.length < DEFAULT_READ_PARALLELISM && reads + batch.length < budget) {
        const candidate = scheduled[next]!;
        next += 1;
        if (readPaths.has(candidate.path)) continue;
        batch.push(candidate);
      }
      if (batch.length === 0) continue;
      reads += batch.length;
      await materializeBatch(batch);
    }
  };

  let ranked = rankNow();
  let scheduled = scheduleReads(ranked, groups, parsed);
  await materializeScheduled(scheduled, maxMaterializeReads(scheduled.length, excerptLimit));

  const verifiedEnough = (!allSites && locating && hasVerifiedRegister(prepared))
    || (!allSites && wantsBothEnds && hasBothConnectsEnds(prepared));
  if (verifiedEnough) {
    skippedContent.push(...contentPatterns.keys());
  } else if (contentPatterns.size > 0) {
    await runRg(contentPatterns);
    // Check the content words against text already in hand before spending a
    // read on a new file: the answer may be in a file the object pass read.
    await refreshReadEvidence();
    ranked = rankNow();
    scheduled = scheduleReads(ranked, groups, parsed);
    await materializeScheduled(scheduled, maxMaterializeReads(scheduled.length, excerptLimit));
  }

  if (deps.graph && graphStatus === "ready") {
    try {
      const seedPaths = [...readPaths];
      const connectionPaths: string[] = [];
      const importPaths: string[] = [];
      const seenNew = new Set<string>();
      const literals = new Set<string>();
      for (const object of parsed.objects) {
        if (looksLikeConnectionValue(object)) literals.add(object);
      }
      for (const window of prepared) {
        signal.throwIfAborted();
        const relations = await deps.graph.fileRelations(window.path);
        if (!relations) continue;
        for (const conn of relations.connections) {
          if (window.text.includes(conn.literal)) literals.add(conn.literal);
        }
      }
      // A window that is a registration table holds every literal it registers,
      // so spend the wire budget on the question's own object first and let the
      // rest in only at support grade (D-151).
      const locatingDone = !allSites && locating && hasVerifiedRegister(prepared);
      const bothEndsDone = !allSites && wantsBothEnds && hasBothConnectsEnds(prepared);
      const ordered = [...literals].sort((left, right) => (
        Number(literalOffTopic(left, parsed)) - Number(literalOffTopic(right, parsed))
      ));
      let connectionDropped = 0;
      for (const literal of ordered) {
        signal.throwIfAborted();
        const offTopic = literalOffTopic(literal, parsed);
        if ((locatingDone || bothEndsDone) && offTopic) continue;
        for (const end of await deps.graph.findLinks(literal)) {
          if (!pathInRoots(end.path, input.paths)) continue;
          const connects = end.kind === "connects";
          const alreadyRead = readPaths.has(end.path);
          if (!alreadyRead && connectionPaths.length >= DEFAULT_GRAPH_CONNECTION_BUDGET) {
            connectionDropped += 1;
            continue;
          }
          const evidence = byFile.get(end.path) ?? emptyEvidence();
          attachGraphClue(evidence, {
            source: connects ? "connection" : "association",
            why: connects
              ? `other end of connection "${literal}"`
              : `associated mention of "${literal}"`,
            locate: { text: literal, kind: "literal" },
            edgeKind: connects ? "connects" : "associates",
            ...(end.callee ? { callee: end.callee } : {}),
            ...(offTopic ? { offTopic: true as const } : {}),
          });
          byFile.set(end.path, evidence);
          if (connects) connectionFiles.add(end.path);
          else associateFiles.add(end.path);
          if (alreadyRead || seenNew.has(end.path)) continue;
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
          const alreadyRead = readPaths.has(importer.path);
          if (!alreadyRead && importPaths.length >= DEFAULT_GRAPH_IMPORT_BUDGET) {
            importDropped += 1;
            continue;
          }
          const evidence = byFile.get(importer.path) ?? emptyEvidence();
          attachGraphClue(evidence, {
            source: "import",
            why: `imports ${seed}`,
            locate: { text: importer.specifier, kind: "literal" },
          });
          byFile.set(importer.path, evidence);
          importFiles.add(importer.path);
          if (alreadyRead || seenNew.has(importer.path)) continue;
          seenNew.add(importer.path);
          importPaths.push(importer.path);
        }
      }
      if (connectionDropped > 0 || importDropped > 0) {
        graphFilesDropped = Math.max(graphFilesDropped, connectionDropped, importDropped);
        graphPartial = true;
      }
      // A graph clue landing on an already-read file is otherwise never located
      // in its text, because that path is not a newcomer to materialize.
      await refreshReadEvidence();
      ranked = rankNow();
      const newcomers = ranked.filter((candidate) => (
        (connectionPaths.includes(candidate.path) || importPaths.includes(candidate.path))
        && !readPaths.has(candidate.path)
        && !issues.some((issue) => issue.path === candidate.path)
      ));
      const extraBatch = scheduleReads(newcomers, groups, parsed).slice(0, maxMaterializeReads(newcomers.length, excerptLimit));
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

  ranked = rankNow();
  const packWeights = weightByGroupId(groups, buildTermWeightTable(groups, byFile, launchedCoverage, searchVariantsOf));
  const locatingDone = !allSites && locating && hasVerifiedRegister(prepared);
  const bothEndsDone = !allSites && wantsBothEnds && hasBothConnectsEnds(prepared);
  const packed = packComplementary(
    prepared,
    excerptLimit,
    packWeights,
    locatingDone || bothEndsDone,
    parsed.preferTests === false,
  );
  const packedKeys = new Set(packed.map((window) => `${window.path}:${window.start}-${window.end}`));
  const distinctiveness = buildTermWeightTable(groups, byFile, launchedCoverage, searchVariantsOf);
  const windowTraces: ExploreWindowTrace[] = prepared.map((window) => {
    const evidence = byFile.get(window.path);
    return {
      path: window.path,
      startLine: window.start,
      endLine: window.end,
      why: window.why,
      packed: packedKeys.has(`${window.path}:${window.start}-${window.end}`),
      grade: window.grade,
      ...(window.unit ? { unit: window.unit } : {}),
      hits: window.hitLines.flatMap((line) => {
        const text = evidence?.hits.get(line)?.text;
        return text ? [text] : [];
      }),
    };
  });
  const omittedFromPack = prepared
    .filter((window) => !packedKeys.has(`${window.path}:${window.start}-${window.end}`))
    .map((window) => ({
      path: window.path,
      startLine: window.start,
      endLine: window.end,
      reason: "not selected for complementary pack",
    }));
  const unread = ranked
    .map((candidate) => candidate.path)
    .filter((path) => !provenance.has(path) || provenance.get(path)?.status === "not-requested");
  for (const path of unread) markProvenance(path, "not-requested");

  const graphDetails: ExploreGraphDetails = {
    status: graphStatus,
    definitions: definitionFiles.size,
    connections: connectionFiles.size,
    ...(associateFiles.size > 0 ? { associates: associateFiles.size } : {}),
    imports: importFiles.size,
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
      patterns: launchedPatterns,
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
      query: { objects: parsed.objects, relation: parsed.relation, domain: parsed.domain },
      ...(skippedContent.length > 0
        ? { skippedQueries: { reason: "direct-verified" as const, patterns: skippedContent } }
        : {}),
      distinctiveness,
      ...(windowTraces.length > 0 ? { windows: windowTraces } : {}),
    },
  };
}

export type ExploreFormatInput = Pick<
  ExploreResult,
  "snippets" | "issues" | "notRequested" | "omitted" | "partial" | "searchIncomplete" | "searched"
> & {
  relations?: NonNullable<WireResult["details"]["relations"]>;
  graph?: ExploreGraphDetails;
  skippedQueries?: NonNullable<WireResult["details"]["skippedQueries"]>;
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
  if (result.skippedQueries?.reason === "direct-verified") {
    header.push(`Skipped ${result.skippedQueries.patterns.length} broad term(s) after a direct clue was verified.`);
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
