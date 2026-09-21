import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  resolveResearchCapabilities,
  sealRetrievalEvidence,
} from "../src/index.js";

describe("thread protocol behavior", () => {
  it("resolves only explicitly configured research capability slots", () => {
    const resolved = resolveResearchCapabilities({
      researchInvestigation: { providerId: "p", modelId: "investigator" },
      researchFastExploration: { providerId: "p", modelId: "fast" },
    });
    assert.deepEqual(resolved.map((entry) => entry.capability), ["investigation", "fast-exploration"]);
    assert.equal(resolveResearchCapabilities({}).length, 0);
  });

  it("seals retrieval evidence without inventing source-checked facts or completeness", () => {
    const cancelled = sealRetrievalEvidence(undefined, {
      brief: "Where is login?",
      scope: ["src"],
      outcome: "cancelled",
      exitReason: "killed by parent",
    });
    assert.equal(cancelled.completion, "cancelled");
    assert.equal(cancelled.question, "Where is login?");
    assert.equal(cancelled.facts.length, 0);

    const incomplete = sealRetrievalEvidence(undefined, {
      brief: "Where is login?",
      scope: ["src"],
      outcome: "success",
      exitReason: null,
    });
    assert.equal(incomplete.completion, "incomplete");
    assert.ok(incomplete.unknowns.length > 0);

    const delivered = sealRetrievalEvidence({
      question: "child restatement",
      scope: ["src"],
      facts: [{
        claim: "login is nearby",
        status: "source-checked",
        sources: [{ kind: "local", path: "src/auth.ts", startLine: 1, endLine: 1, check: "source-valid" }],
      }],
      unknowns: [],
      attempted: [],
      completion: "delivered",
    }, {
      brief: "Where is login?",
      scope: ["src"],
      outcome: "success",
      exitReason: null,
    });
    assert.equal(delivered.completion, "delivered");
    assert.equal(delivered.question, "Where is login?");
    assert.equal(delivered.facts[0]?.status, "source-checked");
  });
});
