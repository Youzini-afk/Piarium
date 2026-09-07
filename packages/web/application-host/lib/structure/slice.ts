import { SMALL_STRUCTURE_SPAN_LINES } from "./constants.js";
import { languageIdForPath } from "@piarium/protocol";
import { isStructureContainerKind, structureContainerPredicate, structureSpanLines } from "./kinds.js";
import { clipRange, mergeAdjacentRanges, rangeContainsLine } from "./ranges.js";
import type { StructureLineRange, StructureOutlineResult, StructureSymbol } from "./types.js";

export interface StructureSliceHit {
  line: number;
}

export interface StructureSliceUnit {
  name: string;
  kind: string;
  startLine: number;
  endLine: number;
  omitted?: StructureLineRange[];
}

export interface StructureSliceWindow {
  start: number;
  end: number;
  text: string;
  hitLines: number[];
  unit?: StructureSliceUnit;
  fallback: boolean;
}

export interface StructureSliceInput {
  path: string;
  lines: string[];
  hits: StructureSliceHit[];
  revision: string;
  outline: StructureOutlineResult | { status: "not-requested"; provider: null; revision?: string; symbols?: StructureSymbol[] };
}

const flattenSymbols = (symbols: readonly StructureSymbol[]): StructureSymbol[] => {
  const result: StructureSymbol[] = [];
  const visit = (symbol: StructureSymbol): void => {
    result.push(symbol);
    for (const child of symbol.children ?? []) visit(child);
  };
  for (const symbol of symbols) visit(symbol);
  return result;
};

/**
 * Smallest enclosing *container*. Value bindings and members are ignored so a
 * hit on `const needle = 1` inside `function big` selects `big` (D-098).
 */
export function enclosingSliceSymbol(
  symbols: readonly StructureSymbol[],
  line: number,
  isContainer: (kind: string) => boolean = isStructureContainerKind,
): StructureSymbol | undefined {
  let best: StructureSymbol | undefined;
  for (const symbol of flattenSymbols(symbols)) {
    if (!isContainer(symbol.kind) || !rangeContainsLine(symbol.range, line)) continue;
    if (!best) {
      best = symbol;
      continue;
    }
    const bestSpan = structureSpanLines(best.range.startLine, best.range.endLine);
    const nextSpan = structureSpanLines(symbol.range.startLine, symbol.range.endLine);
    if (nextSpan < bestSpan || (nextSpan === bestSpan && symbol.range.startLine >= best.range.startLine)) {
      best = symbol;
    }
  }
  return best;
}

export function outlineCoversHitLines(
  symbols: readonly StructureSymbol[],
  lines: readonly number[],
  isContainer?: (kind: string) => boolean,
): boolean {
  return lines.length > 0 && lines.every((line) => enclosingSliceSymbol(symbols, line, isContainer) !== undefined);
}

const lineWindow = (line: number, lineCount: number): StructureLineRange => ({
  startLine: Math.max(1, line - 3),
  endLine: Math.min(lineCount, line + 3),
});

const textOf = (lines: string[], range: StructureLineRange): string => (
  lines.slice(range.startLine - 1, range.endLine).join("\n")
);

const omittedBetween = (bounds: StructureLineRange, kept: StructureLineRange[]): StructureLineRange[] => {
  const omitted: StructureLineRange[] = [];
  let cursor = bounds.startLine;
  for (const range of kept) {
    if (range.startLine > cursor) {
      omitted.push({ startLine: cursor, endLine: range.startLine - 1 });
    }
    cursor = Math.max(cursor, range.endLine + 1);
  }
  if (cursor <= bounds.endLine) omitted.push({ startLine: cursor, endLine: bounds.endLine });
  return omitted;
};

const omissionMarker = (path: string, omitted: StructureLineRange, unit: StructureLineRange): string => (
  `… omitted ${path}:${omitted.startLine}-${omitted.endLine}; read ${path}:${unit.startLine}-${unit.endLine}`
);

const largeUnitText = (
  path: string,
  lines: string[],
  unit: StructureLineRange,
  kept: StructureLineRange[],
): { text: string; omitted: StructureLineRange[] } => {
  const omitted = omittedBetween(unit, kept);
  const parts: string[] = [];
  let omitIndex = 0;
  for (const range of kept) {
    while (omitIndex < omitted.length && omitted[omitIndex]!.endLine < range.startLine) {
      parts.push(omissionMarker(path, omitted[omitIndex]!, unit));
      omitIndex += 1;
    }
    parts.push(textOf(lines, range));
  }
  while (omitIndex < omitted.length) {
    parts.push(omissionMarker(path, omitted[omitIndex]!, unit));
    omitIndex += 1;
  }
  return { text: parts.join("\n"), omitted };
};

const fallbackWindows = (lines: string[], hits: StructureSliceHit[]): StructureSliceWindow[] => {
  const valid = [...hits].map((hit) => hit.line).filter((line) => Number.isSafeInteger(line) && line >= 1 && line <= lines.length).sort((a, b) => a - b);
  const ranges: Array<{ range: StructureLineRange; hitLines: number[] }> = [];
  for (const line of valid) {
    const next = lineWindow(line, lines.length);
    const previous = ranges.at(-1);
    if (previous && next.startLine <= previous.range.endLine + 1) {
      previous.range.endLine = Math.max(previous.range.endLine, next.endLine);
      previous.hitLines.push(line);
    } else {
      ranges.push({ range: next, hitLines: [line] });
    }
  }
  return ranges.map((item) => ({
    start: item.range.startLine,
    end: item.range.endLine,
    text: textOf(lines, item.range),
    hitLines: item.hitLines,
    fallback: true,
  }));
};

/**
 * A unit that is nothing but its own signature: an interface member, an
 * ambient or abstract declaration, a one-line definition. LSP reports these
 * under container kinds — tsserver types an interface call signature as
 * `method` — so a hit on one would emit a bare fragment carrying less than the
 * ±3 window it replaced. Units with a body identify themselves and stay exact
 * (D-102).
 */
const signatureOnly = (symbol: StructureSymbol): boolean => {
  const signature = clipRange(symbol.signature, symbol.range);
  return signature.startLine <= symbol.range.startLine && signature.endLine >= symbol.range.endLine;
};

const paddedToWindows = (
  range: StructureLineRange,
  lines: string[],
  hitLines: number[],
): StructureLineRange => {
  const windows = hitLines
    .filter((line) => Number.isSafeInteger(line) && line >= 1 && line <= lines.length)
    .map((line) => lineWindow(line, lines.length));
  if (windows.length === 0) return range;
  return {
    startLine: Math.min(range.startLine, ...windows.map((window) => window.startLine)),
    endLine: Math.max(range.endLine, ...windows.map((window) => window.endLine)),
  };
};

const sliceSymbol = (
  path: string,
  lines: string[],
  symbol: StructureSymbol,
  hitLines: number[],
): StructureSliceWindow => {
  const span = structureSpanLines(symbol.range.startLine, symbol.range.endLine);
  const unit = {
    name: symbol.name,
    kind: symbol.kind,
    startLine: symbol.range.startLine,
    endLine: symbol.range.endLine,
  };
  if (span <= SMALL_STRUCTURE_SPAN_LINES) {
    const range = signatureOnly(symbol)
      ? paddedToWindows(symbol.range, lines, hitLines)
      : symbol.range;
    return {
      start: range.startLine,
      end: range.endLine,
      text: textOf(lines, range),
      hitLines,
      unit,
      fallback: false,
    };
  }
  const signature = clipRange(symbol.signature, symbol.range);
  const hitBlocks = mergeAdjacentRanges(hitLines.map((line) => clipRange(lineWindow(line, lines.length), symbol.range)));
  const kept = mergeAdjacentRanges([signature, ...hitBlocks]);
  const { text, omitted } = largeUnitText(path, lines, symbol.range, kept);
  return {
    start: kept[0]?.startLine ?? symbol.range.startLine,
    end: kept.at(-1)?.endLine ?? symbol.range.endLine,
    text,
    hitLines,
    unit: omitted.length > 0 ? { ...unit, omitted } : unit,
    fallback: false,
  };
};

/**
 * Build explore windows from an outline, or the ±3 line fallback when the
 * outline is not a usable current revision.
 */
export function sliceStructureWindows(input: StructureSliceInput): StructureSliceWindow[] {
  const hits = input.hits.filter((hit) => Number.isSafeInteger(hit.line));
  if (hits.length === 0) return [];
  const outline = input.outline;
  if (!outlineUsableForText(outline, input.revision) || !outline.symbols.length) {
    return fallbackWindows(input.lines, hits);
  }
  const isContainer = structureContainerPredicate(languageIdForPath(input.path));
  const grouped = new Map<StructureSymbol, number[]>();
  const unstructured: StructureSliceHit[] = [];
  for (const hit of hits) {
    const symbol = enclosingSliceSymbol(outline.symbols, hit.line, isContainer);
    if (!symbol) {
      unstructured.push(hit);
      continue;
    }
    const group = grouped.get(symbol) ?? [];
    group.push(hit.line);
    grouped.set(symbol, group);
  }
  const windows: StructureSliceWindow[] = [];
  for (const [symbol, hitLines] of grouped) {
    windows.push(sliceSymbol(input.path, input.lines, symbol, hitLines.sort((a, b) => a - b)));
  }
  windows.push(...fallbackWindows(input.lines, unstructured));
  return windows.sort((left, right) => left.start - right.start || left.end - right.end);
}

export function outlineUsableForText(
  outline: StructureOutlineResult | { status: string; revision?: string },
  revision: string,
): outline is StructureOutlineResult & { status: "ready" } {
  return outline.status === "ready" && outline.revision === revision;
}
