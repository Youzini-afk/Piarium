import { describe, expect, it } from "vitest";
import { createStructureSource } from "../../structure/source.js";
import { createTreeSitterStructureProvider } from "../../structure/tree-sitter-provider.js";
import { chunkDocument } from "./chunker.js";
import { LOCAL_MINILM_MAX_TOKENS } from "./identity.js";

const parsingSource = () => createStructureSource([
  createTreeSitterStructureProvider({ parseBudgetMs: 30_000 }),
]);

const wordCount = (text: string): number => Math.max(1, text.split(/\s+/u).filter(Boolean).length);

describe("chunkDocument", () => {
  it("covers every line of a large function and keeps each embed text at the tokenizer limit", async () => {
    const bodyLines = Array.from({ length: 80 }, (_, index) => `  const marker_${index + 1} = ${index + 1};`);
    const text = [
      "export function processRequest(input: string) {",
      ...bodyLines,
      "  return input;",
      "}",
    ].join("\n");
    const source = parsingSource();
    const outline = await source.outline({
      path: "mail:abc123",
      languageId: "typescript",
      text,
      revision: "r1",
    });
    expect(outline.status).toBe("ready");
    const maxTokens = 24;
    const chunks = chunkDocument({
      documentId: "mail:abc123",
      text,
      languageId: "typescript",
      outline,
      maxTokens,
      countTokens: wordCount,
    });
    expect(chunks.length).toBeGreaterThan(1);
    const lineCount = text.split("\n").length;
    for (let line = 1; line <= lineCount; line += 1) {
      expect(chunks.some((chunk) => chunk.startLine <= line && chunk.endLine >= line), `line ${line} uncovered`).toBe(true);
    }
    for (const chunk of chunks) {
      expect(wordCount(chunk.embedText)).toBeLessThanOrEqual(maxTokens);
      expect(chunk.documentId).toBe("mail:abc123");
      expect(chunk.blockId).toContain(encodeURIComponent("mail:abc123"));
    }
    expect(chunks.some((chunk) => chunk.parentName === "processRequest")).toBe(true);
  });

  it("uses overlapping fallback windows when structure is missing", () => {
    const text = Array.from({ length: 40 }, (_, index) => `line_${index + 1} token token token token`).join("\n");
    const chunks = chunkDocument({
      documentId: "plain.txt",
      text,
      languageId: null,
      outline: { status: "unsupported", symbols: [] },
      maxTokens: 12,
      countTokens: wordCount,
    });
    expect(chunks.every((chunk) => chunk.fallback)).toBe(true);
    const lineCount = 40;
    for (let line = 1; line <= lineCount; line += 1) {
      expect(chunks.some((chunk) => chunk.startLine <= line && chunk.endLine >= line)).toBe(true);
    }
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.some((chunk) => chunk.startLine > 1 && chunks.some((other) => (
      other !== chunk && other.endLine >= chunk.startLine && other.startLine <= chunk.startLine
    )))).toBe(true);
  });

  it("does not treat a character budget as the tokenizer window", async () => {
    const text = [
      "export function keep() {",
      "  const alphabet = \"abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz\";",
      "  return alphabet;",
      "}",
    ].join("\n");
    const source = parsingSource();
    const outline = await source.outline({
      path: "keep.ts",
      languageId: "typescript",
      text,
      revision: "r1",
    });
    const countTokens = (value: string) => value.split(/\s+/u).filter(Boolean).length;
    const chunks = chunkDocument({
      documentId: "keep.ts",
      text,
      languageId: "typescript",
      outline,
      maxTokens: LOCAL_MINILM_MAX_TOKENS,
      countTokens,
    });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.embedText).toContain("abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz");
  });
});
