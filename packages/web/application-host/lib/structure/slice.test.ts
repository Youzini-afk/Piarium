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

  it("selects the enclosing function instead of an inner value binding", () => {
    const hitLine = 40;
    const lines = ["export function largeTarget() {", ...linesOf(50, hitLine).slice(1, 50), "}"];
    const windows = sliceStructureWindows({
      path: "large.ts",
      lines,
      revision: "rev-1",
      hits: [{ line: hitLine }],
      outline: readyOutline([
        {
          name: "largeTarget",
          kind: "function",
          range: { startLine: 1, endLine: lines.length },
          signature: { startLine: 1, endLine: 1 },
        },
        {
          name: "needle",
          kind: "variable",
          range: { startLine: hitLine, endLine: hitLine },
          signature: { startLine: hitLine, endLine: hitLine },
        },
      ]),
    });
    expect(windows[0]?.unit).toMatchObject({ name: "largeTarget", kind: "function", startLine: 1, endLine: lines.length });
    expect(windows[0]?.text.startsWith("export function largeTarget() {")).toBe(true);
    expect(windows[0]?.text).toContain("const needle = 1;");
    expect(windows[0]?.text).toContain("read large.ts:1-");
  });

  it("pads a signature-only container to at least the window it replaced", () => {
    // tsserver types an interface call signature as SymbolKind.Method, so the
    // smallest container can be a one-line fragment (D-102).
    const lines = [
      "export interface Wide {",
      ...Array.from({ length: 8 }, (_, index) => `  head${index}(): number;`),
      "  needle(): string;",
      ...Array.from({ length: 8 }, (_, index) => `  tail${index}(): number;`),
      "}",
    ];
    const windows = sliceStructureWindows({
      path: "wide.ts",
      lines,
      revision: "rev-1",
      hits: [{ line: 10 }],
      outline: readyOutline([
        {
          name: "Wide",
          kind: "interface",
          range: { startLine: 1, endLine: lines.length },
          signature: { startLine: 1, endLine: 1 },
        },
        {
          name: "needle",
          kind: "method",
          range: { startLine: 10, endLine: 10 },
          signature: { startLine: 10, endLine: 10 },
        },
      ]),
    });
    expect(windows).toHaveLength(1);
    expect(windows[0]).toMatchObject({
      start: 7,
      end: 13,
      fallback: false,
      unit: { name: "needle", kind: "method", startLine: 10, endLine: 10 },
    });
    expect(windows[0]?.text).toContain("needle(): string;");
    expect(windows[0]?.text).toContain("head6(): number;");
    expect(windows[0]?.text).toContain("tail2(): number;");
  });

  it("keeps a container that has a body exact instead of padding it", () => {
    const lines = [
      "const before = 0;",
      "export function needle() {",
      "  return 1;",
      "}",
      "const after = 1;",
    ];
    const windows = sliceStructureWindows({
      path: "body.ts",
      lines,
      revision: "rev-1",
      hits: [{ line: 3 }],
      outline: readyOutline([{
        name: "needle",
        kind: "function",
        range: { startLine: 2, endLine: 4 },
        signature: { startLine: 2, endLine: 2 },
      }]),
    });
    expect(windows[0]).toMatchObject({ start: 2, end: 4, fallback: false });
    expect(windows[0]?.text).toBe("export function needle() {\n  return 1;\n}");
  });

  it("selects the interface instead of a one-line member signature", () => {
    const lines = [
      "export interface Box {",
      "  needle(): void;",
      "  other(): void;",
      "}",
    ];
    const windows = sliceStructureWindows({
      path: "box.ts",
      lines,
      revision: "rev-1",
      hits: [{ line: 2 }],
      outline: readyOutline([
        {
          name: "Box",
          kind: "interface",
          range: { startLine: 1, endLine: 4 },
          signature: { startLine: 1, endLine: 1 },
        },
        {
          name: "needle",
          kind: "property",
          range: { startLine: 2, endLine: 2 },
          signature: { startLine: 2, endLine: 2 },
        },
      ]),
    });
    expect(windows[0]).toMatchObject({
      start: 1,
      end: 4,
      fallback: false,
      unit: { name: "Box", kind: "interface", startLine: 1, endLine: 4 },
      text: lines.join("\n"),
    });
  });

  it("keeps a definition binding as its own unit", () => {
    const lines = [
      "export function wrap() {",
      "  const foo = () => {",
      "    return 1;",
      "  };",
      "  return foo;",
      "}",
    ];
    const windows = sliceStructureWindows({
      path: "bind.ts",
      lines,
      revision: "rev-1",
      hits: [{ line: 3 }],
      outline: readyOutline([
        {
          name: "wrap",
          kind: "function",
          range: { startLine: 1, endLine: 6 },
          signature: { startLine: 1, endLine: 1 },
        },
        {
          name: "foo",
          kind: "function",
          range: { startLine: 2, endLine: 4 },
          signature: { startLine: 2, endLine: 2 },
        },
      ]),
    });
    expect(windows[0]?.unit).toMatchObject({ name: "foo", kind: "function", startLine: 2, endLine: 4 });
    expect(windows[0]?.text).toBe("  const foo = () => {\n    return 1;\n  };");
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
