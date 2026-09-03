import { describe, it, expect } from "vitest";
import { resolveRoles, buildTeamPrompt, ROLE_DEFINITIONS } from "./roles.js";
import type { SlotResolution } from "./model-slots.js";

const mainModel: SlotResolution = { providerId: "anthropic", modelId: "claude-sonnet-4" };
const haiku: SlotResolution = { providerId: "anthropic", modelId: "claude-haiku" };

describe("resolveRoles", () => {
  it("returns all roles when all slots configured", () => {
    const roles = resolveRoles({
      quickImplement: haiku,
      hardImplement: mainModel,
      retrievalAgent: haiku,
      check: haiku,
      review: mainModel,
    }, mainModel);
    const ids = roles.map((r) => r.id);
    expect(ids).toContain("quick-implement");
    expect(ids).toContain("hard-implement");
    expect(ids).toContain("frontend");
    expect(ids).toContain("review");
    expect(ids).toContain("check");
    expect(ids).toContain("retrieval");
  });

  it("hardImplement defaults to main when unset", () => {
    const roles = resolveRoles({}, mainModel);
    const hard = roles.find((r) => r.id === "hard-implement");
    expect(hard).toBeDefined();
    expect(hard?.model).toEqual(mainModel);
  });

  it("review defaults to main when unset", () => {
    const roles = resolveRoles({}, mainModel);
    const review = roles.find((r) => r.id === "review");
    expect(review).toBeDefined();
    expect(review?.model).toEqual(mainModel);
  });

  it("omits roles with unconfigured non-defaulting slots", () => {
    const roles = resolveRoles({}, mainModel);
    // Only hard-implement, frontend (uses hardImplement slot), review should remain
    const ids = roles.map((r) => r.id);
    expect(ids).toContain("hard-implement");
    expect(ids).toContain("frontend");
    expect(ids).toContain("review");
    // quick-implement, check, retrieval should be omitted
    expect(ids).not.toContain("quick-implement");
    expect(ids).not.toContain("check");
    expect(ids).not.toContain("retrieval");
  });

  it("frontend uses hardImplement slot", () => {
    const roles = resolveRoles({ hardImplement: mainModel }, mainModel);
    const frontend = roles.find((r) => r.id === "frontend");
    expect(frontend?.model).toEqual(mainModel);
  });
});

describe("buildTeamPrompt", () => {
  it("returns empty string when no roles", () => {
    expect(buildTeamPrompt([])).toBe("");
  });

  it("includes role names and descriptions", () => {
    const roles = resolveRoles({
      quickImplement: haiku,
      hardImplement: mainModel,
      check: haiku,
    }, mainModel);
    const prompt = buildTeamPrompt(roles);
    expect(prompt).toContain("dispatch");
    expect(prompt).toContain("quick-implement");
    expect(prompt).toContain("hard-implement");
    expect(prompt).toContain("check");
    expect(prompt).toContain("wait to collect results");
  });

  it("prompt is static for same role set", () => {
    const roles = resolveRoles({ quickImplement: haiku, check: haiku }, mainModel);
    const prompt1 = buildTeamPrompt(roles);
    const prompt2 = buildTeamPrompt(roles);
    expect(prompt1).toBe(prompt2);
  });
});

describe("ROLE_DEFINITIONS", () => {
  it("review systemPromptFragment mentions not seeing conversation", () => {
    expect(ROLE_DEFINITIONS["review"].systemPromptFragment).toContain("not seen the conversation");
  });

  it("check has read-only + bash tools", () => {
    const tools = ROLE_DEFINITIONS["check"].tools;
    expect(tools).toContain("bash");
    expect(tools).toContain("read");
    expect(tools).not.toContain("edit");
    expect(tools).not.toContain("write");
  });

  it("all roles have budget", () => {
    for (const role of Object.values(ROLE_DEFINITIONS)) {
      expect(role.budget.maxTurns).toBeGreaterThan(0);
      expect(role.budget.maxTokens).toBeGreaterThan(0);
    }
  });
});
