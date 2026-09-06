import { describe, expect, it } from "vitest";
import { SMALL_STRUCTURE_SPAN_LINES } from "./constants.js";
import { sliceStructureWindows } from "./slice.js";
import type { StructureOutlineResult, StructureSymbol } from "./types.js";

const linesOf = (count: number, hitLine: number): string[] => (
  Array.from({ length: count }, (_, index) => (index + 1 === hitLine ? "  const needle = 1;" : `  const pad${index + 1} = ${index + 1};`))
);

const readyOutline = (symbols: StructureSymbol[], revision = "rev-1"): StructureOutlineResult => ({
  status: "ready",
  provider: "lsp",
  revision,
  symbols,
});

describe("sliceStructureWindows", () => {
  it("emits a small unit in full instead of a ±3 window", () => {
    const lines = [
      "export function needle() {",
      "  return 1;",
      "}",
    ];
    const windows = sliceStructureWindows({
      path: "small.ts",
      lines,
      revision: "rev-1",
      hits: [{ line: 2 }],
      outline: readyOutline([{
        name: "needle",
        kind: "function",
        range: { startLine: 1, endLine: 3 },
        signature: { startLine: 1, endLine: 1 },
      }]),
    });
    expect(windows).toHaveLength(1);
    expect(windows[0]).toMatchObject({
      start: 1,
      end: 3,
      text: lines.join("\n"),
      fallback: false,
      unit: { name: "needle", kind: "function", startLine: 1, endLine: 3 },
    });
    expect(windows[0]?.text).not.toContain("omitted");
  });

  it("emits signature, hit block, omission markers, and a full-unit read entry for a large unit", () => {
    const hitLine = 40;
    const lines = ["export function largeTarget() {", ...linesOf(50, hitLine).slice(1, 50), "}"];
    expect(lines.length).toBeGreaterThan(SMALL_STRUCTURE_SPAN_LINES);
    const windows = sliceStructureWindows({
      path: "large.ts",
      lines,
      revision: "rev-1",
      hits: [{ line: hitLine }],
      outline: readyOutline([{
        name: "largeTarget",
        kind: "function",
        range: { startLine: 1, endLine: lines.length },
        signature: { startLine: 1, endLine: 1 },
      }]),
    });
    expect(windows).toHaveLength(1);
    const window = windows[0]!;
    expect(window.fallback).toBe(false);
    expect(window.unit).toMatchObject({
      name: "largeTarget",
      kind: "function",
      startLine: 1,
      endLine: lines.length,
    });
    expect(window.unit?.omitted?.length).toBeGreaterThan(0);
    expect(window.text.startsWith("export function largeTarget() {")).toBe(true);
    expect(window.text).toContain("const needle = 1;");
    expect(window.text).toMatch(/… omitted large\.ts:\d+-\d+; read large\.ts:1-\d+/);
    expect(window.text).toContain(`read large.ts:1-${lines.length}`);
    expect(window.start).toBe(1);
    expect(window.end).toBeLessThan(lines.length);
    expect(window.end).toBeGreaterThanOrEqual(hitLine);
  });

  it("falls back to a ±3 line window when the outline is unavailable", () => {
    const lines = Array.from({ length: 10 }, (_, index) => index === 6 ? "needle" : `line ${index + 1}`);
    const windows = sliceStructureWindows({
      path: "a.ts",
      lines,
      revision: "rev-1",
      hits: [{ line: 7 }],
      outline: { status: "unavailable", provider: "lsp", revision: "rev-1", symbols: [] },
    });
    expect(windows).toEqual([{
      start: 4,
      end: 10,
      text: "line 4\nline 5\nline 6\nneedle\nline 8\nline 9\nline 10",
      hitLines: [7],
      fallback: true,
    }]);
  });

  it("does not apply a stale outline to the current text", () => {
    const lines = Array.from({ length: 10 }, (_, index) => index === 6 ? "needle" : `line ${index + 1}`);
    const windows = sliceStructureWindows({
      path: "a.ts",
      lines,
      revision: "rev-1",
      hits: [{ line: 7 }],
      outline: readyOutline([{
        name: "oldNeedle",
        kind: "function",
        range: { startLine: 1, endLine: 10 },
        signature: { startLine: 1, endLine: 1 },
      }], "rev-old"),
    });
    expect(windows[0]).toMatchObject({ start: 4, end: 10, fallback: true });
    expect(windows[0]?.unit).toBeUndefined();
    expect(windows[0]?.text).toBe("line 4\nline 5\nline 6\nneedle\nline 8\nline 9\nline 10");
  });
});
