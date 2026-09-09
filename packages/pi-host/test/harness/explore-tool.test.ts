import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Value } from "typebox/value";
import type { HostServicesBridge } from "../../src/harness/host-services-bridge.js";
import { createExploreTool } from "../../src/harness/explore-tool.js";

const finishResult = {
  text: "1 excerpt(s)",
  snippets: [],
  issues: [],
  notRequested: { count: 0, paths: [] },
  omitted: [],
  partial: false,
  searched: { patterns: 1, files: 1, ms: 1, incomplete: false },
  handle: "out_test",
  details: {
    provenance: [],
    anchors: { supplied: ["createMemoryAgentExtension"], used: ["createMemoryAgentExtension"], truncated: 0 },
    byteBudget: 24576,
  },
};

describe("Host-backed explore tool", () => {
  it("T9: accepts anchors, forwards them, and describes conceptual mapping", async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const bridge = {
      inputContext: () => ({ source: "disk" as const }),
      cancel: () => undefined,
      request: async (method: string, params: Record<string, unknown>) => {
        calls.push({ method, params });
        if (method === "explore.query.start") {
          return {
            queryId: "eq_test",
            question: params.question,
            deadlineAt: Date.now() + 1000,
            parsed: { objects: [], relation: "unknown", domain: "unknown" },
            vocab: { objects: [], anchors: params.anchors ?? [] },
            sources: [],
            inputSource: "disk",
          };
        }
        if (method === "explore.query.views") {
          return {
            queryId: "eq_test",
            question: "where is the factory",
            views: [],
            unevaluated: 0,
            sources: [],
            deadlineAt: Date.now() + 1000,
          };
        }
        if (method === "explore.query.finish") return finishResult;
        if (method === "explore.query.release") return { released: true };
        throw new Error(`unexpected ${method}`);
      },
    } as unknown as HostServicesBridge;
    const tool = createExploreTool(bridge, "session");

    assert.match(tool.description ?? "", /Locate relevant code and read the related context/);
    assert.match(tool.description ?? "", /anchors/);
    assert.match(tool.description ?? "", /conceptual names/);
    assert.doesNotMatch(tool.description ?? "", /Open question/);
    assert.doesNotMatch(tool.description ?? "", /broad questions/);
    assert.match(tool.promptSnippet ?? "", /conceptual questions/);
    assert.ok((tool.promptGuidelines ?? []).some((line) => /conceptual question and repository identifiers/i.test(line)));

    await tool.execute(
      "call",
      { question: "where is the factory", anchors: ["createMemoryAgentExtension"], limit: 3 },
      undefined,
      undefined,
      undefined as never,
    );

    assert.equal(calls[0]?.method, "explore.query.start");
    assert.equal(calls[0]?.params.question, "where is the factory");
    assert.deepEqual(calls[0]?.params.anchors, ["createMemoryAgentExtension"]);
    assert.equal(calls[0]?.params.limit, 3);
    assert.ok(calls.some((call) => call.method === "explore.query.views"));
    assert.ok(calls.some((call) => call.method === "explore.query.finish"));
    assert.ok(calls.some((call) => call.method === "explore.query.release"));
  });

  it("accepts a blank anchor at the schema layer so the Host can filter it", () => {
    const tool = createExploreTool({ request: async () => ({}) } as unknown as HostServicesBridge, "session");
    // The Host drops blank anchors and reports them in details.anchors. A stricter schema here
    // would reject the whole call instead, so the two layers must accept the same input.
    assert.equal(Value.Check(tool.parameters, { question: "needle", anchors: ["foo", ""] }), true);
    assert.equal(Value.Check(tool.parameters, { question: "needle", anchors: ["foo", "  "] }), true);
    assert.equal(Value.Check(tool.parameters, { question: "needle", anchors: [7] }), false);
  });
});
