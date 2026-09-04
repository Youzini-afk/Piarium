import { describe, it, expect } from "vitest";
import { resolveRoles, buildTeamPrompt, ROLE_DEFINITIONS } from "./roles.js";
import type { ModelSelection } from "@piarium/protocol";

const mainModel: ModelSelection = { providerId: "anthropic", modelId: "claude-sonnet-4" };
const haiku: ModelSelection = { providerId: "anthropic", modelId: "claude-haiku" };

describe("resolveRoles", () => {
  it("returns all roles when all slots configured", () => {
    const roles = resolveRoles({
      quickImplement: haiku,
      hardImplement: mainModel,
      frontend: haiku,
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
    // Only the two slots that default to the main model remain (§9.2.2).
    const ids = roles.map((r) => r.id);
    expect(ids).toContain("hard-implement");
    expect(ids).toContain("review");
    expect(ids).not.toContain("quick-implement");
    expect(ids).not.toContain("frontend");
    expect(ids).not.toContain("check");
    expect(ids).not.toContain("retrieval");
  });

  it("frontend uses its own slot and is omitted when that slot is unset", () => {
    const withoutFrontend = resolveRoles({ hardImplement: mainModel }, mainModel);
    expect(withoutFrontend.find((r) => r.id === "frontend")).toBeUndefined();

    const withFrontend = resolveRoles({ frontend: haiku }, mainModel);
    expect(withFrontend.find((r) => r.id === "frontend")?.model).toEqual(haiku);
  });

  it("omits every role when there is no main model and no slots", () => {
    expect(resolveRoles({}, null)).toEqual([]);
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
    expect(prompt).toContain("dispatch(role, task)");
    expect(prompt).toContain("quick-implement (cheap model; mechanical, well-specified changes)");
    expect(prompt).toContain("hard-implement (strong model; ambiguous or cross-cutting work)");
    expect(prompt).toContain("check (cheap model; run tests/lint and report)");
    // The judgement principle, not a quota or a cost estimate (§9.2.4).
    expect(prompt).toContain("Judge by time and cost");
    expect(prompt).toContain("wait blocks until a teammate changes state");
  });

  it("omits unconfigured roles from the prompt", () => {
    const roles = resolveRoles({ check: haiku }, mainModel);
    const prompt = buildTeamPrompt(roles);
    expect(prompt).toContain("check");
    expect(prompt).not.toContain("quick-implement");
    expect(prompt).not.toContain("retrieval");
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

  it("does not publish unenforced per-role token or turn ceilings", () => {
    for (const role of Object.values(ROLE_DEFINITIONS)) {
      expect(role).not.toHaveProperty("budget");
    }
  });
});
