/**
 * Structure-recursive chunking for the local semantic index.
 *
 * Small containers stay whole. Large ones split on child containers, then on
 * overlapping line windows. Every source line is covered by at least one chunk.
 * Token limits come from the supplied tokenizer, not a character estimate.
 */

import { isStructureContainerKind, structureContainerPredicate } from "../../structure/kinds.js";
import type { StructureLineRange, StructureOutlineResult, StructureSymbol } from "../../structure/types.js";
import { buildEmbedText, splitSourceLines, textOfLines, type TokenCounter } from "./embed-text.js";
import { blockIdentity, contentHashOf, parentUnitIdentity } from "./identity.js";

export type SemanticChunk = {
  blockId: string;
  parentUnitId: string;
  documentId: string;
  parentName: string;
  parentKind: string;
  parentSignature: string;
  startLine: number;
  endLine: number;
  contentHash: string;
  body: string;
  embedText: string;
  fallback: boolean;
  /** Offset of `body` inside the original line-range text when a range was continue-split. */
  bodyOffset?: number;
};

export type ChunkDocumentInput = {
  documentId: string;
  text: string;
  languageId: string | null;
  outline: Pick<StructureOutlineResult, "status" | "symbols">;
  maxTokens: number;
  countTokens: TokenCounter;
};

const commentLine = /^\s*(\/\/|\/\*|\*|#)/u;

const flattenContainers = (
  symbols: readonly StructureSymbol[],
  isContainer: (kind: string) => boolean,
): StructureSymbol[] => {
  const result: StructureSymbol[] = [];
  const visit = (symbol: StructureSymbol): void => {
    if (isContainer(symbol.kind)) result.push(symbol);
    for (const child of symbol.children ?? []) visit(child);
  };
  for (const symbol of symbols) visit(symbol);
  return result;
};

const childContainers = (
  symbol: StructureSymbol,
  isContainer: (kind: string) => boolean,
): StructureSymbol[] => (symbol.children ?? []).filter((child) => isContainer(child.kind));

const signatureText = (lines: readonly string[], symbol: StructureSymbol): string => (
  textOfLines(lines, symbol.signature.startLine, symbol.signature.endLine)
);

const docCommentsBefore = (lines: readonly string[], startLine: number): string => {
  const collected: string[] = [];
  for (let line = startLine - 1; line >= 1; line -= 1) {
    const text = lines[line - 1] ?? "";
    if (!commentLine.test(text)) break;
    collected.unshift(text);
  }
  return collected.join("\n");
};

const gapsInside = (bounds: StructureLineRange, occupied: readonly StructureLineRange[]): StructureLineRange[] => {
  const ordered = [...occupied]
    .filter((range) => range.endLine >= range.startLine)
    .sort((left, right) => left.startLine - right.startLine);
  const gaps: StructureLineRange[] = [];
  let cursor = bounds.startLine;
  for (const range of ordered) {
    if (range.startLine > cursor) gaps.push({ startLine: cursor, endLine: range.startLine - 1 });
    cursor = Math.max(cursor, range.endLine + 1);
  }
  if (cursor <= bounds.endLine) gaps.push({ startLine: cursor, endLine: bounds.endLine });
  return gaps;
};

const prefixThatFits = (text: string, maxTokens: number, countTokens: TokenCounter): number => {
  if (text.length === 0) return 0;
  if (countTokens(text) <= maxTokens) return text.length;
  let low = 1;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (countTokens(text.slice(0, middle)) <= maxTokens) low = middle;
    else high = middle - 1;
  }
  return Math.max(1, low);
};

const splitBodyPieces = (body: string, maxTokens: number, countTokens: TokenCounter): Array<{ text: string; offset: number }> => {
  if (body.length === 0) return [];
  if (countTokens(body) <= maxTokens) return [{ text: body, offset: 0 }];
  const pieces: Array<{ text: string; offset: number }> = [];
  let offset = 0;
  let remaining = body;
  while (remaining.length > 0) {
    const take = prefixThatFits(remaining, maxTokens, countTokens);
    pieces.push({ text: remaining.slice(0, take), offset });
    remaining = remaining.slice(take);
    offset += take;
  }
  return pieces;
};

const makeChunks = (
  documentId: string,
  lines: readonly string[],
  range: StructureLineRange,
  parent: { name: string; kind: string; signature: string },
  docs: string,
  maxTokens: number,
  countTokens: TokenCounter,
  fallback: boolean,
): SemanticChunk[] => {
  const body = textOfLines(lines, range.startLine, range.endLine);
  const pieces = splitBodyPieces(body, maxTokens, countTokens);
  return pieces.map((piece, index) => {
    const embedText = buildEmbedText({
      documentId,
      parentName: parent.name,
      parentSignature: parent.signature,
      docComments: docs,
      body: piece.text,
    }, maxTokens, countTokens);
    const blockId = pieces.length === 1
      ? blockIdentity(documentId, range.startLine, range.endLine)
      : `${blockIdentity(documentId, range.startLine, range.endLine)}#p${index}`;
    return {
      blockId,
      parentUnitId: parentUnitIdentity(documentId, parent.name, parent.kind),
      documentId,
      parentName: parent.name,
      parentKind: parent.kind,
      parentSignature: parent.signature,
      startLine: range.startLine,
      endLine: range.endLine,
      contentHash: contentHashOf(piece.text),
      body: piece.text,
      embedText,
      fallback,
      ...(pieces.length > 1 ? { bodyOffset: piece.offset } : {}),
    };
  });
};

const windowFits = (
  lines: readonly string[],
  range: StructureLineRange,
  maxTokens: number,
  countTokens: TokenCounter,
): boolean => {
  const body = textOfLines(lines, range.startLine, range.endLine);
  // buildEmbedText never removes body text to make room for decoration, so a
  // window fits exactly when its body fits. Avoid rebuilding and tokenizing the
  // decorated text several times for every size probe.
  return countTokens(body) <= maxTokens;
};

const overlappingChunks = (
  documentId: string,
  lines: readonly string[],
  range: StructureLineRange,
  parent: { name: string; kind: string; signature: string },
  docs: string,
  maxTokens: number,
  countTokens: TokenCounter,
): SemanticChunk[] => {
  const lineCount = range.endLine - range.startLine + 1;
  let low = 1;
  let high = lineCount;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const probe = { startLine: range.startLine, endLine: range.startLine + middle - 1 };
    if (windowFits(lines, probe, maxTokens, countTokens)) low = middle;
    else high = middle - 1;
  }
  const size = Math.max(1, low);
  if (size === 1 && !windowFits(lines, { startLine: range.startLine, endLine: range.startLine }, maxTokens, countTokens)) {
    return makeChunks(documentId, lines, range, parent, docs, maxTokens, countTokens, true);
  }
  const overlap = Math.min(8, Math.max(1, Math.floor(size / 4)));
  const step = Math.max(1, size - overlap);
  const chunks: SemanticChunk[] = [];
  for (let start = range.startLine; start <= range.endLine; start += step) {
    const end = Math.min(range.endLine, start + size - 1);
    chunks.push(...makeChunks(documentId, lines, { startLine: start, endLine: end }, parent, docs, maxTokens, countTokens, true));
    if (end >= range.endLine) break;
  }
  return chunks;
};

const emitRange = (
  documentId: string,
  lines: readonly string[],
  range: StructureLineRange,
  parent: { name: string; kind: string; signature: string },
  docs: string,
  maxTokens: number,
  countTokens: TokenCounter,
  fallback: boolean,
): SemanticChunk[] => {
  if (range.endLine < range.startLine) return [];
  if (windowFits(lines, range, maxTokens, countTokens)) {
    return makeChunks(documentId, lines, range, parent, docs, maxTokens, countTokens, fallback);
  }
  return overlappingChunks(documentId, lines, range, parent, docs, maxTokens, countTokens);
};

const chunkSymbol = (
  documentId: string,
  lines: readonly string[],
  symbol: StructureSymbol,
  isContainer: (kind: string) => boolean,
  maxTokens: number,
  countTokens: TokenCounter,
): SemanticChunk[] => {
  const parent = {
    name: symbol.name,
    kind: symbol.kind,
    signature: signatureText(lines, symbol),
  };
  const docs = docCommentsBefore(lines, symbol.range.startLine);
  if (windowFits(lines, symbol.range, maxTokens, countTokens)) {
    return makeChunks(documentId, lines, symbol.range, parent, docs, maxTokens, countTokens, false);
  }
  const children = childContainers(symbol, isContainer);
  if (children.length === 0) {
    return overlappingChunks(documentId, lines, symbol.range, parent, docs, maxTokens, countTokens);
  }
  const chunks: SemanticChunk[] = [];
  for (const child of children) chunks.push(...chunkSymbol(documentId, lines, child, isContainer, maxTokens, countTokens));
  for (const gap of gapsInside(symbol.range, children.map((child) => child.range))) {
    chunks.push(...emitRange(documentId, lines, gap, parent, docs, maxTokens, countTokens, false));
  }
  return chunks;
};

const markCovered = (covered: boolean[], range: StructureLineRange): void => {
  for (let line = range.startLine; line <= range.endLine; line += 1) covered[line] = true;
};

export function chunkDocument(input: ChunkDocumentInput): SemanticChunk[] {
  const lines = splitSourceLines(input.text);
  const lineCount = lines.length;
  if (lineCount === 0) return [];
  const isContainer = input.languageId ? structureContainerPredicate(input.languageId) : isStructureContainerKind;
  const outlineReady = input.outline.status === "ready" || input.outline.status === "empty";
  const units = outlineReady ? flattenContainers(input.outline.symbols, isContainer) : [];
  const topLevel = units.filter((symbol) => (
    !units.some((other) => (
      other !== symbol
      && other.range.startLine <= symbol.range.startLine
      && other.range.endLine >= symbol.range.endLine
      && (other.range.endLine - other.range.startLine) > (symbol.range.endLine - symbol.range.startLine)
    ))
  ));
  const chunks: SemanticChunk[] = [];
  for (const symbol of topLevel) {
    chunks.push(...chunkSymbol(input.documentId, lines, symbol, isContainer, input.maxTokens, input.countTokens));
  }
  const covered = Array.from({ length: lineCount + 1 }, () => false);
  for (const chunk of chunks) markCovered(covered, { startLine: chunk.startLine, endLine: chunk.endLine });
  const fileParent = { name: "", kind: "file", signature: "" };
  const missing: StructureLineRange[] = [];
  let start: number | null = null;
  for (let line = 1; line <= lineCount; line += 1) {
    if (!covered[line]) {
      if (start === null) start = line;
    } else if (start !== null) {
      missing.push({ startLine: start, endLine: line - 1 });
      start = null;
    }
  }
  if (start !== null) missing.push({ startLine: start, endLine: lineCount });
  const fallback = !outlineReady || topLevel.length === 0;
  for (const gap of missing) {
    chunks.push(...emitRange(
      input.documentId,
      lines,
      gap,
      fileParent,
      "",
      input.maxTokens,
      input.countTokens,
      fallback,
    ));
  }
  return chunks;
}
