import { describe, expect, it } from "vitest";
import { locateIdentifierLines, locateLiteralLines, pathInRoots, rankReverseImporters } from "./explore-graph.js";

describe("explore graph helpers", () => {
  it("locates identifier names without treating graph line numbers as current", () => {
    const lines = ["const x = 1;", "export function explore() {}", "explore();"];
    expect(locateIdentifierLines(lines, "explore")).toEqual([2, 3]);
    expect(locateIdentifierLines(lines, "expl")).toEqual([]);
  });

  it("locates connection literals by current text inclusion", () => {
    expect(locateLiteralLines(["router.register(\"explore.search\");"], "explore.search")).toEqual([1]);
  });

  it("prefers same-directory reverse importers and fewer parent hops", () => {
    const ranked = rankReverseImporters("lib/core.ts", [
      { path: "app/boot.ts", specifier: "../lib/core.js" },
      { path: "lib/other.ts", specifier: "./core.js" },
      { path: "pkg/deep/x.ts", specifier: "../../../lib/core.js" },
    ], 2);
    expect(ranked.map((item) => item.path)).toEqual(["lib/other.ts", "app/boot.ts"]);
  });

  it("respects search roots for graph paths", () => {
    expect(pathInRoots("src/a.ts", ["src"])).toBe(true);
    expect(pathInRoots("lib/a.ts", ["src"])).toBe(false);
  });
});
