import { describe, expect, it } from "vitest";
import { createExploreQueryRun } from "./explore.js";
import type { ExploreFileSnapshot } from "./explore-file-reader.js";

const ready = (content: string, revision = "rev-1"): ExploreFileSnapshot => ({
  status: "ready",
  content,
  revision,
  source: "disk",
});

const reclaim = [
  "export function reclaimLease(handle: string) {",
  "  parkedHandles.delete(handle);",
  "  return handle;",
  "}",
].join("\n");

describe("explore query run", () => {
  it("executes plan expressions as real searches and keeps a zero-overlap unit", async () => {
    const searched: string[] = [];
    const run = createExploreQueryRun({ question: "how does the runtime discard idle tokens" }, {
      rgSearch: async (pattern) => {
        searched.push(pattern);
        return pattern === "reclaimLease"
          ? [{ path: "src/reclaim.ts", line: 1, text: "export function reclaimLease(handle: string) {" }]
          : [];
      },
      readFile: async () => ready(reclaim),
    });
    run.start();
    const planned = await run.submitPlan({
      behavior: "discard idle tokens",
      groups: [{ id: "g1", concept: "reclaim", expressions: ["reclaimLease"] }],
    });
    expect(planned.launched).toEqual(["reclaimLease"]);
    await run.waitForViews();
    const views = run.viewsForModel();
    expect(views.views.some((view) => view.text.includes("reclaimLease"))).toBe(true);
    expect(searched).toContain("reclaimLease");
    const result = run.finish();
    expect(result.snippets.some((snippet) => snippet.text.includes("reclaimLease"))).toBe(true);
  });

  it("rejects unknown view ids and ranges the model did not see", async () => {
    const run = createExploreQueryRun({ question: "needle" }, {
      rgSearch: async () => [{ path: "a.ts", line: 1, text: "needle" }],
      readFile: async () => ready("needle\nsecond"),
    });
    run.start();
    await run.waitForViews();
    const selected = run.applySelection([
      {
        id: "sel1",
        purpose: "bad",
        views: [
          { viewId: "missing", rangeIds: ["missing:full"], required: true },
          { viewId: "v1", startLine: 99, endLine: 120, required: true },
        ],
      },
    ]);
    expect(selected.rejected.length).toBeGreaterThan(0);
    expect(selected.accepted).toEqual([]);
  });

  it("reuses a duplicate follow-up expression and does not revive a cancelled query", async () => {
    const run = createExploreQueryRun({ question: "needle" }, {
      rgSearch: async (pattern) => pattern === "needle"
        ? [{ path: "a.ts", line: 1, text: "needle" }]
        : [],
      readFile: async () => ready("needle"),
    });
    run.start();
    await run.waitForViews();
    const first = await run.followup({ searches: [{ expression: "needle" }] });
    expect(first.reused).toContain("needle");
    expect(first.launched).toEqual([]);
    run.cancel();
    expect(run.terminal()).toBe("cancelled");
    await expect(run.waitForViews()).resolves.toBeUndefined();
    expect(() => run.finish()).toThrow(/cancelled/i);
  });

  it("freezes arrived lexical views when a slow source misses the shared deadline", async () => {
    let releaseSemantic: (() => void) | undefined;
    const semanticHang = new Promise<void>((resolve) => {
      releaseSemantic = resolve;
    });
    const run = createExploreQueryRun({ question: "needle" }, {
      rgSearch: async () => [{ path: "a.ts", line: 1, text: "needle" }],
      readFile: async () => ready("needle"),
      semantic: {
        search: async () => {
          await semanticHang;
          return [];
        },
      },
    }, { deadlineAt: Date.now() + 80, reserveForJudgeMs: 0 });
    run.start();
    await run.waitForViews();
    expect(run.viewsForModel().views.some((view) => view.text.includes("needle"))).toBe(true);
    expect(run.sourceStates().some((source) => source.id === "semantic-original" && source.status === "incomplete")).toBe(true);
    releaseSemantic?.();
  });

  it("keeps required complementary ranges instead of broadcasting a file score", async () => {
    const body = [
      "export function trigger() { return register(\"svc\"); }",
      "export function unusedPadding() { return 1; }",
      "export function consumer() { return request(\"svc\"); }",
    ].join("\n");
    const run = createExploreQueryRun({ question: "how is svc wired", limit: 2 }, {
      rgSearch: async (pattern) => pattern === "svc"
        ? [
          { path: "src/wire.ts", line: 1, text: "export function trigger() { return register(\"svc\"); }" },
          { path: "src/wire.ts", line: 3, text: "export function consumer() { return request(\"svc\"); }" },
        ]
        : [],
      readFile: async () => ready(body),
    });
    run.start();
    await run.waitForViews();
    const views = run.viewsForModel().views;
    expect(views.length).toBeGreaterThan(0);
    const picked = views.slice(0, Math.min(2, views.length)).map((view) => ({
      viewId: view.viewId,
      rangeIds: [view.ranges[0]!.rangeId],
      required: true,
    }));
    run.applySelection([{ id: "ends", purpose: "both ends", views: picked }]);
    const result = run.finish();
    expect(result.snippets.length).toBeGreaterThan(0);
    expect(result.snippets.every((snippet) => snippet.required === true || snippet.text.includes("svc"))).toBe(true);
  });
});
