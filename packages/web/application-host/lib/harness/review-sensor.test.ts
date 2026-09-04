import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  onAgentSettled,
  formatReviewForZone2,
  DEFAULT_REVIEW_SENSOR_SETTINGS,
} from "./review-sensor.js";
import { createThreadRegistry } from "./thread-registry.js";
import { resolveRoles } from "./roles.js";
import type { SlotResolution } from "./model-slots.js";

const mainModel: SlotResolution = { providerId: "anthropic", modelId: "claude-sonnet-4" };

function reviewRoleFor(main: SlotResolution = mainModel) {
  const roles = resolveRoles({ review: main }, main);
  return roles.find((r) => r.id === "review")!;
}

describe("onAgentSettled", () => {
  let dataDir: string;
  let registry: ReturnType<typeof createThreadRegistry>;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "review-sensor-"));
    registry = createThreadRegistry({ dataDir, hostId: "test-host" });
  });

  afterEach(() => {
    try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows */ }
  });

  it("does not open a thread when no journaled changes", async () => {
    const result = await onAgentSettled("p1", {
      registry,
      reviewRole: reviewRoleFor(),
      settings: DEFAULT_REVIEW_SENSOR_SETTINGS,
      getJournaledChanges: async () => [],
      getDiff: async () => "",
    });
    expect(result.reviewDispatched).toBe(false);
    expect(await registry.listThreads("p1", true)).toHaveLength(0);
  });

  it("does not open a thread when no review role configured", async () => {
    const result = await onAgentSettled("p1", {
      registry,
      reviewRole: null,
      settings: DEFAULT_REVIEW_SENSOR_SETTINGS,
      getJournaledChanges: async () => ["a.ts"],
      getDiff: async () => "diff",
    });
    expect(result.reviewDispatched).toBe(false);
    expect(await registry.listThreads("p1", true)).toHaveLength(0);
  });

  it("opens a review thread when changes exist and role configured", async () => {
    const result = await onAgentSettled("p1", {
      registry,
      reviewRole: reviewRoleFor(),
      settings: DEFAULT_REVIEW_SENSOR_SETTINGS,
      getJournaledChanges: async () => ["a.ts", "b.ts"],
      getDiff: async () => "diff content",
    });
    expect(result.reviewDispatched).toBe(true);
    expect(result.threadId).toBeDefined();
    expect(result.blocking).toBe(false);

    const thread = await registry.getThread("p1", result.threadId!);
    expect(thread?.role).toBe("review");
    expect(thread?.brief).toContain("diff content");
    expect(thread?.worktree).toBeNull();
  });

  it("the review thread is hidden from the parent agent's list", async () => {
    const result = await onAgentSettled("p1", {
      registry,
      reviewRole: reviewRoleFor(),
      settings: DEFAULT_REVIEW_SENSOR_SETTINGS,
      getJournaledChanges: async () => ["a.ts"],
      getDiff: async () => "diff",
    });
    expect(result.reviewDispatched).toBe(true);

    // §9.2.3: the harness's own agents are invisible to the main agent.
    expect(await registry.listThreads("p1")).toHaveLength(0);
    // …but the host still tracks them.
    const all = await registry.listThreads("p1", true);
    expect(all).toHaveLength(1);
    expect(all[0]!.hidden).toBe(true);
  });

  it("gate mode is blocking", async () => {
    const result = await onAgentSettled("p1", {
      registry,
      reviewRole: reviewRoleFor(),
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
