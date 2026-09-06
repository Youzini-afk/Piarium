import type { StructureLineRange } from "./types.js";

export interface LspLikeRange {
  start: { line: number; character: number };
  end: { line: number; character: number };
}

/**
 * Convert a 0-based LSP range to inclusive 1-based explore lines.
 * An end at column 0 of a later line is treated as exclusive of that line.
 */
export function lspRangeToLines(range: LspLikeRange): StructureLineRange {
  const startLine = range.start.line + 1;
  const endLine = range.end.character === 0 && range.end.line > range.start.line
    ? range.end.line
    : range.end.line + 1;
  return { startLine, endLine: Math.max(startLine, endLine) };
}

export function rangeContainsLine(range: StructureLineRange, line: number): boolean {
  return line >= range.startLine && line <= range.endLine;
}

export function clipRange(range: StructureLineRange, bounds: StructureLineRange): StructureLineRange {
  return {
    startLine: Math.max(range.startLine, bounds.startLine),
    endLine: Math.min(range.endLine, bounds.endLine),
  };
}

export function mergeAdjacentRanges(ranges: StructureLineRange[]): StructureLineRange[] {
  const ordered = [...ranges]
    .filter((range) => range.endLine >= range.startLine)
    .sort((left, right) => left.startLine - right.startLine || left.endLine - right.endLine);
  const merged: StructureLineRange[] = [];
  for (const range of ordered) {
    const previous = merged.at(-1);
    if (previous && range.startLine <= previous.endLine + 1) {
      previous.endLine = Math.max(previous.endLine, range.endLine);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}
