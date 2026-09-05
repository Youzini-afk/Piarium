import { describe, it, expect } from "vitest";
import {
  extractIdentifiers,
  extractQuotedLiterals,
  expandWithSynonyms,
  buildRgPatterns,
  rankSnippets,
  explore,
  type ExploreDeps,
  type RgHit,
  type ExploreSnippet,
} from "./explore.js";

describe("extractIdentifiers", () => {
  it("extracts identifiers ≥ 3 chars", () => {
    const ids = extractIdentifiers("how does authentication work");
    expect(ids).toContain("how");
    expect(ids).toContain("does");
    expect(ids).toContain("authentication");
    expect(ids).toContain("work");
  });

  it("splits camelCase", () => {
    const ids = extractIdentifiers("how does myFunction work");
    expect(ids).toContain("myFunction");
    expect(ids).toContain("Function"); // "my" is 2 chars, filtered out
  });

  it("splits snake_case", () => {
    const ids = extractIdentifiers("how does my_func work");
    expect(ids).toContain("my_func");
    expect(ids).toContain("func"); // "my" is 2 chars, filtered out
  });

  it("filters short words", () => {
    const ids = extractIdentifiers("ab cd ef");
    expect(ids).toHaveLength(0);
  });
});

describe("extractQuotedLiterals", () => {
  it("extracts double-quoted strings", () => {
    expect(extractQuotedLiterals('find "error message"')).toEqual(["error message"]);
  });

  it("extracts single-quoted strings", () => {
    expect(extractQuotedLiterals("find 'error message'")).toEqual(["error message"]);
  });

  it("returns empty when no quotes", () => {
    expect(extractQuotedLiterals("no quotes here")).toEqual([]);
  });
});

describe("expandWithSynonyms", () => {
  it("expands config with synonyms", () => {
    const result = expandWithSynonyms(["config"]);
    expect(result).toContain("config");
    expect(result).toContain("settings");
    expect(result).toContain("configuration");
  });

  it("does not expand words without synonyms", () => {
    const result = expandWithSynonyms(["random"]);
    expect(result).toEqual(["random"]);
  });
});

describe("buildRgPatterns", () => {
  it("creates patterns from identifiers and literals", () => {
    const patterns = buildRgPatterns(["auth", "login"], ["error"], []);
    expect(patterns).toHaveLength(3);
    expect(patterns[0]?.fixedStrings).toBe(true); // literal first
    expect(patterns[1]?.pattern).toContain("auth");
    expect(patterns[2]?.pattern).toContain("login");
  });

  it("limits to 12 patterns", () => {
    const ids = Array.from({ length: 20 }, (_, i) => `id${i}`);
    const patterns = buildRgPatterns(ids, [], []);
    expect(patterns.length).toBeLessThanOrEqual(12);
  });

  it("includes symbol candidates", () => {
    const patterns = buildRgPatterns(["test"], [], ["MyClass", "myFunc"]);
    const symPatterns = patterns.filter((p) => p.pattern.includes("MyClass") || p.pattern.includes("myFunc"));
    expect(symPatterns.length).toBeGreaterThan(0);
  });
});

describe("rankSnippets", () => {
  it("ranks by combined score", () => {
    const snippets: ExploreSnippet[] = [
      { path: "src/a.ts", startLine: 1, endLine: 5, text: "a", why: "" },
      { path: "src/b.ts", startLine: 1, endLine: 5, text: "b", why: "" },
    ];
    const hits = new Map<string, RgHit[]>();
    hits.set("src/a.ts", [{ path: "src/a.ts", line: 1, text: "match" }]);
    hits.set("src/b.ts", [{ path: "src/b.ts", line: 1, text: "match" }, { path: "src/b.ts", line: 2, text: "match2" }]);

    const deps: ExploreDeps = {
      rgSearch: async () => [],
      searchSymbols: async () => [],
    };

    const ranked = rankSnippets(snippets, hits, deps, false);
    // b.ts has more hits → higher hitDensity
    expect(ranked[0]?.snippet.path).toBe("src/b.ts");
  });
});

describe("explore (pure algorithm mode)", () => {
  it("returns snippets without LLM", async () => {
    const deps: ExploreDeps = {
      rgSearch: async (pattern) => [
        { path: "src/auth.ts", line: 10, text: `function ${pattern}` },
      ],
      searchSymbols: async () => [],
    };

    const result = await explore({ question: "how does auth work" }, deps);
    expect(result.usedLlm).toBe(false);
    expect(result.snippets.length).toBeGreaterThan(0);
    expect(result.searched.patterns).toBeGreaterThan(0);
    expect(result.searched.ms).toBeGreaterThanOrEqual(0);
  });

  it("zero model calls in pure algorithm mode", async () => {
    let llmCalled = false;
    const deps: ExploreDeps = {
      rgSearch: async () => [],
      searchSymbols: async () => [],
      llmExpand: async () => { llmCalled = true; return { patterns: [], symbols: [] }; },
    };

    // Don't pass llmExpand to test pure algorithm
    const result = await explore({ question: "test" }, {
      rgSearch: deps.rgSearch,
      searchSymbols: deps.searchSymbols,
    });
    expect(llmCalled).toBe(false);
    expect(result.usedLlm).toBe(false);
  });

  it("uses LLM when provided", async () => {
    const deps: ExploreDeps = {
      rgSearch: async () => [],
      searchSymbols: async () => [],
      llmExpand: async () => ({ patterns: ["custom"], symbols: ["MyClass"] }),
    };

    const result = await explore({ question: "test" }, deps);
    expect(result.usedLlm).toBe(true);
  });

  it("respects limit", async () => {
    const deps: ExploreDeps = {
      rgSearch: async () => Array.from({ length: 50 }, (_, i) => ({
        path: `file${i}.ts`, line: 1, text: "match",
      })),
      searchSymbols: async () => [],
    };

    const result = await explore({ question: "test", limit: 5 }, deps);
    expect(result.snippets.length).toBeLessThanOrEqual(5);
  });
});

describe("createExploreSearchService", () => {
  it("forwards workspaceScope and signal, stores formatted output into outputStore, and returns handle", async () => {
    const { createExploreSearchService } = await import("./harness-services.js");
    const { createOutputStore } = await import("./output-store.js");
    const outputStore = createOutputStore();

    let capturedCtx: any = null;
    const mockSearchService = {
      search: async (_params: any, searchCtx: any) => {
        capturedCtx = searchCtx;
        return {
          status: "ready" as const,
          files: [
            {
              path: "src/auth/login.ts",
              hits: [{ line: 10, text: "function loginUser() {" }],
            },
          ],
          totalHits: 1,
          totalFiles: 1,
          searchedFiles: 1,
          partial: false,
        };
      },
    };

    const service = createExploreSearchService({
      searchService: mockSearchService as any,
      outputStore,
    } as any);

    const abortController = new AbortController();
    const result = await service.handle({
      question: "how does login work",
    }, {
      sessionId: "session-explore-test",
      workspaceId: "ws-1",
      workspaceScope: ["src/auth"],
      signal: abortController.signal,
    } as any);

    expect(capturedCtx).not.toBeNull();
    expect(capturedCtx.workspaceScope).toEqual(["src/auth"]);
    expect(capturedCtx.signal).toBe(abortController.signal);

    expect(result.snippets.length).toBeGreaterThan(0);
    expect(result.handle).toMatch(/^out_[0-9a-f]{32}_[0-9a-z]+_[0-9a-f]{32}$/);
    expect(result.text).toContain("Found 1 snippet(s)");

    // Verify handle can be read from outputStore
    const readResult = outputStore.read("session-explore-test", result.handle!);
    expect(readResult.status).toBe("ready");
    if (readResult.status === "ready") {
      expect(readResult.slice.text).toBe(result.text);
    }
  });

  it("throws HarnessServiceError with unavailable when search service returns unavailable", async () => {
    const { createExploreSearchService } = await import("./harness-services.js");
    const { createOutputStore } = await import("./output-store.js");
    const { HarnessServiceError } = await import("./service-error.js");

    const mockSearchService = {
      search: async () => ({
        status: "unavailable" as const,
        files: [],
        totalHits: 0,
        totalFiles: 0,
        searchedFiles: 0,
        partial: false,
      }),
    };

    const service = createExploreSearchService({
      searchService: mockSearchService as any,
      outputStore: createOutputStore(),
    } as any);

    await expect(
      service.handle({ question: "any query" }, {
        sessionId: "session-err",
        workspaceId: "ws-1",
        signal: new AbortController().signal,
      } as any)
    ).rejects.toThrow(HarnessServiceError);
  });

  it("extracts real multi-line slices for snippet ranges when readFile is provided", async () => {
    const fileContent = [
      "line 1: header",
      "line 2: imports",
      "line 3: const x = 1;",
      "line 4: // comment",
      "line 5: function doWork() {",
      "line 6:   console.log('working');",
      "line 7:   needle",
      "line 8:   console.log('done');",
      "line 9: }",
      "line 10: export default doWork;",
    ].join("\n");

    const result = await explore({
      question: "needle",
    }, {
      rgSearch: async () => [{ path: "src/worker.ts", line: 7, text: "  needle" }],
      searchSymbols: async () => [],
      readFile: async (p) => p === "src/worker.ts" ? fileContent : null,
    });

    expect(result.snippets.length).toBe(1);
    const snippet = result.snippets[0]!;
    expect(snippet.startLine).toBe(4); // 7 - 3 = 4
    expect(snippet.endLine).toBe(10);  // 7 + 3 = 10
    // Real text contains all lines 4 to 10!
    expect(snippet.text.split("\n").length).toBe(7);
    expect(snippet.text).toContain("line 4: // comment");
    expect(snippet.text).toContain("needle");
    expect(snippet.text).toContain("line 10: export default doWork;");
  });
});
