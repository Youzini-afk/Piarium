/**
 * Turn an indexed semantic block into a current-body focus range.
 * Hash match uses the recorded span. Otherwise relocate by parent identity and
 * block text. Material change re-slices the current unit and does not keep the
 * old span, and does not drop the clue because the question words are absent.
 */

import { isStructureContainerKind, structureContainerPredicate } from "../../structure/kinds.js";
import type { StructureLineRange, StructureSymbol } from "../../structure/types.js";
import { textOfLines } from "./embed-text.js";
import { contentHashOf } from "./identity.js";

export type SemanticRelocateMode = "hash" | "relocated" | "rechunk";

export type SemanticRelocateInput = {
  lines: readonly string[];
  languageId: string | null;
  recorded: {
    startLine: number;
    endLine: number;
    contentHash: string;
    parentName: string;
    parentKind: string;
    body: string;
  };
  symbols: readonly StructureSymbol[];
};

export type SemanticRelocateResult = StructureLineRange & { mode: SemanticRelocateMode };

const flatten = (symbols: readonly StructureSymbol[]): StructureSymbol[] => {
  const result: StructureSymbol[] = [];
  const visit = (symbol: StructureSymbol): void => {
    result.push(symbol);
    for (const child of symbol.children ?? []) visit(child);
  };
  for (const symbol of symbols) visit(symbol);
  return result;
};

const findParent = (
  symbols: readonly StructureSymbol[],
  name: string,
  kind: string,
  isContainer: (kind: string) => boolean,
): StructureSymbol | undefined => {
  const units = flatten(symbols).filter((symbol) => isContainer(symbol.kind));
  return units.find((symbol) => symbol.name === name && symbol.kind === kind)
    ?? units.find((symbol) => symbol.name === name);
};

const findBodyRange = (lines: readonly string[], bounds: StructureLineRange, body: string): StructureLineRange | null => {
  if (!body) return null;
  const needle = body.split("\n");
  if (needle.length === 0) return null;
  const start = Math.max(1, bounds.startLine);
  const end = Math.min(lines.length, bounds.endLine);
  for (let line = start; line <= end - needle.length + 1; line += 1) {
    let match = true;
    for (let offset = 0; offset < needle.length; offset += 1) {
      if ((lines[line + offset - 1] ?? "") !== needle[offset]) {
        match = false;
        break;
      }
    }
    if (match) return { startLine: line, endLine: line + needle.length - 1 };
  }
  return null;
};

export function relocateSemanticFocus(input: SemanticRelocateInput): SemanticRelocateResult {
  const lineCount = input.lines.length;
  const recorded = input.recorded;
  const inBounds = (
    recorded.startLine >= 1
    && recorded.endLine >= recorded.startLine
    && recorded.endLine <= lineCount
  );
  if (inBounds) {
    const current = textOfLines(input.lines, recorded.startLine, recorded.endLine);
    if (contentHashOf(current) === recorded.contentHash) {
      return { startLine: recorded.startLine, endLine: recorded.endLine, mode: "hash" };
    }
  }
  const isContainer = input.languageId ? structureContainerPredicate(input.languageId) : isStructureContainerKind;
  const parent = recorded.parentName
    ? findParent(input.symbols, recorded.parentName, recorded.parentKind, isContainer)
    : undefined;
  const bounds = parent?.range ?? { startLine: 1, endLine: Math.max(1, lineCount) };
  const relocated = findBodyRange(input.lines, bounds, recorded.body);
  if (relocated) return { ...relocated, mode: "relocated" };
  return { startLine: bounds.startLine, endLine: bounds.endLine, mode: "rechunk" };
}
