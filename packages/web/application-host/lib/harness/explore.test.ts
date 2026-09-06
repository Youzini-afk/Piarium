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

const ready = (content: string, revision = "rev-1"): ExploreFileSnapshot => ({ status: "ready", content, revision, source: "disk" });

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
});
