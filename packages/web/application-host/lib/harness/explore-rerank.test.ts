import { describe, expect, it } from "vitest";
import {
  documentsFromViews,
  exploreShouldRerank,
  scoresFromRerankResult,
  shrinkViewForRerank,
} from "./explore-rerank.js";
import type { ExploreQueryView } from "@piarium/protocol";

const view = (viewId: string, text: string): ExploreQueryView => ({
  viewId,
  path: "src/a.ts",
  startLine: 1,
  endLine: text.split("\n").length,
  text,
  revision: "r1",
  source: "disk",
  ranges: [],
  arrivals: [],
  assessment: "object-present",
  purpose: "primary",
  why: "test",
});

describe("explore rerank helpers", () => {
  it("skips rerank after model selection and shrinks views before send", () => {
    expect(exploreShouldRerank({ plan: "used", select: "used", followup: "skipped" })).toBe(false);
    expect(exploreShouldRerank({ plan: "skipped", select: "skipped", followup: "skipped" })).toBe(true);
    expect(exploreShouldRerank({ plan: "unconfigured", select: "unconfigured", followup: "unconfigured" })).toBe(true);
    expect(exploreShouldRerank({ plan: "used", select: "failed", followup: "skipped" })).toBe(false);

    const long = view("v1", Array.from({ length: 20 }, (_, index) => `line ${index}`).join("\n"));
    const shrunk = shrinkViewForRerank(long, 8, (text) => text.split(/\s+/).length);
    expect(shrunk.text.split("\n").length).toBeLessThan(long.text.split("\n").length);
    expect(shrunk.viewId).toBe("v1");
    expect(shrunk.startLine).toBe(1);

    const prepared = documentsFromViews([long, { ...view("v2", "short"), unevaluated: true }], 8, (text) => text.split(/\s+/).length);
    expect(prepared.documents.map((item) => item.id)).toEqual(["v1"]);
    expect(prepared.evaluated[0]?.text).toBe(shrunk.text);
  });

  it("does not invent scores for missing or illegal ids", () => {
    const scores = scoresFromRerankResult({
      batchId: "b1",
      providerId: "cohere",
      modelId: "rerank-v3.5",
      scores: [
        { id: "v1", index: 0, score: 0.8 },
        { id: "missing", index: 2, score: 0.1 },
        { id: "v2", index: 1, score: Number.NaN },
      ],
    }, [{ id: "v1" }, { id: "v2" }]);
    expect(scores).toEqual([{ viewId: "v1", score: 0.8 }]);
  });
});
