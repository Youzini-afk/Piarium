import { describe, expect, it, vi } from "vitest";
import { createHarnessSearchService } from "./search-service.js";
import type { WorkspaceContentSearchResult, WorkspaceSearchHit } from "../search/content.js";

function makeHit(path: string, line: number, preview: string): WorkspaceSearchHit {
  return { resource: { resourceId: path, workspaceId: "ws-1" }, line, column: 1, preview };
}

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
