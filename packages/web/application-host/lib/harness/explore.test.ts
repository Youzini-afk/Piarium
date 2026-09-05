import { describe, expect, it, vi } from "vitest";
import { buildRgPatterns, explore, extractIdentifiers, extractQuotedLiterals, type ExploreDeps } from "./explore.js";
import type { ExploreFileSnapshot } from "./explore-file-reader.js";

const ready = (content: string, revision = "rev-1"): ExploreFileSnapshot => ({ status: "ready", content, revision, source: "disk" });

describe("explore query terms", () => {
  it("preserves Unicode, combining marks, single-character and dollar identifiers", () => {
    const terms = extractIdentifiers("where is x $value 计算值 e\u0301 myFunction snake_case");
    expect(terms).toEqual(expect.arrayContaining(["x", "$value", "计算值", "e\u0301", "myFunction", "Function", "snake_case", "snake", "case"]));
    expect(terms).not.toContain("where");
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
      revision: "rev-1", source: "disk", why: "matched 1 query term(s)",
    }]);
    expect(result.partial).toBe(false);
    expect(result.issues).toEqual([]);
  });

  it("never fabricates a range when the document is missing", async () => {
    const result = await explore({ question: "needle" }, {
      rgSearch: async () => [{ path: "gone.ts", line: 10, text: "needle" }],
      readFile: async () => ({ status: "unavailable", message: "Document is missing." }),
    });
    expect(result.snippets).toEqual([]);
    expect(result.issues).toEqual([{ path: "gone.ts", status: "unavailable", message: "Document is missing." }]);
    expect(result.partial).toBe(true);
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
    expect(result.snippets[0]?.why).toBe("matched 2 query term(s)");
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
});
