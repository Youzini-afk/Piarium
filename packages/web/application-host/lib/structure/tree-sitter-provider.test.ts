import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { createTreeSitterStructureProvider } from "./tree-sitter-provider.js";

const request = (text: string, path = "sample.ts") => ({
  path,
  languageId: path.endsWith(".tsx") ? "typescriptreact" : "typescript",
  text,
  revision: "rev-1",
});

describe("createTreeSitterStructureProvider", () => {
  it("outlines TypeScript units from the vendored wasm", async () => {
    const provider = createTreeSitterStructureProvider();
    const text = [
      "import { join } from \"node:path\";",
      "export function needle() {",
      "  return join(\"a\");",
      "}",
      "export class Box {}",
    ].join("\n");
    const outline = await provider.outline(request(text));
    expect(outline.status).toBe("ready");
    expect(outline.provider).toBe("tree-sitter");
    expect(outline.symbols.map((symbol) => symbol.name)).toEqual(expect.arrayContaining(["needle", "Box"]));
    const needle = outline.symbols.find((symbol) => symbol.name === "needle");
    expect(needle?.kind).toBe("function");
    expect(needle?.range).toEqual({ startLine: 2, endLine: 4 });
    const calls = await provider.literalCalls(request(text));
    expect(calls.status).toBe("ready");
    expect(calls.calls).toEqual(expect.arrayContaining([expect.objectContaining({ name: "join", literal: "a" })]));
    const imports = await provider.imports(request(text));
    expect(imports.status).toBe("ready");
    expect(imports.imports).toEqual(expect.arrayContaining([expect.objectContaining({ source: "node:path" })]));
  });

  it("classifies declaration names differently from comments and strings", async () => {
    const provider = createTreeSitterStructureProvider();
    const text = [
      "// needle",
      "export function needle() {",
      "  return \"needle\";",
      "}",
    ].join("\n");
    const classified = await provider.classifyHits({ ...request(text), lines: [1, 2, 3] });
    expect(classified.status).toBe("ready");
    expect(classified.hits).toEqual([
      { line: 1, class: "comment" },
      { line: 2, class: "name" },
      { line: 3, class: "string" },
    ]);
  });

  it("reports cancelled when the signal is already aborted", async () => {
    const provider = createTreeSitterStructureProvider();
    const signal = AbortSignal.abort();
    const result = await provider.outline({ ...request("export function needle() { return 1; }"), signal });
    expect(result.status).toBe("cancelled");
    expect(result.symbols).toEqual([]);
  });

  it("reports failed when the parse budget is exhausted", async () => {
    const provider = createTreeSitterStructureProvider({ parseBudgetMs: 0 });
    const text = Array.from({ length: 400 }, (_, index) => `export function item${index}() { return ${index}; }`).join("\n");
    const result = await provider.outline(request(text));
    expect(result.status).toBe("failed");
    expect(result.message).toMatch(/budget exhausted/i);
    expect(result.symbols).toEqual([]);
  });

  it("reports unavailable when the runtime wasm cannot be read", async () => {
    const empty = mkdtempSync(join(tmpdir(), "piarium-structure-runtime-"));
    const provider = createTreeSitterStructureProvider({
      runtimeFromUrl: pathToFileURL(join(empty, "missing.js")).href,
    });
    const result = await provider.outline(request("export function needle() { return 1; }"));
    expect(result.status).toBe("unavailable");
    expect(result.message).toMatch(/not readable/i);
  });
});
