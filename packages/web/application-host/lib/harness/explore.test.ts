import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_BYTE_BUDGET,
  DEFAULT_CANDIDATE_BUDGET,
  DEFAULT_HITS_PER_FILE,
  buildRgPatterns,
  buildTermGroups,
  explore,
  extractIdentifiers,
  extractQuotedLiterals,
  formatExploreOutput,
  maxMaterializeReads,
  type ExploreDeps,
} from "./explore.js";
import type { ExploreFileSnapshot } from "./explore-file-reader.js";
import { createStructureSource } from "../structure/source.js";
import { createTreeSitterStructureProvider } from "../structure/tree-sitter-provider.js";
import type { StructureOutlineResult, StructureProvider, StructureSource } from "../structure/types.js";

const ready = (content: string, revision = "rev-1"): ExploreFileSnapshot => ({ status: "ready", content, revision, source: "disk" });

/**
 * Slice assertions need a real parse, and the production budget is a wall
 * clock that a loaded runner can exhaust. Pin a budget so these tests do not
 * depend on machine load (D-102).
 */
const parsingProvider = () => createTreeSitterStructureProvider({ parseBudgetMs: 30_000 });

describe("explore query terms", () => {
  it("preserves Unicode, combining marks, single-character and dollar identifiers", () => {
    const terms = extractIdentifiers("where is x $value 计算值 e\u0301 myFunction snake_case");
    expect(terms).toEqual(expect.arrayContaining(["x", "$value", "计算值", "e\u0301", "myFunction", "Function", "snake_case", "snake", "case"]));
    expect(terms).not.toContain("where");
  });

  it("adds useful words for an unspaced Chinese question instead of searching only the full sentence", () => {
    const terms = extractIdentifiers("这个配置在哪里解析");
    expect(terms).toEqual(expect.arrayContaining(["配置", "解析"]));
    expect(terms).not.toContain("这个");
    expect(terms).not.toContain("哪里");
  });

  it("extracts quoted literals without treating regex characters as syntax", () => {
    expect(extractQuotedLiterals('find "a.*b" and ‘中文错误’')).toEqual(["a.*b", "中文错误"]);
    expect(buildRgPatterns(["x", "a.*b"], ["a.*b"])).toEqual([
      { pattern: "a.*b", fixedStrings: true },
      { pattern: "x", fixedStrings: true },
    ]);
  });

  it("does not impose the old twelve-pattern cutoff", () => {
    const ids = Array.from({ length: 21 }, (_, index) => "symbol" + index);
    expect(buildRgPatterns(ids, []).map((entry) => entry.pattern)).toEqual(ids);
  });

  it("keeps blank anchors in supplied and omits them from used", () => {
    const { suppliedAnchors, usedAnchors, groups } = buildTermGroups("needle", ["foo", "", "  "]);
    expect(suppliedAnchors).toEqual(["foo", "", "  "]);
    expect(usedAnchors).toEqual(["foo"]);
    expect(groups.filter((group) => group.kind === "anchor").map((group) => group.distinctive)).toEqual(["foo"]);
  });

  it("groups an identifier with its splits instead of treating each variant as its own concept", () => {
    const { groups } = buildTermGroups("where is createMemoryAgentExtension");
    const identifier = groups.find((group) => group.distinctive === "createMemoryAgentExtension");
    expect(identifier?.kind).toBe("identifier");
    expect(identifier?.variants).toEqual(expect.arrayContaining(["createMemoryAgentExtension", "Agent", "Extension"]));
    expect(groups.filter((group) => group.kind === "identifier")).toHaveLength(1);
  });
});

describe("explore versioned excerpts", () => {
  it("reads one real snapshot per file and deduplicates repeated hits", async () => {
    const content = Array.from({ length: 10 }, (_, index) => index === 6 ? "needle" : "line " + (index + 1)).join("\r\n");
    const readFile = vi.fn(async () => ready(content));
    const result = await explore({ question: "needle needle" }, {
      rgSearch: async () => [{ path: "a.ts", line: 7, text: "needle" }, { path: "a.ts", line: 7, text: "needle" }],
      readFile,
    });
    expect(readFile).toHaveBeenCalledOnce();
    expect(result.snippets).toEqual([{
      path: "a.ts", startLine: 4, endLine: 10,
      text: "line 4\nline 5\nline 6\nneedle\nline 8\nline 9\nline 10",
      revision: "rev-1", source: "disk", why: "matched needle",
    }]);
    expect(result.partial).toBe(false);
    expect(result.issues).toEqual([]);
    expect(result.notRequested).toEqual({ count: 0, paths: [] });
  });

  it("never fabricates a range when the document is missing", async () => {
    const result = await explore({ question: "needle" }, {
      rgSearch: async () => [{ path: "gone.ts", line: 10, text: "needle" }],
      readFile: async () => ({ status: "unavailable", message: "Document is missing." }),
    });
    expect(result.snippets).toEqual([]);
    expect(result.issues).toEqual([{ path: "gone.ts", status: "unavailable", message: "Document is missing." }]);
    expect(result.partial).toBe(true);
    expect(result.details.provenance[0]?.status).toBe("unavailable");
  });

  it("drops hits whose lines changed between search and read", async () => {
    const result = await explore({ question: "needle" }, {
      rgSearch: async () => [{ path: "a.ts", line: 1, text: "needle" }],
      readFile: async () => ready("different current text", "rev-2"),
    });
    expect(result.snippets).toEqual([]);
    expect(result.issues).toEqual([expect.objectContaining({ path: "a.ts", status: "stale" })]);
  });

  it("keeps readable evidence when another document fails", async () => {
    const result = await explore({ question: "needle" }, {
      rgSearch: async () => [
        { path: "a.ts", line: 1, text: "needle" },
        { path: "b.ts", line: 1, text: "needle" },
      ],
      readFile: async (path) => path === "a.ts" ? ready("needle\nbody") : { status: "failed", message: "Read failed." },
    });
    expect(result.snippets.map((snippet) => snippet.path)).toEqual(["a.ts"]);
    expect(result.snippets[0]?.endLine).toBe(2);
    expect(result.issues[0]?.path).toBe("b.ts");
    expect(result.partial).toBe(true);
  });

  it("counts distinct query evidence and returns stable ranking", async () => {
    const result = await explore({ question: "needle target" }, {
      rgSearch: async (pattern) => pattern === "needle"
        ? [{ path: "a.ts", line: 1, text: "needle" }, { path: "b.ts", line: 1, text: "needle target" }]
        : [{ path: "b.ts", line: 1, text: "needle target" }],
      readFile: async (path) => ready(path === "a.ts" ? "needle" : "needle target"),
    });
    expect(result.snippets.map((snippet) => snippet.path)).toEqual(["b.ts", "a.ts"]);
    expect(result.snippets[0]?.why).toMatch(/2 term groups/);
    expect(result.searched.files).toBe(2);
  });

  it("honors the requested excerpt count and marks omitted results", async () => {
    const result = await explore({ question: "needle", limit: 1 }, {
      rgSearch: async () => [{ path: "a.ts", line: 1, text: "needle" }, { path: "b.ts", line: 1, text: "needle" }],
      readFile: async () => ready("needle"),
    });
    expect(result.snippets).toHaveLength(1);
    expect(result.partial).toBe(true);
  });

  it("does not run search after cancellation", async () => {
    const deps: ExploreDeps = { rgSearch: vi.fn(async () => []), readFile: vi.fn(async () => ready("")) };
    await expect(explore({ question: "needle" }, deps, AbortSignal.abort())).rejects.toMatchObject({ name: "AbortError" });
    expect(deps.rgSearch).not.toHaveBeenCalled();
    expect(deps.readFile).not.toHaveBeenCalled();
  });

  it("propagates cancellation during reading instead of making a source failure", async () => {
    const controller = new AbortController();
    await expect(explore({ question: "needle" }, {
      rgSearch: async () => [{ path: "a.ts", line: 1, text: "needle" }],
      readFile: async () => { controller.abort(); return ready("needle"); },
    }, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  });

  it("does not forward the output limit as the candidate search budget", async () => {
    const rgSearch = vi.fn<ExploreDeps["rgSearch"]>(async () => [{ path: "a.ts", line: 1, text: "needle" }]);
    await explore({ question: "needle", limit: 1 }, { rgSearch, readFile: async () => ready("needle") });
    expect(rgSearch).toHaveBeenCalledWith("needle", expect.objectContaining({
      fixedStrings: true,
      candidateBudget: DEFAULT_CANDIDATE_BUDGET,
      hitsPerFile: DEFAULT_HITS_PER_FILE,
    }));
    expect(rgSearch.mock.calls[0]?.[1]).not.toHaveProperty("limit");
  });
});

describe("explore D-090 candidate ranking and materialization", () => {
  it("T1: limit 1 still keeps an anchor hit from a second file in the candidate pool and output", async () => {
    const genericHits = Array.from({ length: 50 }, (_, index) => ({ path: "flood.ts", line: index + 1, text: `token ${index}` }));
    const result = await explore({ question: "token", limit: 1, anchors: ["uniqueAnchor"] }, {
      rgSearch: async (pattern) => pattern === "uniqueAnchor"
        ? [{ path: "key.ts", line: 1, text: "uniqueAnchor" }]
        : genericHits,
      readFile: async (path) => ready(path === "key.ts" ? "uniqueAnchor" : Array.from({ length: 50 }, (_, index) => `token ${index}`).join("\n")),
    });
    expect(result.searched.files).toBe(2);
    expect(result.snippets.some((snippet) => snippet.path === "key.ts")).toBe(true);
    expect(result.snippets).toHaveLength(1);
  });

  it("T3: a full identifier outranks files that only repeat its split words", async () => {
    const result = await explore({ question: "createMemoryAgentExtension" }, {
      rgSearch: async (pattern) => {
        if (pattern === "createMemoryAgentExtension") return [{ path: "src/factory.ts", line: 1, text: "export function createMemoryAgentExtension() {}" }];
        if (pattern === "Agent" || pattern === "Extension") {
          return Array.from({ length: 8 }, (_, index) => ({ path: "src/generic.ts", line: index + 1, text: `Agent Extension ${index}` }));
        }
        return [];
      },
      readFile: async (path) => ready(
        path === "src/factory.ts"
          ? "export function createMemoryAgentExtension() {}"
          : Array.from({ length: 8 }, (_, index) => `Agent Extension ${index}`).join("\n"),
      ),
    });
    expect(result.snippets[0]?.path).toBe("src/factory.ts");
    expect(result.snippets.map((snippet) => snippet.path)).toContain("src/generic.ts");
  });

  it("T4: a hitting anchor ranks first; a miss does not exclude question hits; metacharacters stay literal", async () => {
    const rgSearch = vi.fn(async (pattern: string) => {
      if (pattern === "createMemoryAgentExtension") return [{ path: "src/factory.ts", line: 1, text: "export function createMemoryAgentExtension() {}" }];
      if (pattern === "a.*b") return [{ path: "src/literal.ts", line: 1, text: "const re = \"a.*b\";" }];
      if (pattern === "missingAnchor") return [];
      return [];
    });
    const result = await explore({
      question: "createMemoryAgentExtension",
      anchors: ["a.*b", "missingAnchor"],
    }, {
      rgSearch,
      readFile: async (path) => ready(
        path === "src/literal.ts" ? "const re = \"a.*b\";" : "export function createMemoryAgentExtension() {}",
      ),
    });
    expect(rgSearch).toHaveBeenCalledWith("a.*b", expect.objectContaining({ fixedStrings: true }));
    expect(result.snippets[0]?.path).toBe("src/literal.ts");
    expect(result.snippets.map((snippet) => snippet.path)).toContain("src/factory.ts");
    expect(result.details.anchors.used).toEqual(["a.*b", "missingAnchor"]);
  });

  it("T5: a test file with an exact anchor is not ranked below a generic source file", async () => {
    const result = await explore({ question: "token", anchors: ["exactAnchor"] }, {
      rgSearch: async (pattern) => pattern === "exactAnchor"
        ? [{ path: "src/feature.test.ts", line: 1, text: "exactAnchor" }]
        : [{ path: "src/feature.ts", line: 1, text: "token" }],
      readFile: async (path) => ready(path.endsWith(".test.ts") ? "exactAnchor" : "token"),
    });
    expect(result.snippets[0]?.path).toBe("src/feature.test.ts");
  });

  it("T6: reads on demand, bounds readFile, and reports unread files as not-requested", async () => {
    const files = Array.from({ length: 10 }, (_, index) => `f${index}.ts`);
    const readFile = vi.fn(async (path: string) => ready(`needle in ${path}`));
    const result = await explore({ question: "needle", limit: 2 }, {
      rgSearch: async () => files.map((path) => ({ path, line: 1, text: `needle in ${path}` })),
      readFile,
    });
    const bound = maxMaterializeReads(10, 2);
    expect(bound).toBe(5);
    expect(readFile.mock.calls.length).toBeLessThanOrEqual(bound);
    expect(readFile.mock.calls.length).toBeGreaterThan(0);
    expect(result.snippets).toHaveLength(2);
    expect(result.notRequested.count).toBeGreaterThan(0);
    expect(result.notRequested.paths.length).toBe(result.notRequested.count);
    expect(result.details.provenance.filter((entry) => entry.status === "empty")).toEqual([]);
    expect(result.details.provenance.filter((entry) => entry.status === "not-requested").map((entry) => entry.path))
      .toEqual(result.notRequested.paths);
  });

  it("T7: a second file with a key hit appears even when the first file has many windows", async () => {
    const firstHits = [1, 8, 15, 22, 29].map((line) => ({ path: "first.ts", line, text: `token ${line}` }));
    const result = await explore({ question: "token", anchors: ["keyHit"], limit: 2 }, {
      rgSearch: async (pattern) => pattern === "keyHit"
        ? [{ path: "second.ts", line: 1, text: "keyHit" }]
        : firstHits,
      readFile: async (path) => ready(
        path === "second.ts"
          ? "keyHit"
          : Array.from({ length: 32 }, (_, index) => firstHits.some((hit) => hit.line === index + 1) ? `token ${index + 1}` : `pad ${index + 1}`).join("\n"),
      ),
    });
    expect(result.snippets.map((snippet) => snippet.path).sort()).toEqual(["first.ts", "second.ts"]);
  });

  it("T8: packs to a byte budget, lists omitted supports, and keeps provenance in details", async () => {
    const long = "x".repeat(200);
    const files = Array.from({ length: 8 }, (_, index) => `f${index}.ts`);
    const result = await explore({ question: "needle", limit: 3 }, {
      rgSearch: async () => files.map((path) => ({ path, line: 1, text: `needle in ${path}` })),
      readFile: async (path) => ready(`needle in ${path}\n${long}`),
    });
    const packed = formatExploreOutput(result, { byteBudget: 280 });
    expect(Buffer.byteLength(packed.visibleText, "utf8")).toBeLessThanOrEqual(280);
    expect(packed.omitted.length).toBeGreaterThan(0);
    expect(packed.omitted.some((item) => item.reason === "over byte budget")).toBe(true);
    expect(packed.storedBody).toMatch(/Unread candidates \(not-requested/);
    expect(packed.showHandle).toBe(true);
    expect(result.details.provenance.length).toBe(8);
    expect(result.details.provenance.some((entry) => entry.status === "not-requested")).toBe(true);
    expect(result.details.byteBudget).toBe(DEFAULT_BYTE_BUDGET);
    expect(result.snippets[0]?.revision).toBe("rev-1");
    const withHandle = formatExploreOutput(result, { byteBudget: 280, handle: "out_test" });
    expect(withHandle.showHandle).toBe(true);
    expect(withHandle.visibleText).toContain("get_output(\"out_test\")");
    expect(Buffer.byteLength(withHandle.visibleText, "utf8")).toBeLessThanOrEqual(280);
  });

  it("ranks a single anchor file ahead of files that only match three split-word groups", async () => {
    const splitFiles = Array.from({ length: 10 }, (_, index) => `split${index}.ts`);
    const readFile = vi.fn(async (path: string) => ready(path === "anchor.ts" ? "uniqueAnchor" : "Alpha Beta Gamma"));
    const result = await explore({ question: "Alpha Beta Gamma", anchors: ["uniqueAnchor"], limit: 2 }, {
      rgSearch: async (pattern) => {
        if (pattern === "uniqueAnchor") return [{ path: "anchor.ts", line: 1, text: "uniqueAnchor" }];
        if (pattern === "Alpha" || pattern === "Beta" || pattern === "Gamma") {
          return splitFiles.map((path) => ({ path, line: 1, text: "Alpha Beta Gamma" }));
        }
        return [];
      },
      readFile,
    });
    expect(result.snippets.some((snippet) => snippet.path === "anchor.ts")).toBe(true);
    expect(result.notRequested.paths).not.toContain("anchor.ts");
    expect(readFile.mock.calls.some((call) => call[0] === "anchor.ts")).toBe(true);
  });

  it("reports filesDropped separately from a hit-budget partial", async () => {
    const result = await explore({ question: "needle" }, {
      rgSearch: async () => ({
        hits: [{ path: "kept.ts", line: 1, text: "needle" }],
        partial: true,
        filesDropped: 13,
      }),
      readFile: async () => ready("needle"),
    });
    expect(result.searched.incomplete).toBe(true);
    expect(result.searched.filesDropped).toBe(13);
    const packed = formatExploreOutput(result);
    expect(packed.visibleText).toMatch(/at least 13 matching file\(s\) were not brought into the candidate pool/);
    expect(packed.visibleText).not.toMatch(/candidate working budget reached/);
  });

  it("reports filesDropped as a floor instead of summing overlapping query terms", async () => {
    const dropsByPattern = new Map<string, number>();
    const result = await explore({ question: "Alpha Beta", anchors: ["myAnchor"] }, {
      rgSearch: async (pattern) => {
        const filesDropped = pattern === "myAnchor" ? 40 : 12;
        dropsByPattern.set(pattern, filesDropped);
        return { hits: [{ path: "kept.ts", line: 1, text: "myAnchor Alpha Beta" }], filesDropped };
      },
      readFile: async () => ready("myAnchor Alpha Beta"),
    });
    const summed = [...dropsByPattern.values()].reduce((sum, count) => sum + count, 0);
    expect(dropsByPattern.size).toBeGreaterThan(1);
    expect(result.searched.filesDropped).toBe(40);
    expect(result.searched.filesDropped).toBeLessThan(summed);
    expect(result.searched.incomplete).toBe(true);
  });

  it("formats confirmed connections separately from association candidates and counts them against the byte budget", async () => {
    const result = await explore({ question: "needle" }, {
      rgSearch: async () => [{ path: "router.ts", line: 1, text: "needle" }],
      readFile: async () => ready("needle"),
    });
    const withoutGraph = formatExploreOutput(result);
    const withGraph = formatExploreOutput({
      ...result,
      relations: {
        status: "ready",
        files: [{
          path: "router.ts",
          documentRevision: result.snippets[0]!.revision,
          stale: false,
          incomplete: false,
          imports: [{ specifier: "./protocol", line: 1 }],
          connections: [{ callee: "register", literal: "explore.search", line: 4 }],
          associations: [{ callee: "log", literal: "explore.search", line: 5 }],
        }],
      },
    });
    expect(withoutGraph.visibleText).not.toContain("Relations");
    expect(withGraph.visibleText).toContain("router.ts imports ./protocol (L1)");
    expect(withGraph.visibleText).toContain("router.ts connects register(\"explore.search\") (L4)");
    expect(withGraph.visibleText).toContain("router.ts associates log(\"explore.search\") (L5) [candidate]");
    expect(withGraph.storedBody).toContain("same-string candidates");
    const tight = formatExploreOutput({
      ...result,
      relations: {
        status: "ready",
        files: [{
          path: "router.ts",
          documentRevision: result.snippets[0]!.revision,
          stale: false,
          incomplete: false,
          imports: [{ specifier: "./protocol", line: 1 }],
          connections: [],
          associations: [],
        }],
      },
    }, { byteBudget: Buffer.byteLength(withoutGraph.visibleText, "utf8") });
    expect(tight.visibleText).not.toContain("imports ./protocol");
    expect(Buffer.byteLength(tight.visibleText, "utf8")).toBeLessThanOrEqual(Buffer.byteLength(withoutGraph.visibleText, "utf8"));
  });

  it("drops relation line numbers when the graph revision is not the excerpt revision", async () => {
    const result = await explore({ question: "needle" }, {
      rgSearch: async () => [{ path: "router.ts", line: 1, text: "needle" }],
      readFile: async () => ready("needle"),
    });
    const formatted = formatExploreOutput({
      ...result,
      relations: {
        status: "ready",
        files: [{
          path: "router.ts",
          documentRevision: "disk-older",
          stale: true,
          incomplete: false,
          imports: [],
          connections: [{ callee: "register", literal: "gone.handler", line: 3 }],
          associations: [],
        }],
      },
    });
    expect(formatted.visibleText).toContain("stale @disk-older");
    expect(formatted.visibleText).toContain("connects register(\"gone.handler\")");
    expect(formatted.visibleText).not.toContain("(L3)");
  });

  it("reports a graph that could not answer, and keeps issues ahead of relations in the budget", async () => {
    const result = await explore({ question: "needle" }, {
      rgSearch: async () => [
        { path: "router.ts", line: 1, text: "needle" },
        { path: "broken.ts", line: 1, text: "needle" },
      ],
      readFile: async (path) => (path === "broken.ts"
        ? { status: "failed", message: "disk read failed" }
        : ready("needle")),
    });
    const unavailable = formatExploreOutput({ ...result, relations: { status: "unavailable", files: [] } });
    expect(unavailable.visibleText).toContain("Relations unavailable");

    const issueLine = result.issues[0]!;
    const manyEdges = Array.from({ length: 40 }, (_, index) => ({
      callee: "register", literal: `handler-${index}`, line: index + 1,
    }));
    const crowded = formatExploreOutput({
      ...result,
      relations: {
        status: "ready",
        files: [{
          path: "router.ts",
          documentRevision: result.snippets[0]!.revision,
          stale: false,
          incomplete: false,
          imports: [],
          connections: manyEdges,
          associations: [],
        }],
      },
    });
    expect(crowded.visibleText).toContain(issueLine.path);
    expect(crowded.visibleText).toContain("more edge(s) omitted");
    expect(crowded.visibleText.split("\n").filter((line) => line.includes("connects register")).length).toBe(12);
  });
});

const structureSource = (outline: StructureOutlineResult): Pick<StructureSource, "outline" | "classifyHits"> => ({
  outline: async (request) => ({ ...outline, revision: outline.status === "stale" ? outline.revision : request.revision }),
  classifyHits: async (request) => ({ status: "unsupported", provider: outline.provider, revision: request.revision, hits: [] }),
});

describe("explore structure slices", () => {
  it("uses a small function in full when the outline is ready", async () => {
    const content = "export function needle() {\n  return 1;\n}\n";
    const result = await explore({ question: "needle" }, {
      rgSearch: async () => [{ path: "small.ts", line: 1, text: "export function needle() {" }],
      readFile: async () => ready(content),
      structure: structureSource({
        status: "ready",
        provider: "lsp",
        revision: "rev-1",
        symbols: [{
          name: "needle",
          kind: "function",
          range: { startLine: 1, endLine: 3 },
          signature: { startLine: 1, endLine: 1 },
        }],
      }),
    });
    expect(result.snippets[0]).toMatchObject({
      path: "small.ts",
      startLine: 1,
      endLine: 3,
      text: "export function needle() {\n  return 1;\n}",
      unit: { name: "needle", kind: "function", startLine: 1, endLine: 3 },
      structure: { provider: "lsp", status: "ready" },
    });
    expect(result.details.structure?.files).toEqual([{ path: "small.ts", provider: "lsp", status: "ready" }]);
  });

  it("keeps signature, hit block, omission markers, and a full-unit read entry for a large function", async () => {
    const body = Array.from({ length: 48 }, (_, index) => index === 23 ? "  const needle = 1;" : `  const pad${index} = ${index};`);
    const content = ["export function largeTarget() {", ...body, "}"].join("\n");
    const hitLine = 25;
    const result = await explore({ question: "needle" }, {
      rgSearch: async () => [{ path: "large.ts", line: hitLine, text: "  const needle = 1;" }],
      readFile: async () => ready(content),
      structure: structureSource({
        status: "ready",
        provider: "lsp",
        revision: "rev-1",
        symbols: [{
          name: "largeTarget",
          kind: "function",
          range: { startLine: 1, endLine: 50 },
          signature: { startLine: 1, endLine: 1 },
        }],
      }),
    });
    const snippet = result.snippets[0];
    expect(snippet?.structure).toEqual({ provider: "lsp", status: "ready" });
    expect(snippet?.unit).toMatchObject({ name: "largeTarget", kind: "function", startLine: 1, endLine: 50 });
    expect(snippet?.unit?.omitted?.length).toBeGreaterThan(0);
    expect(snippet?.text.startsWith("export function largeTarget() {")).toBe(true);
    expect(snippet?.text).toContain("const needle = 1;");
    expect(snippet?.text).toContain("read large.ts:1-50");
    expect(snippet?.text).toMatch(/… omitted large\.ts:\d+-\d+/);
    expect(snippet?.endLine).toBeLessThan(50);
    const packed = formatExploreOutput(result);
    expect(packed.visibleText).toMatch(/unit largeTarget \(function\) large\.ts:1-50/);
    expect(packed.visibleText).toMatch(/structure lsp\/ready/);
  });

  it("falls back to a ±3 window and reports the source status when structure is unavailable", async () => {
    const content = Array.from({ length: 10 }, (_, index) => index === 6 ? "needle" : `line ${index + 1}`).join("\n");
    const result = await explore({ question: "needle" }, {
      rgSearch: async () => [{ path: "a.ts", line: 7, text: "needle" }],
      readFile: async () => ready(content),
      structure: structureSource({
        status: "unavailable",
        provider: "lsp",
        revision: "rev-1",
        symbols: [],
        message: "Language server is not ready for document symbols.",
      }),
    });
    expect(result.snippets[0]).toMatchObject({
      path: "a.ts",
      startLine: 4,
      endLine: 10,
      text: "line 4\nline 5\nline 6\nneedle\nline 8\nline 9\nline 10",
      structure: { provider: "lsp", status: "unavailable" },
    });
    expect(result.snippets[0]?.unit).toBeUndefined();
    expect(result.details.structure?.files[0]?.status).toBe("unavailable");
  });

  it("does not slice with a stale outline", async () => {
    const content = Array.from({ length: 10 }, (_, index) => index === 6 ? "needle" : `line ${index + 1}`).join("\n");
    const result = await explore({ question: "needle" }, {
      rgSearch: async () => [{ path: "a.ts", line: 7, text: "needle" }],
      readFile: async () => ready(content, "rev-new"),
      structure: {
        outline: async () => ({
          status: "stale",
          provider: "lsp",
          revision: "rev-old",
          symbols: [{
            name: "oldNeedle",
            kind: "function",
            range: { startLine: 1, endLine: 10 },
            signature: { startLine: 1, endLine: 1 },
          }],
        }),
        classifyHits: async () => ({ status: "unsupported", provider: "lsp", revision: "rev-old", hits: [] }),
      },
    });
    expect(result.snippets[0]).toMatchObject({
      startLine: 4,
      endLine: 10,
      structure: { provider: "lsp", status: "stale" },
    });
    expect(result.snippets[0]?.unit).toBeUndefined();
    expect(result.snippets[0]?.text).toContain("needle");
    expect(result.snippets[0]?.text).not.toContain("omitted");
    expect(result.details.structure?.files[0]).toEqual({ path: "a.ts", provider: "lsp", status: "stale" });
  });

  it("ranks a declaration-name hit ahead of the same token in a comment", async () => {
    const result = await explore({ question: "needle", limit: 2 }, {
      rgSearch: async () => [
        { path: "name.ts", line: 1, text: "export function needle() {" },
        { path: "comment.ts", line: 1, text: "// needle" },
      ],
      readFile: async (path) => ready(path === "name.ts" ? "export function needle() {\n  return 1;\n}" : "// needle\nexport function other() {\n  return 2;\n}"),
      structure: {
        outline: async (request) => ({
          status: "ready",
          provider: "tree-sitter",
          revision: request.revision,
          symbols: request.path === "name.ts"
            ? [{ name: "needle", kind: "function", range: { startLine: 1, endLine: 3 }, signature: { startLine: 1, endLine: 1 } }]
            : [{ name: "other", kind: "function", range: { startLine: 2, endLine: 4 }, signature: { startLine: 2, endLine: 2 } }],
        }),
        classifyHits: async (request) => ({
          status: "ready",
          provider: "tree-sitter",
          revision: request.revision,
          hits: request.lines.map((line) => ({
            line,
            class: request.path === "name.ts" ? "name" as const : "comment" as const,
          })),
        }),
      },
    });
    expect(result.snippets.map((snippet) => snippet.path)).toEqual(["name.ts", "comment.ts"]);
  });

  it("does not classify unread candidates", async () => {
    const classified: string[] = [];
    const hits = Array.from({ length: 8 }, (_, index) => ({
      path: `file-${index}.ts`,
      line: 1,
      text: "export function needle() {",
    }));
    const result = await explore({ question: "needle", limit: 1 }, {
      rgSearch: async () => hits,
      readFile: async () => ready("export function needle() {\n  return 1;\n}"),
      structure: {
        outline: async (request) => ({
          status: "ready",
          provider: "tree-sitter",
          revision: request.revision,
          symbols: [{ name: "needle", kind: "function", range: { startLine: 1, endLine: 3 }, signature: { startLine: 1, endLine: 1 } }],
        }),
        classifyHits: async (request) => {
          classified.push(request.path);
          return { status: "ready", provider: "tree-sitter", revision: request.revision, hits: request.lines.map((line) => ({ line, class: "name" as const })) };
        },
      },
    });
    expect(classified.length).toBeGreaterThan(0);
    expect(classified).not.toContain("file-7.ts");
    expect(result.notRequested.paths).toContain("file-7.ts");
  });

  it("keeps anchor-first complementary packing when structure slices are present", async () => {
    const result = await explore({ question: "token", anchors: ["keyHit"], limit: 2 }, {
      rgSearch: async (pattern) => pattern === "keyHit"
        ? [{ path: "second.ts", line: 1, text: "keyHit" }]
        : [1, 8, 15, 22, 29].map((line) => ({ path: "first.ts", line, text: `token ${line}` })),
      readFile: async (path) => ready(
        path === "second.ts"
          ? "keyHit"
          : Array.from({ length: 32 }, (_, index) => [1, 8, 15, 22, 29].includes(index + 1) ? `token ${index + 1}` : `pad ${index + 1}`).join("\n"),
      ),
      structure: structureSource({
        status: "unavailable",
        provider: "lsp",
        revision: "rev-1",
        symbols: [],
      }),
    });
    expect(result.snippets.map((snippet) => snippet.path).sort()).toEqual(["first.ts", "second.ts"]);
    expect(result.snippets[0]?.path).toBe("second.ts");
  });

  it("keeps a value-binding hit inside its enclosing function, not a one-line unit", async () => {
    const body = Array.from({ length: 47 }, (_, index) => {
      if (index === 44) return "  const needle = 1;";
      if (index === 45) return "  handle(needle);";
      return `  const pad${index} = ${index};`;
    });
    const content = ["export function big() {", ...body, "}"].join("\n");
    const lines = content.split("\n");
    const constLine = lines.findIndex((line) => line.includes("const needle")) + 1;
    const callLine = lines.findIndex((line) => line.includes("handle(needle)")) + 1;
    const structure = createStructureSource([parsingProvider()]);
    const run = (line: number, text: string) => explore({ question: "needle" }, {
      rgSearch: async () => [{ path: "big.ts", line, text }],
      readFile: async () => ready(content),
      structure,
    });

    const onConst = await run(constLine, "  const needle = 1;");
    expect(onConst.snippets[0]?.unit).toMatchObject({ name: "big", kind: "function", startLine: 1, endLine: lines.length });
    expect(onConst.snippets[0]?.text.startsWith("export function big() {")).toBe(true);
    expect(onConst.snippets[0]?.text).toContain("const needle = 1;");
    expect(onConst.snippets[0]?.text).toMatch(/read big\.ts:1-\d+/);
    expect(onConst.snippets[0]?.text.split("\n").length).toBeGreaterThan(3);

    const onCall = await run(callLine, "  handle(needle);");
    expect(onCall.snippets[0]?.unit).toMatchObject({ name: "big", kind: "function" });
    expect(onCall.snippets[0]?.text.startsWith("export function big() {")).toBe(true);
    expect(onCall.snippets[0]?.text).toContain("handle(needle);");

    const without = await explore({ question: "needle" }, {
      rgSearch: async () => [{ path: "big.ts", line: constLine, text: "  const needle = 1;" }],
      readFile: async () => ready(content),
    });
    expect(without.snippets[0]?.unit).toBeUndefined();
    expect(without.snippets[0]?.startLine).toBe(constLine - 3);
    expect(without.snippets[0]?.endLine).toBe(constLine + 3);
    expect(onConst.snippets[0]!.text.length).toBeGreaterThan(without.snippets[0]!.text.length);
  });

  it("keeps a definition binding as its own explore unit", async () => {
    const content = [
      "export function wrap() {",
      "  const foo = () => {",
      "    return needle;",
      "  };",
      "  return foo;",
      "}",
    ].join("\n");
    const result = await explore({ question: "needle" }, {
      rgSearch: async () => [{ path: "bind.ts", line: 3, text: "    return needle;" }],
      readFile: async () => ready(content),
      structure: createStructureSource([parsingProvider()]),
    });
    expect(result.snippets[0]?.unit).toMatchObject({ name: "foo", kind: "function", startLine: 2, endLine: 4 });
    expect(result.snippets[0]?.text).toContain("const foo = () => {");
    expect(result.snippets[0]?.text).toContain("return needle;");
  });

  it("slices from tree-sitter when the language-server provider is cold", async () => {
    const unavailableLsp: StructureProvider = {
      id: "lsp",
      capabilities: () => ({ outline: true, classifyHits: false, literalCalls: false, imports: false }),
      outline: async (request) => ({
        status: "unavailable",
        provider: "lsp",
        revision: request.revision,
        symbols: [],
        message: "Language server is still starting.",
      }),
      classifyHits: async (request) => ({ status: "unsupported", provider: "lsp", revision: request.revision, hits: [] }),
      literalCalls: async (request) => ({ status: "unsupported", provider: "lsp", revision: request.revision, calls: [] }),
      imports: async (request) => ({ status: "unsupported", provider: "lsp", revision: request.revision, imports: [] }),
    };
    const content = [
      "export function decoy() {",
      "  return 0;",
      "}",
      "export function needle() {",
      "  return 1;",
      "}",
    ].join("\n");
    const result = await explore({ question: "needle" }, {
      rgSearch: async () => [{ path: "cold.ts", line: 4, text: "export function needle() {" }],
      readFile: async () => ready(content),
      structure: createStructureSource([parsingProvider(), unavailableLsp]),
    });
    expect(result.snippets[0]).toMatchObject({
      path: "cold.ts",
      startLine: 4,
      endLine: 6,
      text: "export function needle() {\n  return 1;\n}",
      unit: { name: "needle", kind: "function", startLine: 4, endLine: 6 },
      structure: { provider: "tree-sitter", status: "ready" },
    });
    expect(result.details.structure?.files).toEqual([{ path: "cold.ts", provider: "tree-sitter", status: "ready" }]);
  });

  it("falls back when tree-sitter wasm is missing and does not fail the tool", async () => {
    const missing = createTreeSitterStructureProvider({
      runtimeFromUrl: pathToFileURL(join(mkdtempSync(join(tmpdir(), "piarium-missing-structure-")), "index.js")).href,
    });
    const content = Array.from({ length: 10 }, (_, index) => index === 6 ? "needle" : `line ${index + 1}`).join("\n");
    const result = await explore({ question: "needle" }, {
      rgSearch: async () => [{ path: "a.ts", line: 7, text: "needle" }],
      readFile: async () => ready(content),
      structure: createStructureSource([missing]),
    });
    expect(result.snippets[0]).toMatchObject({
      startLine: 4,
      endLine: 10,
      structure: { provider: "tree-sitter", status: "unavailable" },
    });
    expect(result.snippets[0]?.unit).toBeUndefined();
  });

  it("slices a JavaScript hit to its function and a JSX hit to its component", async () => {
    const js = [
      "function decoy() { return 0; }",
      "function boot() {",
      "  router.register(\"explore.search\");",
      "  return 1;",
      "}",
    ].join("\n");
    const jsx = [
      "export function decoy() { return null; }",
      "export function Badge() {",
      "  return <span>needle</span>;",
      "}",
    ].join("\n");
    const structure = createStructureSource([parsingProvider()]);
    const jsResult = await explore({ question: "explore.search" }, {
      rgSearch: async () => [{ path: "boot.js", line: 3, text: "  router.register(\"explore.search\");" }],
      readFile: async () => ready(js),
      structure,
    });
    expect(jsResult.snippets[0]).toMatchObject({
      path: "boot.js",
      unit: { name: "boot", kind: "function" },
      structure: { provider: "tree-sitter", status: "ready" },
    });
    expect(jsResult.snippets[0]?.text).toContain("router.register");
    const jsxResult = await explore({ question: "needle" }, {
      rgSearch: async () => [{ path: "Badge.jsx", line: 3, text: "  return <span>needle</span>;" }],
      readFile: async () => ready(jsx),
      structure,
    });
    expect(jsxResult.snippets[0]).toMatchObject({
      path: "Badge.jsx",
      unit: { name: "Badge", kind: "function" },
    });
  });

  it("slices a large JSON hit to the enclosing object instead of a ±3 window", async () => {
    const lines = [
      "{",
      ...Array.from({ length: 40 }, (_, index) => `  "pad${index}": ${index},`),
      "  \"config\": {",
      "    \"enabled\": true,",
      "    \"needle\": \"hit\"",
      "  }",
      "}",
    ];
    const content = lines.join("\n");
    const hitLine = lines.findIndex((line) => line.includes("needle")) + 1;
    const result = await explore({ question: "needle" }, {
      rgSearch: async () => [{ path: "big.json", line: hitLine, text: "    \"needle\": \"hit\"" }],
      readFile: async () => ready(content),
      structure: createStructureSource([parsingProvider()]),
    });
    expect(result.snippets[0]?.unit).toMatchObject({ name: "config" });
    expect(result.snippets[0]?.text).toContain("\"needle\": \"hit\"");
    expect(result.snippets[0]?.text).not.toContain("\"pad0\"");
    expect((result.snippets[0]?.endLine ?? 0) - (result.snippets[0]?.startLine ?? 0)).toBeLessThan(8);
  });
});
