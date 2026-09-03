/**
 * explore pipeline — multi-pattern code search for open questions.
 *
 * Design: agent-harness.md §5.7, §6.1
 * Plan: agent-harness-plan.md §3.2
 *
 * Pure algorithm mode first (no LLM). Query expansion:
 * - Extract identifiers from question
 * - AC exact + BM25 top 5 on symbol names
 * - Synonym expansion table
 * - ≤ 12 rg patterns
 *
 * Parallel fan-out → merge dedup → rank → slice snippets.
 *
 * Score: 0.35*hitDensity + 0.25*pagerank + 0.15*recency +
 *        0.10*pathPref + 0.15*vectorSim
 * (no vector → redistribute 0.15 proportionally to first four)
 */

// ── Types ──────────────────────────────────────────────────────────

export interface ExploreSnippet {
  path: string;
  startLine: number;
  endLine: number;
  text: string;
  why: string;
}

export interface ExploreResult {
  snippets: ExploreSnippet[];
  searched: { patterns: number; files: number; ms: number };
  handle: string;
  usedLlm: boolean;
}

export interface ExploreInput {
  question: string;
  paths?: string[];
  limit?: number; // default 20
}

export interface RgHit {
  path: string;
  line: number;
  text: string;
}

export interface SymbolCandidate {
  name: string;
  path: string;
  score: number;
}

export interface ExploreDeps {
  /** Run ripgrep with a pattern, return hits */
  rgSearch: (pattern: string, options: { fixedStrings: boolean; paths?: string[] | undefined; limit: number }) => Promise<RgHit[]>;
  /** Search symbol candidates in knowledge base */
  searchSymbols: (query: string, k: number) => Promise<SymbolCandidate[]>;
  /** Semantic recall (embedding mode only) */
  semanticRecall?: (query: string, k: number) => Promise<Array<{ path: string; score: number }>>;
  /** LLM expand (optional) */
  llmExpand?: (query: string) => Promise<{ patterns: string[]; symbols: string[] }>;
  /** LLM rerank (optional) */
  llmRerank?: (candidates: ExploreSnippet[], query: string) => Promise<Array<{ snippet: ExploreSnippet; explanation: string }>>;
  /** Get file recency (epoch ms of last modification) */
  getFileRecency?: (path: string) => number | null;
  /** Get PageRank score for a path */
  getPageRank?: (path: string) => number;
}

// ── Query expansion (pure algorithm) ───────────────────────────────

const IDENTIFIER_RE = /[A-Za-z_][A-Za-z0-9_]{2,}/g;

const DEFAULT_SYNONYMS: Record<string, string[]> = {
  config: ["settings", "configuration", "conf"],
  settings: ["config", "configuration", "conf"],
  auth: ["login", "authentication", "credentials"],
  login: ["auth", "authentication", "signin"],
  user: ["account", "profile"],
  error: ["exception", "failure", "fault"],
  create: ["make", "new", "build", "construct"],
  delete: ["remove", "destroy", "drop"],
  update: ["modify", "change", "patch", "edit"],
  get: ["fetch", "retrieve", "load", "read"],
  set: ["assign", "store", "save", "write"],
};

export function extractIdentifiers(question: string): string[] {
  const matches = question.match(IDENTIFIER_RE) ?? [];
  // Also split camelCase and snake_case
  const expanded: string[] = [];
  for (const match of matches) {
    expanded.push(match);
    // camelCase split: "myFunction" → ["my", "Function"]
    const camelParts = match.replace(/([a-z])([A-Z])/g, "$1 $2").split(/\s+/);
    if (camelParts.length > 1) {
      for (const part of camelParts) {
        if (part.length >= 2) expanded.push(part);
      }
    }
    // snake_case split: "my_func" → ["my", "func"]
    const snakeParts = match.split("_").filter((p) => p.length >= 2);
    if (snakeParts.length > 1) expanded.push(...snakeParts);
  }
  // Deduplicate and filter short words (< 3 chars) but keep split parts ≥ 2
  return [...new Set(expanded)].filter((w) => w.length >= 3);
}

export function extractQuotedLiterals(question: string): string[] {
  const quoted = question.match(/["'`]([^"'`]+)["'`]/g) ?? [];
  return quoted.map((q) => q.slice(1, -1));
}

export function expandWithSynonyms(words: string[], synonyms: Record<string, string[]> = DEFAULT_SYNONYMS): string[] {
  const expanded = new Set<string>(words);
  for (const word of words) {
    const lower = word.toLowerCase();
    if (synonyms[lower]) {
      for (const syn of synonyms[lower]) expanded.add(syn);
    }
  }
  return [...expanded];
}

export function buildRgPatterns(
  identifiers: string[],
  literals: string[],
  symbolCandidates: string[],
): Array<{ pattern: string; fixedStrings: boolean }> {
  const patterns: Array<{ pattern: string; fixedStrings: boolean }> = [];

  // Literals → fixed strings
  for (const lit of literals.slice(0, 4)) {
    patterns.push({ pattern: lit, fixedStrings: true });
  }

  // Identifiers → word boundary patterns
  for (const id of identifiers.slice(0, 8)) {
    patterns.push({ pattern: `\\b${escapeRegex(id)}\\b`, fixedStrings: false });
  }

  // Symbol candidates → word boundary
  for (const sym of symbolCandidates.slice(0, 4)) {
    patterns.push({ pattern: `\\b${escapeRegex(sym)}\\b`, fixedStrings: false });
  }

  return patterns.slice(0, 12);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ── Ranking ────────────────────────────────────────────────────────

export interface ScoredSnippet {
  snippet: ExploreSnippet;
  score: number;
}

export function rankSnippets(
  snippets: ExploreSnippet[],
  hits: Map<string, RgHit[]>,
  deps: ExploreDeps,
  hasVector: boolean,
): ScoredSnippet[] {
  // Weights: redistribute vectorSim if no vector
  const w = hasVector
    ? { hitDensity: 0.35, pagerank: 0.25, recency: 0.15, pathPref: 0.10, vectorSim: 0.15 }
    : { hitDensity: 0.35 * (1 + 0.15 / 0.85), pagerank: 0.25 * (1 + 0.15 / 0.85), recency: 0.15 * (1 + 0.15 / 0.85), pathPref: 0.10 * (1 + 0.15 / 0.85), vectorSim: 0 };

  const scored = snippets.map((snippet) => {
    const fileHits = hits.get(snippet.path) ?? [];
    const hitDensity = Math.min(fileHits.length / 10, 1);
    const pagerank = deps.getPageRank ? deps.getPageRank(snippet.path) : 0;
    const recencyMs = deps.getFileRecency ? deps.getFileRecency(snippet.path) : null;
    const recency = recencyMs ? Math.max(0, 1 - (Date.now() - recencyMs) / (30 * 24 * 60 * 60 * 1000)) : 0;
    const pathPref = snippet.path.includes("src") ? 0.5 : 0;
    const vectorSim = 0; // Would come from semanticRecall

    const score = w.hitDensity * hitDensity + w.pagerank * pagerank + w.recency * recency + w.pathPref * pathPref + w.vectorSim * vectorSim;
    return { snippet, score };
  });

  return scored.sort((a, b) => b.score - a.score);
}

// ── Main explore function ──────────────────────────────────────────

export async function explore(
  input: ExploreInput,
  deps: ExploreDeps,
): Promise<ExploreResult> {
  const startTime = Date.now();
  const limit = input.limit ?? 20;
  const usedLlm = !!deps.llmExpand;

  // 1. Query expansion
  let patterns: Array<{ pattern: string; fixedStrings: boolean }>;
  let symbolCandidates: string[] = [];

  if (deps.llmExpand) {
    const expanded = await deps.llmExpand(input.question);
    patterns = expanded.patterns.map((p) => ({ pattern: p, fixedStrings: false }));
    symbolCandidates = expanded.symbols;
  } else {
    const identifiers = extractIdentifiers(input.question);
    const literals = extractQuotedLiterals(input.question);
    const expanded = expandWithSynonyms(identifiers);

    // Search symbol candidates
    if (expanded.length > 0) {
      const symResults = await deps.searchSymbols(expanded.join(" "), 5);
      symbolCandidates = symResults.map((s) => s.name);
    }

    patterns = buildRgPatterns(expanded, literals, symbolCandidates);
  }

  // 2. Parallel fan-out
  const rgPromises = patterns.map((p) =>
    deps.rgSearch(p.pattern, { fixedStrings: p.fixedStrings, paths: input.paths, limit: 50 }),
  );
  const semanticPromise = deps.semanticRecall ? deps.semanticRecall(input.question, 20) : Promise.resolve([]);

  const [rgResults, semanticResults] = await Promise.all([
    Promise.all(rgPromises),
    semanticPromise,
  ]);

  // 3. Merge dedup by path:line
  const allHits: RgHit[] = rgResults.flat();
  const hitsByFile = new Map<string, RgHit[]>();
  for (const hit of allHits) {
    const arr = hitsByFile.get(hit.path) ?? [];
    arr.push(hit);
    hitsByFile.set(hit.path, arr);
  }

  // 4. Build snippets from hits (context 3 lines, merge adjacent)
  const snippets = buildSnippetsFromHits(allHits, 3);

  // 5. Rank
  let ranked = rankSnippets(snippets, hitsByFile, deps, !!deps.semanticRecall);

  // LLM rerank if available
  if (deps.llmRerank && ranked.length > 0) {
    const top40 = ranked.slice(0, 40).map((r) => r.snippet);
    const reranked = await deps.llmRerank(top40, input.question);
    ranked = reranked.map((r, i) => ({
      snippet: { ...r.snippet, why: r.explanation },
      score: 1 - i * 0.01, // Reranked order determines score
    }));
  } else {
    // Add why explanation
    ranked = ranked.map((r) => ({
      ...r,
      snippet: { ...r.snippet, why: `matched ${hitsByFile.get(r.snippet.path)?.length ?? 0} patterns` },
    }));
  }

  // 6. Slice to limit
  const finalSnippets = ranked.slice(0, limit).map((r) => r.snippet);

  const elapsed = Date.now() - startTime;
  const filesSearched = new Set(allHits.map((h) => h.path)).size;

  return {
    snippets: finalSnippets,
    searched: { patterns: patterns.length, files: filesSearched, ms: elapsed },
    handle: `explore_${startTime}`,
    usedLlm,
  };
}

function buildSnippetsFromHits(hits: RgHit[], contextLines: number): ExploreSnippet[] {
  // Group hits by file, merge adjacent windows
  const byFile = new Map<string, RgHit[]>();
  for (const hit of hits) {
    const arr = byFile.get(hit.path) ?? [];
    arr.push(hit);
    byFile.set(hit.path, arr);
  }

  const snippets: ExploreSnippet[] = [];
  for (const [path, fileHits] of byFile) {
    fileHits.sort((a, b) => a.line - b.line);
    // Merge adjacent hits (within contextLines of each other)
    let currentStart = fileHits[0]!.line - contextLines;
    let currentEnd = fileHits[0]!.line + contextLines;
    let currentText = fileHits[0]!.text;

    for (let i = 1; i < fileHits.length; i++) {
      const hit = fileHits[i]!;
      if (hit.line - contextLines <= currentEnd) {
        // Merge
        currentEnd = hit.line + contextLines;
        currentText += "\n" + hit.text;
      } else {
        // Flush current
        snippets.push({
          path,
          startLine: Math.max(0, currentStart),
          endLine: currentEnd,
          text: currentText,
          why: "",
        });
        currentStart = hit.line - contextLines;
        currentEnd = hit.line + contextLines;
        currentText = hit.text;
      }
    }
    // Flush last
    snippets.push({
      path,
      startLine: Math.max(0, currentStart),
      endLine: currentEnd,
      text: currentText,
      why: "",
    });
  }

  return snippets;
}
