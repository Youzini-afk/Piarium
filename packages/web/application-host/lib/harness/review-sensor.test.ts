import { describe, it, expect } from "vitest";
import {
  onAgentSettled,
  formatReviewForZone2,
  DEFAULT_REVIEW_SENSOR_SETTINGS,
} from "./review-sensor.js";
import { createWorkerRuntime } from "./worker-runtime.js";
import { resolveRoles, type ResolvedRole } from "./roles.js";
import type { SlotResolution } from "./model-slots.js";

const mainModel: SlotResolution = { providerId: "anthropic", modelId: "claude-sonnet-4" };

function makeRuntime() {
  return createWorkerRuntime({
    settings: { concurrency: 12, staleAfterMs: 300000, askBefore: {} },
    spawnSession: async () => ({ childId: "c1", sessionId: "s1" }),
    killSession: async () => {},
    applyWorktreeDiff: async () => ({ merged: 0, conflicts: [] }),
    now: () => 1_000_000,
  });
}

describe("onAgentSettled", () => {
  it("does not dispatch when no journaled changes", async () => {
    const runtime = makeRuntime();
    const roles = resolveRoles({ review: mainModel }, mainModel);
    const reviewRole = roles.find((r) => r.id === "review")!;
    const result = await onAgentSettled("p1", {
      runtime,
      reviewRole,
      settings: DEFAULT_REVIEW_SENSOR_SETTINGS,
      getJournaledChanges: async () => [],
      getDiff: async () => "",
    });
    expect(result.reviewDispatched).toBe(false);
  });

  it("does not dispatch when no review role configured", async () => {
    const runtime = makeRuntime();
    const result = await onAgentSettled("p1", {
      runtime,
      reviewRole: null,
      settings: DEFAULT_REVIEW_SENSOR_SETTINGS,
      getJournaledChanges: async () => ["a.ts"],
      getDiff: async () => "diff",
    });
    expect(result.reviewDispatched).toBe(false);
  });

  it("dispatches review when changes exist and role configured", async () => {
    const runtime = makeRuntime();
    const roles = resolveRoles({ review: mainModel }, mainModel);
    const reviewRole = roles.find((r) => r.id === "review")!;
    const result = await onAgentSettled("p1", {
      runtime,
      reviewRole,
      settings: DEFAULT_REVIEW_SENSOR_SETTINGS,
      getJournaledChanges: async () => ["a.ts", "b.ts"],
      getDiff: async () => "diff content",
    });
    expect(result.reviewDispatched).toBe(true);
    expect(result.childId).toBeDefined();
    expect(result.blocking).toBe(false);
  });

  it("gate mode is blocking", async () => {
    const runtime = makeRuntime();
    const roles = resolveRoles({ review: mainModel }, mainModel);
    const reviewRole = roles.find((r) => r.id === "review")!;
    const result = await onAgentSettled("p1", {
      runtime,
      reviewRole,
      settings: { gate: true },
      getJournaledChanges: async () => ["a.ts"],
      getDiff: async () => "diff",
    });
    expect(result.blocking).toBe(true);
  });
});

describe("formatReviewForZone2", () => {
  it("wraps review text in <review> tags", () => {
    const formatted = formatReviewForZone2("Looks good, minor issues in a.ts");
    expect(formatted).toContain("<review>");
    expect(formatted).toContain("Looks good");
    expect(formatted).toContain("</review>");
  });
});
