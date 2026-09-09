import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  exploreShouldPlanWithModel,
  exploreShouldSelectWithModel,
  parseExplorePlan,
  parseExploreSelection,
} from "../../src/harness/explore-model.js";

describe("explore model consumers", () => {
  it("skips a plan for a path-only navigation and keeps it for a mechanism question with anchors", () => {
    assert.equal(exploreShouldPlanWithModel("src/reclaim.ts", ["src/reclaim.ts"]), false);
    assert.equal(exploreShouldPlanWithModel("how does reclaimLease discard idle tokens", ["reclaimLease"]), true);
    assert.equal(exploreShouldSelectWithModel("how does reclaimLease discard idle tokens", ["reclaimLease"], false), true);
  });

  it("parses grouped plan expressions and selection range ids", () => {
    const plan = parseExplorePlan(`
      here you go
      {"behavior":"discard idle tokens","groups":[{"id":"g1","concept":"reclaim","expressions":["reclaimLease","parkedHandles"]}]}
    `);
    assert.deepEqual(plan?.groups[0]?.expressions, ["reclaimLease", "parkedHandles"]);
    const selected = parseExploreSelection(JSON.stringify({
      groups: [{
        id: "sel1",
        purpose: "reclaim implementation",
        views: [{ viewId: "v1", rangeIds: ["v1:full"], required: true }],
        gap: "no caller in this batch",
      }],
      followup: { searches: [{ expression: "parkedHandles.delete" }], locates: [{ kind: "symbol", value: "reclaimLease" }] },
    }));
    assert.equal(selected?.groups[0]?.views[0]?.viewId, "v1");
    assert.equal(selected?.followup?.searches?.[0]?.expression, "parkedHandles.delete");
  });
});
