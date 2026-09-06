import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Value } from "typebox/value";
import type { HostServicesBridge } from "../../src/harness/host-services-bridge.js";
import { createExploreTool } from "../../src/harness/explore-tool.js";

describe("Host-backed explore tool", () => {
  it("T9: accepts anchors, forwards them, and no longer describes itself as an open-question search", async () => {
    let forwarded: unknown;
    const bridge = {
      request: async (_method: string, params: unknown) => {
        forwarded = params;
        return {
          text: "1 excerpt(s)",
          snippets: [],
          issues: [],
          notRequested: { count: 0, paths: [] },
          omitted: [],
          partial: false,
          searched: { patterns: 1, files: 1, ms: 1, incomplete: false },
          handle: "out_test",
          details: { provenance: [], anchors: { supplied: ["createMemoryAgentExtension"], used: ["createMemoryAgentExtension"], truncated: 0 }, byteBudget: 24576 },
        };
      },
    } as unknown as HostServicesBridge;
    const tool = createExploreTool(bridge, "session");

    assert.match(tool.description ?? "", /Locate relevant code and read the related context/);
    assert.match(tool.description ?? "", /anchors/);
    assert.doesNotMatch(tool.description ?? "", /Open question/);
    assert.doesNotMatch(tool.description ?? "", /broad questions/);
    assert.match(tool.promptSnippet ?? "", /anchors/);
    assert.ok((tool.promptGuidelines ?? []).some((line) => /without anchors or an explore model/i.test(line)));

    await tool.execute(
      "call",
      { question: "where is the factory", anchors: ["createMemoryAgentExtension"], limit: 3 },
      undefined,
      undefined,
      undefined as never,
    );

    assert.deepEqual(forwarded, {
      question: "where is the factory",
      anchors: ["createMemoryAgentExtension"],
      limit: 3,
    });
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
