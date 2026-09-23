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

  it("seals only submitted retrieval evidence and preserves partial facts by Run outcome", () => {
    const noStructuredEvidence = sealRetrievalEvidence(undefined, {
      brief: "Where is login?",
      outcome: "success",
    });
    assert.equal(noStructuredEvidence, undefined);

    const partial = {
      question: "child restatement",
      scope: ["src"],
      facts: [{
        claim: "login is nearby",
        status: "source-checked" as const,
        sources: [{ kind: "local" as const, path: "src/auth.ts", startLine: 1, endLine: 1, check: "source-valid" as const }],
      }],
      unknowns: ["who calls login"],
      attempted: [],
      completion: "delivered" as const,
    };
    const failed = sealRetrievalEvidence(partial, {
      brief: "Where is login?",
      outcome: "failure",
    });
    assert.equal(failed?.completion, "incomplete");
    assert.equal(failed?.question, "Where is login?");
    assert.equal(failed?.facts[0]?.status, "source-checked");
    assert.deepEqual(failed?.unknowns, ["who calls login"]);

    const cancelled = sealRetrievalEvidence(partial, {
      brief: "Where is login?",
      outcome: "cancelled",
    });
    assert.equal(cancelled?.completion, "cancelled");
    assert.equal(cancelled?.facts[0]?.status, "source-checked");

    const delivered = sealRetrievalEvidence(partial, {
      brief: "Where is login?",
      outcome: "success",
    });
    assert.equal(delivered?.completion, "delivered");
    assert.equal(delivered?.question, "Where is login?");
    assert.equal(delivered?.facts[0]?.status, "source-checked");
  });
});
