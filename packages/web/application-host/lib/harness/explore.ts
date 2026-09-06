import type { HarnessServiceMap } from "@piarium/protocol";
import type { ExploreFileSnapshot } from "./explore-file-reader.js";

type WireResult = HarnessServiceMap["explore.search"]["result"];
export type ExploreSnippet = WireResult["snippets"][number];
export type ExploreIssue = WireResult["issues"][number];

export interface RgHit {
  path: string;
  line: number;
  /** The full matched line, without its line terminator. */
  text: string;
}

export interface ExploreInput {
  question: string;
  paths?: string[];
  limit?: number;
}

export interface ExploreDeps {
  rgSearch(pattern: string, options: { fixedStrings: boolean; paths?: string[]; limit?: number }): Promise<RgHit[]>;
  readFile(path: string): Promise<ExploreFileSnapshot>;
}

export interface ExploreResult {
  snippets: ExploreSnippet[];
  issues: ExploreIssue[];
  partial: boolean;
  searched: WireResult["searched"];
}

const QUESTION_WORDS = new Set([
  "how", "does", "where", "what", "why", "which", "is", "are", "the", "a", "an", "of", "to", "in", "and", "find",
  "这个", "那个", "这里", "那里", "哪里", "怎么", "如何", "为什么", "什么", "是否", "的", "了", "在", "是", "和", "与", "或", "请", "帮", "找", "查", "看看", "一下",
]);

const CHINESE_WORD_SEGMENTER = typeof Intl.Segmenter === "function"
  ? new Intl.Segmenter("zh", { granularity: "word" })
  : null;

export function extractIdentifiers(question: string): string[] {
  const identifiers = question.match(/[$_\p{L}][$_\p{L}\p{M}\p{N}]*/gu) ?? [];
  const terms = new Set<string>();
  for (const identifier of identifiers) {
    if (!QUESTION_WORDS.has(identifier.toLowerCase())) terms.add(identifier);
    for (const part of identifier.replace(/(\p{Ll})(\p{Lu})/gu, "$1 $2").split(/[\s_]+/u)) {
      if (part && !QUESTION_WORDS.has(part.toLowerCase())) terms.add(part);
    }
    if (CHINESE_WORD_SEGMENTER && /\p{Script=Han}/u.test(identifier)) {
      for (const segment of CHINESE_WORD_SEGMENTER.segment(identifier)) {
        if (segment.isWordLike && !QUESTION_WORDS.has(segment.segment)) terms.add(segment.segment);
      }
    }
  }
  return [...terms];
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

const comparePath = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

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
  const literals = extractQuotedLiterals(input.question);
  const identifiers = extractIdentifiers(input.question);
  const patterns = buildRgPatterns(identifiers, literals);
  // A natural-language query without extracted identifiers is still a real literal search.
  if (patterns.length === 0 && input.question.trim()) patterns.push({ pattern: input.question.trim(), fixedStrings: true });

  const groups = await Promise.all(patterns.map(async ({ pattern, fixedStrings }) => {
    signal.throwIfAborted();
    const hits = await deps.rgSearch(pattern, {
      fixedStrings,
      ...(input.paths ? { paths: input.paths } : {}),
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
    });
    signal.throwIfAborted();
    return hits;
  }));

  const byFile = new Map<string, Map<number, string>>();
  const ranks = new Map<string, number>();
  const matchedPatterns = new Map<string, number>();
  for (const hits of groups) {
    const rankedPaths = [...new Set(hits.map((hit) => hit.path))];
    rankedPaths.forEach((path, rank) => {
      // Reciprocal-rank fusion of the actual query results; no phantom vector/PageRank scores.
      ranks.set(path, (ranks.get(path) ?? 0) + 1 / (rank + 1));
      matchedPatterns.set(path, (matchedPatterns.get(path) ?? 0) + 1);
    });
    for (const hit of hits) {
      const lines = byFile.get(hit.path) ?? new Map<number, string>();
      lines.set(hit.line, hit.text);
      byFile.set(hit.path, lines);
    }
  }

  const issues: ExploreIssue[] = [];
  const snippets: ExploreSnippet[] = [];
  const orderedPaths = [...byFile.keys()].sort((a, b) => (ranks.get(b) ?? 0) - (ranks.get(a) ?? 0) || comparePath(a, b));
  for (const path of orderedPaths) {
    signal.throwIfAborted();
    let snapshot: ExploreFileSnapshot;
    try {
      snapshot = await deps.readFile(path);
    } catch {
      signal.throwIfAborted();
      snapshot = { status: "failed", message: "Document read failed. Search again or inspect workspace availability." };
    }
    signal.throwIfAborted();
    if (snapshot.status !== "ready") {
      issues.push({ path, status: snapshot.status, message: snapshot.message });
      continue;
    }
    const lines = snapshot.content.split(/\r\n|\n|\r/);
    const matches: number[] = [];
    let stale = false;
    for (const [line, text] of byFile.get(path)!) {
      if (!Number.isSafeInteger(line) || line < 1 || lines[line - 1] !== text) {
        stale = true;
      } else {
        matches.push(line);
      }
    }
    if (stale) issues.push({ path, status: "stale", message: "Some search hits no longer match this document revision; those hits were omitted." });
    matches.sort((a, b) => a - b);
    const windows: Array<{ start: number; end: number }> = [];
    for (const line of matches) {
      const start = Math.max(1, line - 3);
      const end = Math.min(lines.length, line + 3);
      const previous = windows.at(-1);
      if (previous && start <= previous.end + 1) previous.end = Math.max(previous.end, end);
      else windows.push({ start, end });
    }
    for (const window of windows) {
      snippets.push({
        path,
        startLine: window.start,
        endLine: window.end,
        text: lines.slice(window.start - 1, window.end).join("\n"),
        revision: snapshot.revision,
        source: snapshot.source,
        why: "matched " + matchedPatterns.get(path) + " query term(s)",
      });
    }
  }

  const limit = input.limit ?? 20;
  return {
    snippets: snippets.slice(0, limit),
    issues,
    partial: issues.length > 0 || snippets.length > limit,
    // The search provider does not report total scanned files. This counts files with hits.
    searched: { patterns: patterns.length, files: byFile.size, ms: Date.now() - startedAt },
  };
}
