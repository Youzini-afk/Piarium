import { SMALL_STRUCTURE_SPAN_LINES } from "./constants.js";
import { languageIdForPath } from "@piarium/protocol";
import { isStructureContainerKind, structureContainerPredicate, structureSpanLines } from "./kinds.js";
import { clipRange, mergeAdjacentRanges, rangeContainsLine } from "./ranges.js";
import type { StructureLineRange, StructureOutlineResult, StructureSymbol } from "./types.js";

export type StructureFocusOrigin = "lexical-hit" | "graph-locate" | "semantic-block";

/** Current-body range the slicer should keep in view. A hit line is one origin. */
export interface StructureFocusRange {
  startLine: number;
  endLine: number;
  origin: StructureFocusOrigin;
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
  focusRanges: StructureFocusRange[];
  unit?: StructureSliceUnit;
  fallback: boolean;
}

export interface StructureSliceScheme {
  id: string;
  kind: "signature-focus-omit";
  kept: StructureLineRange[];
  byteCost: number;
}

export interface StructureSliceInput {
  path: string;
  lines: string[];
  focusRanges: StructureFocusRange[];
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

const utf8Bytes = (text: string): number => Buffer.byteLength(text, "utf8");

const validFocus = (focus: StructureFocusRange, lineCount: number): boolean => (
  Number.isSafeInteger(focus.startLine)
  && Number.isSafeInteger(focus.endLine)
  && focus.startLine >= 1
  && focus.endLine >= focus.startLine
  && focus.startLine <= lineCount
);

const clipFocus = (focus: StructureFocusRange, lineCount: number): StructureFocusRange => ({
  ...focus,
  startLine: Math.max(1, focus.startLine),
  endLine: Math.min(lineCount, focus.endLine),
});

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

const focusBlock = (focus: StructureFocusRange, lineCount: number): StructureLineRange => {
  if (focus.startLine === focus.endLine) return lineWindow(focus.startLine, lineCount);
  return { startLine: focus.startLine, endLine: Math.min(lineCount, focus.endLine) };
};

const fallbackWindows = (lines: string[], focuses: StructureFocusRange[]): StructureSliceWindow[] => {
  const valid = focuses.filter((focus) => validFocus(focus, lines.length)).map((focus) => clipFocus(focus, lines.length));
  const ranges: Array<{ range: StructureLineRange; focuses: StructureFocusRange[] }> = [];
  for (const focus of valid.toSorted((left, right) => left.startLine - right.startLine || left.endLine - right.endLine)) {
    const next = focusBlock(focus, lines.length);
    const previous = ranges.at(-1);
    if (previous && next.startLine <= previous.range.endLine + 1) {
      previous.range.endLine = Math.max(previous.range.endLine, next.endLine);
      previous.focuses.push(focus);
    } else {
      ranges.push({ range: next, focuses: [focus] });
    }
  }
  return ranges.map((item) => ({
    start: item.range.startLine,
    end: item.range.endLine,
    text: textOf(lines, item.range),
    hitLines: item.focuses.map((focus) => focus.startLine),
    focusRanges: item.focuses,
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
  focuses: readonly StructureFocusRange[],
): StructureLineRange => {
  const windows = focuses
    .filter((focus) => validFocus(focus, lines.length))
    .map((focus) => focusBlock(clipFocus(focus, lines.length), lines.length));
  if (windows.length === 0) return range;
  return {
    startLine: Math.min(range.startLine, ...windows.map((window) => window.startLine)),
    endLine: Math.max(range.endLine, ...windows.map((window) => window.endLine)),
  };
};

const keptForSymbol = (
  lines: string[],
  symbol: StructureSymbol,
  focuses: readonly StructureFocusRange[],
): StructureLineRange[] => {
  const span = structureSpanLines(symbol.range.startLine, symbol.range.endLine);
  if (span <= SMALL_STRUCTURE_SPAN_LINES) {
    const range = signatureOnly(symbol)
      ? paddedToWindows(symbol.range, lines, focuses)
      : symbol.range;
    return [range];
  }
  const signature = clipRange(symbol.signature, symbol.range);
  const blocks = focuses.map((focus) => clipRange(focusBlock(clipFocus(focus, lines.length), lines.length), symbol.range));
  return mergeAdjacentRanges([signature, ...blocks]);
};

/** Candidate presentations and their UTF-8 cost. This knife ships one scheme. */
export function proposeSymbolSliceSchemes(
  path: string,
  lines: string[],
  symbol: StructureSymbol,
  focuses: readonly StructureFocusRange[],
): StructureSliceScheme[] {
  const kept = keptForSymbol(lines, symbol, focuses);
  const { text } = largeUnitText(path, lines, symbol.range, kept);
  const small = structureSpanLines(symbol.range.startLine, symbol.range.endLine) <= SMALL_STRUCTURE_SPAN_LINES;
  return [{
    id: "signature-focus-omit",
    kind: "signature-focus-omit",
    kept,
    byteCost: utf8Bytes(small ? textOf(lines, kept[0] ?? symbol.range) : text),
  }];
}

export function renderSymbolSliceScheme(
  path: string,
  lines: string[],
  symbol: StructureSymbol,
  focuses: readonly StructureFocusRange[],
  scheme: StructureSliceScheme,
): StructureSliceWindow {
  const unit = {
    name: symbol.name,
    kind: symbol.kind,
    startLine: symbol.range.startLine,
    endLine: symbol.range.endLine,
  };
  const span = structureSpanLines(symbol.range.startLine, symbol.range.endLine);
  if (span <= SMALL_STRUCTURE_SPAN_LINES) {
    const range = scheme.kept[0] ?? symbol.range;
    return {
      start: range.startLine,
      end: range.endLine,
      text: textOf(lines, range),
      hitLines: focuses.map((focus) => focus.startLine),
      focusRanges: [...focuses],
      unit,
      fallback: false,
    };
  }
  const { text, omitted } = largeUnitText(path, lines, symbol.range, scheme.kept);
  return {
    start: scheme.kept[0]?.startLine ?? symbol.range.startLine,
    end: scheme.kept.at(-1)?.endLine ?? symbol.range.endLine,
    text,
    hitLines: focuses.map((focus) => focus.startLine),
    focusRanges: [...focuses],
    unit: omitted.length > 0 ? { ...unit, omitted } : unit,
    fallback: false,
  };
}

const sliceSymbol = (
  path: string,
  lines: string[],
  symbol: StructureSymbol,
  focuses: readonly StructureFocusRange[],
): StructureSliceWindow => {
  const schemes = proposeSymbolSliceSchemes(path, lines, symbol, focuses);
  return renderSymbolSliceScheme(path, lines, symbol, focuses, schemes[0]!);
};

/**
 * Build explore windows from an outline, or the ±3 line fallback when the
 * outline is not a usable current revision. Empty only when there are no
 * focus ranges — a semantic block is a focus even when it is not a hit line.
 */
export function sliceStructureWindows(input: StructureSliceInput): StructureSliceWindow[] {
  const focuses = input.focusRanges.filter((focus) => validFocus(focus, input.lines.length)).map((focus) => clipFocus(focus, input.lines.length));
  if (focuses.length === 0) return [];
  const outline = input.outline;
  if (!outlineUsableForText(outline, input.revision) || !outline.symbols.length) {
    return fallbackWindows(input.lines, focuses);
  }
  const isContainer = structureContainerPredicate(languageIdForPath(input.path));
  const grouped = new Map<StructureSymbol, StructureFocusRange[]>();
  const unstructured: StructureFocusRange[] = [];
  for (const focus of focuses) {
    const symbol = enclosingSliceSymbol(outline.symbols, focus.startLine, isContainer);
    if (!symbol) {
      unstructured.push(focus);
      continue;
    }
    const group = grouped.get(symbol) ?? [];
    group.push(focus);
    grouped.set(symbol, group);
  }
  const windows: StructureSliceWindow[] = [];
  for (const [symbol, group] of grouped) {
    windows.push(sliceSymbol(input.path, input.lines, symbol, group.toSorted((left, right) => left.startLine - right.startLine)));
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
