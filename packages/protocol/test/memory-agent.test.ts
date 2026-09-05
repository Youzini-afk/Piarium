import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_MEMORY_AGENT_SETTINGS,
  createInitialMemoryAgentState,
  evaluateMemoryAgentGate,
  parseMemoryEditOps,
} from "../src/index.js";

describe("memory agent protocol", () => {
  it("parses only structured memory_edit operations", () => {
    assert.deepEqual(parseMemoryEditOps({
      ops: [{ op: "create", block: "progress", content: "working" }],
    }), [{ op: "create", block: "progress", content: "working" }]);
    assert.equal(parseMemoryEditOps({ ops: [{ op: "create", item: "zero" }] }), null);
    assert.equal(parseMemoryEditOps({ ops: [{ op: "invent" }] }), null);
  });

  it("parses expectedRevision when present", () => {
    assert.deepEqual(parseMemoryEditOps({
      ops: [{ op: "replace", block: "progress", content: "new", expectedRevision: 12345 }],
    }), [{ op: "replace", block: "progress", content: "new", expectedRevision: 12345 }]);
  });

  it("rejects an invalid expectedRevision", () => {
    for (const expectedRevision of [NaN, -1, 1.5]) {
      assert.equal(parseMemoryEditOps({
        ops: [{ op: "replace", block: "progress", content: "new", expectedRevision }],
      }), null);
    }
  });

  it("does not schedule the first run before meaningful context exists", () => {
    const state = createInitialMemoryAgentState(DEFAULT_MEMORY_AGENT_SETTINGS);
    assert.deepEqual(evaluateMemoryAgentGate(state, {
      turnIndex: 1,
      contextTokens: 2_000,
      toolCallsSinceLastRun: 10,
      lastStepHadNoTools: false,
    }, DEFAULT_MEMORY_AGENT_SETTINGS, Date.now()), {
      shouldRun: false,
      reason: "below-min-context",
    });
  });
});
