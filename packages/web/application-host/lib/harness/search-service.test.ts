import { describe, expect, it, vi } from "vitest";
import { createHarnessSearchService } from "./search-service.js";
import type { WorkspaceContentSearchResult, WorkspaceSearchHit } from "../search/content.js";
import type { AgentInputContext, HarnessActorContext } from "@piarium/protocol";

function makeHit(path: string, line: number, preview: string): WorkspaceSearchHit {
  return { resource: { resourceId: path, workspaceId: "ws-1" }, line, column: 1, preview };
}

const actor: HarnessActorContext = {
  authorityInstanceId: "authority-1",
  sessionId: "session-1",
  workerId: "worker-1",
  workerGeneration: 1,
  workspaceId: "ws-1",
  grantedCapabilities: ["read.search"],
};

const surface = (dirtyPaths: string[], ref = "snapshot-1"): AgentInputContext => ({
  source: "surface",
  workspaceId: "ws-1",
  dirtyPaths,
  snapshot: { status: "ready", ref },
});

const searchContext = (inputContext: AgentInputContext, workspaceScope?: readonly string[]) => ({
  actor,
  inputContext,
  ...(workspaceScope ? { workspaceScope } : {}),
  workspaceId: "ws-1",
  signal: new AbortController().signal,
});

describe("harness search service", () => {
  it("returns empty when search finds nothing", async () => {
    const search = vi.fn(async (): Promise<WorkspaceContentSearchResult> => ({ status: "empty", generation: 1 }));
    const service = createHarnessSearchService({
      search,
      resolveWorkspaceRoot: async () => "/workspace",
    });
    const result = await service.search(
      { pattern: "nonexistent" },
      { workspaceId: "ws-1", signal: new AbortController().signal },
    );
    expect(result.status).toBe("empty");
    expect(result.files).toEqual([]);
  });

  it("does not turn an empty surface pattern into a match-all regex", async () => {
    const search = vi.fn();
    const readFile = vi.fn();
    const service = createHarnessSearchService({ search, readFile, resolveWorkspaceRoot: async () => "/workspace" });

    const result = await service.search({ pattern: "   " }, searchContext(surface(["draft.ts"])));

    expect(result.status).toBe("empty");
    expect(search).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
  });

  it("rejects a surface context from another workspace before searching disk", async () => {
    const search = vi.fn();
    const service = createHarnessSearchService({ search, resolveWorkspaceRoot: async () => "/workspace" });
    const inputContext: AgentInputContext = {
      source: "surface",
      workspaceId: "other-workspace",
      dirtyPaths: ["outside.ts"],
      snapshot: { status: "ready", ref: "other" },
    };

    const result = await service.search({ pattern: "secret", path: "src" }, searchContext(inputContext));

    expect(result.status).toBe("unavailable");
    expect(search).not.toHaveBeenCalled();
  });

  it("returns unavailable when search fails", async () => {
    const search = vi.fn(async (): Promise<WorkspaceContentSearchResult> => ({ status: "failure", generation: 1, message: "rg not found" }));
    const service = createHarnessSearchService({
      search,
      resolveWorkspaceRoot: async () => "/workspace",
    });
    const result = await service.search(
      { pattern: "test" },
      { workspaceId: "ws-1", signal: new AbortController().signal },
    );
    expect(result.status).toBe("unavailable");
  });

  it("groups hits by file and sorts by line number", async () => {
    const hits: WorkspaceSearchHit[] = [
      makeHit("src/b.ts", 30, "line 30"),
      makeHit("src/a.ts", 10, "line 10"),
      makeHit("src/a.ts", 5, "line 5"),
      makeHit("src/b.ts", 15, "line 15"),
    ];
    const search = vi.fn(async (): Promise<WorkspaceContentSearchResult> => ({ status: "ready", generation: 1, hits }));
    const service = createHarnessSearchService({
      search,
      resolveWorkspaceRoot: async () => "/workspace",
    });
    const result = await service.search(
      { pattern: "line" },
      { workspaceId: "ws-1", signal: new AbortController().signal },
    );
    expect(result.status).toBe("ready");
    expect(result.totalHits).toBe(4);
    expect(result.totalFiles).toBe(2);
    // Check that hits within each file are sorted by line number
    for (const file of result.files) {
      for (let i = 1; i < file.hits.length; i++) {
        expect(file.hits[i]!.line).toBeGreaterThan(file.hits[i - 1]!.line);
      }
    }
  });

  it("applies limit and sets partial flag", async () => {
    const hits: WorkspaceSearchHit[] = [];
    for (let i = 0; i < 150; i++) {
      hits.push(makeHit(`file${i}.ts`, 1, `hit ${i}`));
    }
    const search = vi.fn(async (): Promise<WorkspaceContentSearchResult> => ({ status: "ready", generation: 1, hits }));
    const service = createHarnessSearchService({
      search,
      resolveWorkspaceRoot: async () => "/workspace",
    });
    const result = await service.search(
      { pattern: "hit", limit: 10 },
      { workspaceId: "ws-1", signal: new AbortController().signal },
    );
    expect(result.status).toBe("ready");
    expect(result.partial).toBe(true);
    expect(result.totalHits).toBe(150);
    // Limited files
    const totalHitsInFiles = result.files.reduce((sum, f) => sum + f.hits.length, 0);
    expect(totalHitsInFiles).toBeLessThanOrEqual(10);
  });

  it("returns unavailable when workspaceId is null", async () => {
    const search = vi.fn();
    const service = createHarnessSearchService({
      search,
      resolveWorkspaceRoot: async () => "/workspace",
    });
    const result = await service.search(
      { pattern: "test" },
      { workspaceId: null, signal: new AbortController().signal },
    );
    expect(result.status).toBe("unavailable");
    expect(search).not.toHaveBeenCalled();
  });

  it("sorts files deterministically (same input → same order)", async () => {
    const hits: WorkspaceSearchHit[] = [
      makeHit("src/z.ts", 1, "z"),
      makeHit("src/a.ts", 1, "a"),
      makeHit("src/m.ts", 1, "m"),
    ];
    const search = vi.fn(async (): Promise<WorkspaceContentSearchResult> => ({ status: "ready", generation: 1, hits }));
    const service = createHarnessSearchService({
      search,
      resolveWorkspaceRoot: async () => "/workspace",
    });
    const result1 = await service.search({ pattern: "test" }, { workspaceId: "ws-1", signal: new AbortController().signal });
    const result2 = await service.search({ pattern: "test" }, { workspaceId: "ws-1", signal: new AbortController().signal });
    expect(result1.files.map((f) => f.path)).toEqual(result2.files.map((f) => f.path));
  });

  it("replaces dirty disk hits with the fixed editor snapshot and keeps draft-only hits", async () => {
    const search = vi.fn(async (): Promise<WorkspaceContentSearchResult> => ({
      status: "ready",
      generation: 1,
      hits: [makeHit("draft.ts", 1, "old disk value")],
    }));
    const readFile = vi.fn(async (_actor, path: string) => {
      if (path !== "draft.ts") throw new Error(`unexpected read ${path}`);
      return { status: "ready" as const, content: "new draft value\r\nsecond\rthird", revision: "surface-draft:1", source: "surface-draft" as const };
    });
    const service = createHarnessSearchService({ search, readFile, resolveWorkspaceRoot: async () => "/workspace" });

    const result = await service.search({ pattern: "draft", limit: 10 }, searchContext(surface(["draft.ts"])));

    expect(result.status).toBe("ready");
    expect(result.totalHits).toBe(1);
    expect(result.files.flatMap((file) => file.hits.map((hit) => [file.path, hit.line, hit.text]))).toEqual([
      ["draft.ts", 1, "new draft value"],
    ]);
    expect(readFile).toHaveBeenCalledWith(actor, "draft.ts", expect.any(AbortSignal), surface(["draft.ts"]));
    expect(search).toHaveBeenCalledWith(expect.objectContaining({ query: "draft" }), expect.anything());
    expect((search.mock.calls as unknown as Array<[Record<string, unknown>]>)[0]?.[0]).toMatchObject({
      maxResults: 30,
      excludeResourceIds: ["draft.ts"],
    });
  });

  it("searches a written path on disk again instead of hiding it behind the older draft", async () => {
    const search = vi.fn(async (): Promise<WorkspaceContentSearchResult> => ({
      status: "ready",
      generation: 1,
      hits: [makeHit("draft.ts", 3, "value the agent just wrote")],
    }));
    const readFile = vi.fn();
    // The turn's fixed source no longer owns draft.ts: it was written since the
    // capture, so disk holds the newer text (D-088).
    const draftPaths = vi.fn(() => [] as readonly string[]);
    const service = createHarnessSearchService({
      search,
      readFile,
      draftPaths,
      resolveWorkspaceRoot: async () => "/workspace",
    });

    const result = await service.search({ pattern: "value" }, searchContext(surface(["draft.ts"])));

    expect(result).toMatchObject({ status: "ready", totalHits: 1 });
    expect(result.files[0]?.hits[0]?.text).toBe("value the agent just wrote");
    expect(readFile).not.toHaveBeenCalled();
    expect(draftPaths).toHaveBeenCalledWith(actor.sessionId, surface(["draft.ts"]));
    expect((search.mock.calls as unknown as Array<[Record<string, unknown>]>)[0]?.[0].excludeResourceIds).toBeUndefined();
  });

  it("matches draft lines with regex semantics and reports CRLF, LF, and CR line numbers", async () => {
    const search = vi.fn(async (): Promise<WorkspaceContentSearchResult> => ({ status: "empty", generation: 1 }));
    const readFile = vi.fn(async () => ({
      status: "ready" as const,
      content: "one\r\ntwo-2\nthree-3\rfour-4",
      revision: "surface-draft:1",
      source: "surface-draft" as const,
    }));
    const service = createHarnessSearchService({ search, readFile, resolveWorkspaceRoot: async () => "/workspace" });

    const result = await service.search({ pattern: "(two|four)-\\d" }, searchContext(surface(["draft.ts"])));

    expect(result).toMatchObject({ status: "ready", totalHits: 2, totalFiles: 1, partial: false });
    expect(result.files[0]?.hits).toEqual([
      { line: 2, text: "two-2", before: [], after: [] },
      { line: 4, text: "four-4", before: [], after: [] },
    ]);
  });

  it("uses literal and case-insensitive draft matching when requested", async () => {
    const search = vi.fn(async (): Promise<WorkspaceContentSearchResult> => ({ status: "empty", generation: 1 }));
    const readFile = vi.fn(async () => ({
      status: "ready" as const,
      content: "value [A-Z]\nVALUE a-z",
      revision: "surface-draft:1",
      source: "surface-draft" as const,
    }));
    const service = createHarnessSearchService({ search, readFile, resolveWorkspaceRoot: async () => "/workspace" });

    const result = await service.search(
      { pattern: "value [A-Z]", fixedStrings: true, ignoreCase: true },
      searchContext(surface(["draft.ts"])),
    );

    expect(result).toMatchObject({ status: "ready", totalHits: 1 });
    expect(result.files[0]?.hits[0]?.text).toBe("value [A-Z]");
  });

  it("does not leak a dirty path when its fixed snapshot is unavailable", async () => {
    const search = vi.fn(async (): Promise<WorkspaceContentSearchResult> => ({
      status: "ready",
      generation: 1,
      hits: [makeHit("draft.ts", 1, "private disk value")],
    }));
    const readFile = vi.fn(async () => ({ status: "unavailable" as const, message: "snapshot expired" }));
    const service = createHarnessSearchService({ search, readFile, resolveWorkspaceRoot: async () => "/workspace" });

    const result = await service.search({ pattern: "private" }, searchContext(surface(["draft.ts"])));

    expect(result).toMatchObject({ status: "unavailable", totalHits: 0, totalFiles: 0 });
    expect(search).not.toHaveBeenCalled();
  });

  it("reads and excludes only dirty paths inside both the actor scope and requested path", async () => {
    const search = vi.fn(async (): Promise<WorkspaceContentSearchResult> => ({
      status: "ready",
      generation: 1,
      hits: [
        makeHit("packages/app/src/inside.ts", 1, "disk inside"),
        makeHit("packages/app/test/outside-request.ts", 1, "disk outside request"),
        makeHit("packages/other/src/outside-scope.ts", 1, "disk outside scope"),
      ],
    }));
    const readFile = vi.fn(async (_actor, path: string) => ({
      status: "ready" as const,
      content: path === "packages/app/src/inside.ts" ? "draft inside" : "wrong dirty path",
      revision: "surface-draft:1",
      source: "surface-draft" as const,
    }));
    const service = createHarnessSearchService({ search, readFile, resolveWorkspaceRoot: async () => "/workspace" });
    const context = searchContext(
      surface([
        "packages/app/src/inside.ts",
        "packages/app/test/outside-request.ts",
        "packages/other/src/outside-scope.ts",
      ]),
      ["packages/app"],
    );

    const result = await service.search({ pattern: "inside", path: "packages/app/src" }, context);

    expect(result).toMatchObject({ status: "ready", totalHits: 1, totalFiles: 1 });
    expect(result.files[0]?.path).toBe("packages/app/src/inside.ts");
    expect(readFile).toHaveBeenCalledTimes(1);
    expect(readFile).toHaveBeenCalledWith(actor, "packages/app/src/inside.ts", expect.any(AbortSignal), context.inputContext);
    expect((search.mock.calls as unknown as Array<[Record<string, unknown>]>)[0]?.[0]).toMatchObject({ paths: ["packages/app/src"] });
  });

  it("applies include and exclude globs to both disk and draft hits", async () => {
    const search = vi.fn(async (): Promise<WorkspaceContentSearchResult> => ({
      status: "ready",
      generation: 1,
      hits: [
        makeHit("src/a.ts", 1, "match"),
        makeHit("src/a.test.ts", 1, "test match"),
        makeHit("src/a.js", 1, "js match"),
      ],
    }));
    const readFile = vi.fn(async (_actor, path: string) => ({
      status: "ready" as const,
      content: path === "src/a.ts" ? "match" : "test match",
      revision: "surface-draft:1",
      source: "surface-draft" as const,
    }));
    const service = createHarnessSearchService({ search, readFile, resolveWorkspaceRoot: async () => "/workspace" });

    const result = await service.search({
      pattern: "match",
      glob: ["!**/*.test.ts", "**/*.ts"],
    }, searchContext(surface(["src/a.ts", "src/a.test.ts"])));

    expect(result).toMatchObject({ status: "ready", totalHits: 1, totalFiles: 1 });
    expect(result.files[0]?.path).toBe("src/a.ts");
    expect(readFile).toHaveBeenCalledTimes(1);
    expect((search.mock.calls as unknown as Array<[Record<string, unknown>]>)[0]?.[0]).toMatchObject({
      glob: ["**/*.ts", "!**/*.test.ts"],
    });
  });

  it("returns real neighboring lines for content context in disk and draft files", async () => {
    const search = vi.fn(async (): Promise<WorkspaceContentSearchResult> => ({
      status: "ready",
      generation: 1,
      hits: [makeHit("disk.ts", 2, "disk match")],
    }));
    const readFile = vi.fn(async (_actor, path: string) => ({
      status: "ready" as const,
      content: path === "draft.ts" ? "draft before\ndraft match\ndraft after" : "disk before\ndisk match\ndisk after",
      revision: "surface-draft:1",
      source: path === "draft.ts" ? "surface-draft" as const : "disk" as const,
    }));
    const service = createHarnessSearchService({ search, readFile, resolveWorkspaceRoot: async () => "/workspace" });

    const result = await service.search({ pattern: "match", context: 1 }, searchContext(surface(["draft.ts"])));

    expect(result).toMatchObject({ status: "ready", totalHits: 2, totalFiles: 2 });
    const hitsByPath = new Map(result.files.map((file) => [file.path, file.hits[0]]));
    expect(hitsByPath.get("draft.ts")).toMatchObject({ before: ["draft before"], after: ["draft after"] });
    expect(hitsByPath.get("disk.ts")).toMatchObject({ before: ["disk before"], after: ["disk after"] });
  });

  it("computes context independently for multiple hits in one disk file", async () => {
    const search = vi.fn(async (): Promise<WorkspaceContentSearchResult> => ({
      status: "ready",
      generation: 1,
      hits: [makeHit("disk.ts", 2, "first match"), makeHit("disk.ts", 5, "second match")],
    }));
    const readFile = vi.fn(async () => ({
      status: "ready" as const,
      content: "before first\nfirst match\nafter first\nbefore second\nsecond match\nafter second",
      revision: "disk:1",
      source: "disk" as const,
    }));
    const service = createHarnessSearchService({ search, readFile, resolveWorkspaceRoot: async () => "/workspace" });

    const result = await service.search({ pattern: "match", context: 1 }, {
      actor,
      workspaceId: "ws-1",
      signal: new AbortController().signal,
    });

    expect(result.files[0]?.hits).toEqual([
      { line: 2, text: "first match", before: ["before first"], after: ["after first"] },
      { line: 5, text: "second match", before: ["before second"], after: ["after second"] },
    ]);
    expect(readFile).toHaveBeenCalledTimes(1);
  });

  it("does not attach neighboring lines from a newer disk revision", async () => {
    const search = vi.fn(async (): Promise<WorkspaceContentSearchResult> => ({
      status: "ready",
      generation: 1,
      hits: [makeHit("disk.ts", 2, "matched old revision")],
    }));
    const readFile = vi.fn(async () => ({
      status: "ready" as const,
      content: "new before\nchanged after search\nnew after",
      revision: "disk:2",
      source: "disk" as const,
    }));
    const service = createHarnessSearchService({ search, readFile, resolveWorkspaceRoot: async () => "/workspace" });

    const result = await service.search({ pattern: "matched", context: 1 }, {
      actor,
      workspaceId: "ws-1",
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({ status: "ready", partial: true });
    expect(result.files[0]?.hits[0]).toMatchObject({ before: [], after: [] });
  });

  it("merges all disk and draft hits before sorting and applying the limit", async () => {
    const search = vi.fn(async (): Promise<WorkspaceContentSearchResult> => ({
      status: "ready",
      generation: 1,
      hits: [makeHit("z-disk.ts", 1, "match")],
    }));
    const readFile = vi.fn(async () => ({
      status: "ready" as const,
      content: "match",
      revision: "surface-draft:1",
      source: "surface-draft" as const,
    }));
    const service = createHarnessSearchService({ search, readFile, resolveWorkspaceRoot: async () => "/workspace" });

    const result = await service.search({ pattern: "match", path: ".", limit: 1 }, searchContext(surface(["a-draft.ts"])));

    expect(result).toMatchObject({ status: "ready", totalHits: 2, totalFiles: 2, partial: true });
    expect(result.files).toHaveLength(1);
    expect(result.files[0]?.path).toBe("a-draft.ts");
    expect((search.mock.calls as unknown as Array<[Record<string, unknown>]>)[0]?.[0]).toMatchObject({
      maxResults: 3,
      excludeResourceIds: ["a-draft.ts"],
    });
  });

  it("keeps the disk over-fetch bounded while excluding dirty hits before the cap", async () => {
    const search = vi.fn(async (request: { maxResults?: number; excludeResourceIds?: string[] }): Promise<WorkspaceContentSearchResult> => ({
      status: "ready",
      generation: 1,
      // This fake backend intentionally returns the excluded hit too; the
      // production backend removes it before its maxResults counter.
      hits: [
        ...Array.from({ length: 12 }, (_, index) => makeHit("dirty.ts", index + 1, "old disk match")),
        ...Array.from({ length: request.maxResults ?? 0 }, (_, index) => makeHit(`disk-${index}.ts`, 1, "disk match")),
      ],
    }));
    const readFile = vi.fn(async () => ({
      status: "ready" as const,
      content: "draft match",
      revision: "surface-draft:1",
      source: "surface-draft" as const,
    }));
    const service = createHarnessSearchService({ search, readFile, resolveWorkspaceRoot: async () => "/workspace" });

    const result = await service.search({ pattern: "match", limit: 2 }, searchContext(surface(["dirty.ts"])));

    expect(result.status).toBe("ready");
    expect(result.files.flatMap((file) => file.hits).every((hit) => hit.text !== "old disk match")).toBe(true);
    expect(result.totalHits).toBe(7);
    expect((search.mock.calls as unknown as Array<[Record<string, unknown>]>)[0]?.[0]).toMatchObject({
      maxResults: 6,
      excludeResourceIds: ["dirty.ts"],
    });
  });

  it("preserves disk search behavior when no surface context is supplied", async () => {
    const search = vi.fn(async (): Promise<WorkspaceContentSearchResult> => ({
      status: "ready",
      generation: 1,
      hits: [makeHit("disk.ts", 1, "disk match")],
    }));
    const readFile = vi.fn();
    const service = createHarnessSearchService({ search, readFile, resolveWorkspaceRoot: async () => "/workspace" });

    const result = await service.search({ pattern: "match", limit: 2 }, {
      workspaceId: "ws-1",
      signal: new AbortController().signal,
    });

    expect(result.status).toBe("ready");
    expect(result.files[0]?.path).toBe("disk.ts");
    expect(readFile).not.toHaveBeenCalled();
    expect(search).toHaveBeenCalledWith({ query: "match", workspaceId: "ws-1", maxResults: 6 }, expect.anything());
  });

  it("propagates abort while reading a surface snapshot", async () => {
    const parent = new AbortController();
    const search = vi.fn(async (): Promise<WorkspaceContentSearchResult> => ({ status: "empty", generation: 1 }));
    const readFile = vi.fn((_actor, _path, signal: AbortSignal) => new Promise<never>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    const service = createHarnessSearchService({ search, readFile, resolveWorkspaceRoot: async () => "/workspace" });
    const pending = service.search({ pattern: "match" }, {
      ...searchContext(surface(["draft.ts"])),
      signal: parent.signal,
    });
    parent.abort();

    await expect(pending).resolves.toMatchObject({ status: "unavailable" });
    expect(search).not.toHaveBeenCalled();
  });

  it("returns only hits inside both the child scope and requested path", async () => {
    const hits = [
      makeHit("packages/web/src/a.ts", 1, "allowed"),
      makeHit("packages/web/test/a.test.ts", 1, "outside request"),
      makeHit("packages/ui/src/a.ts", 1, "outside child scope"),
      makeHit("packages/web/../ui/src/traversal.ts", 1, "scope-looking traversal"),
    ];
    let searchPaths: string[] | undefined;
    const service = createHarnessSearchService({
      search: async (request) => {
        searchPaths = request.paths;
        return { status: "ready", generation: 1, hits };
      },
      resolveWorkspaceRoot: async () => "/workspace",
    });
    const result = await service.search(
      { pattern: "a", path: "packages/web/src" },
      {
        workspaceId: "ws-1",
        workspaceScope: ["packages/web"],
        signal: new AbortController().signal,
      },
    );
    expect(result.status).toBe("ready");
    expect(result.files.map((file) => file.path)).toEqual(["packages/web/src/a.ts"]);
    expect(searchPaths).toEqual(["packages/web/src"]);
  });

  it("explore candidate mode keeps every matching file by breadth-first budget, including the last path", async () => {
    const files = Array.from({ length: 30 }, (_, index) => `dir${String(index).padStart(2, "0")}/file.ts`);
    const hits: WorkspaceSearchHit[] = files.flatMap((path) => (
      Array.from({ length: 12 }, (_, index) => makeHit(path, index + 1, `token ${index}`))
    ));
    const search = vi.fn(async (): Promise<WorkspaceContentSearchResult> => ({ status: "ready", generation: 1, hits }));
    const service = createHarnessSearchService({ search, resolveWorkspaceRoot: async () => "/workspace" });

    const exploreMode = await service.search({ pattern: "token" }, {
      workspaceId: "ws-1",
      signal: new AbortController().signal,
      candidateBudget: 200,
      hitsPerFile: 12,
    });
    expect(exploreMode.status).toBe("ready");
    expect(exploreMode.files).toHaveLength(30);
    expect(exploreMode.files.reduce((sum, file) => sum + file.hits.length, 0)).toBeLessThanOrEqual(200);
    expect(exploreMode.files.at(-1)?.path).toBe("dir29/file.ts");
    expect(exploreMode.filesDropped).toBe(0);
    expect(exploreMode.partial).toBe(true);
    expect(exploreMode.fileCoverage).toBe("complete");

    const grepMode = await service.search({ pattern: "token" }, {
      workspaceId: "ws-1",
      signal: new AbortController().signal,
    });
    expect(grepMode.files).toHaveLength(9);
    expect(grepMode.files[0]?.path).toBe("dir00/file.ts");
    expect(grepMode.files.at(-1)?.path).toBe("dir08/file.ts");
    expect(grepMode.files.at(-1)?.hits).toHaveLength(4);
    expect(grepMode.files.flatMap((file) => file.hits)).toHaveLength(100);
    expect(grepMode.partial).toBe(true);
    expect(grepMode.filesDropped).toBeUndefined();
    expect(grepMode.files.map((file) => file.path)).not.toContain("dir29/file.ts");
  });

  it("explore candidate mode reports filesDropped when matching files exceed the budget", async () => {
    const files = Array.from({ length: 5 }, (_, index) => `z${index}.ts`);
    const hits = files.map((path) => makeHit(path, 1, "token"));
    const service = createHarnessSearchService({
      search: async () => ({ status: "ready", generation: 1, hits }),
      resolveWorkspaceRoot: async () => "/workspace",
    });
    const result = await service.search({ pattern: "token" }, {
      workspaceId: "ws-1",
      signal: new AbortController().signal,
      candidateBudget: 3,
      hitsPerFile: 12,
    });
    expect(result.files.map((file) => file.path)).toEqual(["z0.ts", "z1.ts", "z2.ts"]);
    expect(result.files.every((file) => file.hits.length === 1)).toBe(true);
    expect(result.filesDropped).toBe(2);
    expect(result.partial).toBe(true);
    expect(result.fileCoverage).toBe("lower-bound");
    expect(result.totalFiles).toBe(5);
  });

  it("explore candidate mode keeps a second file after a flood of hits and does not use grep fileScore order", async () => {
    const hits: WorkspaceSearchHit[] = [
      ...Array.from({ length: 50 }, (_, index) => makeHit("flood.ts", index + 1, `token ${index}`)),
      makeHit("key.ts", 1, "uniqueAnchor"),
    ];
    const search = vi.fn(async (): Promise<WorkspaceContentSearchResult> => ({ status: "ready", generation: 1, hits }));
    const service = createHarnessSearchService({ search, resolveWorkspaceRoot: async () => "/workspace" });

    const exploreMode = await service.search({ pattern: "token" }, {
      workspaceId: "ws-1",
      signal: new AbortController().signal,
      candidateBudget: 80,
      hitsPerFile: 12,
    });
    expect(exploreMode.status).toBe("ready");
    expect(exploreMode.files.map((file) => file.path).sort()).toEqual(["flood.ts", "key.ts"]);
    expect(exploreMode.files.find((file) => file.path === "flood.ts")?.hits).toHaveLength(12);
    expect(exploreMode.partial).toBe(true);

    const grepMode = await service.search({ pattern: "token", limit: 1 }, {
      workspaceId: "ws-1",
      signal: new AbortController().signal,
    });
    expect(grepMode.files).toHaveLength(1);
    expect(grepMode.files[0]?.path).toBe("flood.ts");
    expect((search.mock.calls as unknown as Array<[Record<string, unknown>]>)[1]?.[0]).toMatchObject({ maxResults: 3 });
  });

  it("returns empty without launching search when the requested path and child scope are disjoint", async () => {
    let called = false;
    const service = createHarnessSearchService({
      search: async () => {
        called = true;
        return { status: "empty", generation: 1 };
      },
      resolveWorkspaceRoot: async () => "/workspace",
    });
    const result = await service.search(
      { pattern: "a", path: "packages/ui" },
      {
        workspaceId: "ws-1",
        workspaceScope: ["packages/web"],
        signal: new AbortController().signal,
      },
    );
    expect(result.status).toBe("empty");
    expect(called).toBe(false);
  });
});
