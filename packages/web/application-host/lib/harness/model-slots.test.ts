import { describe, it, expect } from "vitest";
import {
  resolveSlot,
  applyPreset,
  type ModelSlotsSettings,
  type SlotResolution,
} from "./model-slots.js";

const mainModel: SlotResolution = { providerId: "anthropic", modelId: "claude-sonnet-4" };

describe("resolveSlot", () => {
  it("returns configured slot", () => {
    const slots: ModelSlotsSettings = {
      explore: { providerId: "anthropic", modelId: "claude-haiku" },
    };
    expect(resolveSlot("explore", { slots, mainModel })).toEqual({
      providerId: "anthropic", modelId: "claude-haiku",
    });
  });

  it("hardImplement defaults to main when unset", () => {
    const slots: ModelSlotsSettings = {};
    expect(resolveSlot("hardImplement", { slots, mainModel })).toEqual(mainModel);
  });

  it("review defaults to main when unset", () => {
    const slots: ModelSlotsSettings = {};
    expect(resolveSlot("review", { slots, mainModel })).toEqual(mainModel);
  });

  it("explore returns null when unset", () => {
    const slots: ModelSlotsSettings = {};
    expect(resolveSlot("explore", { slots, mainModel })).toBeNull();
  });

  it("check returns null when unset", () => {
    const slots: ModelSlotsSettings = {};
    expect(resolveSlot("check", { slots, mainModel })).toBeNull();
  });

  it("permissionJudge returns null when unset", () => {
    const slots: ModelSlotsSettings = {};
    expect(resolveSlot("permissionJudge", { slots, mainModel })).toBeNull();
  });

  it("hardImplement uses configured value when set", () => {
    const slots: ModelSlotsSettings = {
      hardImplement: { providerId: "openai", modelId: "gpt-4o" },
    };
    expect(resolveSlot("hardImplement", { slots, mainModel })).toEqual({
      providerId: "openai", modelId: "gpt-4o",
    });
  });
});

describe("applyPreset", () => {
  it("anthropic preset fills slots from catalog", () => {
    const slots = applyPreset("anthropic", {
      providerId: "anthropic",
      modelCatalog: ["claude-sonnet-4", "claude-3-5-haiku-20241022", "claude-opus-4"],
    });
    expect(slots.explore).toBeDefined();
    expect(slots.explore?.modelId).toContain("haiku");
    expect(slots.quickImplement?.modelId).toContain("haiku");
    expect(slots.reader?.modelId).toContain("haiku");
  });

  it("openai preset fills slots from catalog", () => {
    const slots = applyPreset("openai", {
      providerId: "openai",
      modelCatalog: ["gpt-4o", "gpt-4o-mini", "gpt-4o-nano"],
    });
    expect(slots.explore?.modelId).toContain("mini");
    expect(slots.quickImplement?.modelId).toContain("mini");
  });

  it("gemini preset fills slots from catalog", () => {
    const slots = applyPreset("gemini", {
      providerId: "google",
      modelCatalog: ["gemini-2.0-flash", "gemini-1.5-pro"],
    });
    expect(slots.explore?.modelId).toContain("flash");
  });

  it("preset skips slots with no matching model", () => {
    const slots = applyPreset("anthropic", {
      providerId: "anthropic",
      modelCatalog: ["claude-sonnet-4"], // no haiku
    });
    expect(slots.explore).toBeUndefined();
  });

  it("preset can be overridden after application", () => {
    const slots = applyPreset("anthropic", {
      providerId: "anthropic",
      modelCatalog: ["claude-3-5-haiku"],
    });
    slots.explore = { providerId: "openai", modelId: "gpt-4o-mini" };
    expect(slots.explore?.providerId).toBe("openai");
  });
});
