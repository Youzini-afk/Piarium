import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  parsePiSessionFeatureMutation,
  PiSessionFeatureValidationError,
} from "../src/index.js";

describe("Pi session feature protocol", () => {
  it("constructs a narrow mutation and drops unknown transport fields", () => {
    assert.deepEqual(
      parsePiSessionFeatureMutation({
        objective: "Finish the migration",
        smuggledWorkerId: "other-worker",
        tokenBudget: 12_000,
        type: "goal.start",
      }),
      {
        objective: "Finish the migration",
        tokenBudget: 12_000,
        type: "goal.start",
      },
    );
  });

  it("validates state-changing fields before they cross a worker boundary", () => {
    assert.throws(
      () => parsePiSessionFeatureMutation({ objective: "x", tokenBudget: 0, type: "goal.start" }),
      PiSessionFeatureValidationError,
    );
    assert.throws(
      () => parsePiSessionFeatureMutation({ goalId: "goal", status: "finished", type: "goal.update" }),
      /status must be one of/,
    );
    assert.throws(
      () => parsePiSessionFeatureMutation({ entryId: "entry", pinned: true, type: "context.set" }),
      /Unsupported session feature mutation/,
    );
  });
});
