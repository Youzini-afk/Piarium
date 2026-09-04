/**
 * Model slot settings — nine slots + permissionJudge (3b).
 *
 * Design: agent-harness.md §1.9 schema
 * Plan: agent-harness-plan.md §2.9
 *
 * Slots: explore, retrievalAgent, quickImplement, hardImplement, check,
 * reader, review, suggestions, permissionJudge
 *
 * hardImplement and review resolve to main model when unset.
 * Others unset = not configured (capability not registered).
 */

// ── Types ──────────────────────────────────────────────────────────

import type { HarnessModelRole, ModelSelection } from "@piarium/protocol";

/** Slot ids are the `harness.models` keys defined by the protocol. */
export type SlotId = HarnessModelRole;
export type SlotResolution = ModelSelection;

export type ModelSlotsSettings = Partial<Record<SlotId, SlotResolution | null>>;

export type PresetName = "anthropic" | "openai" | "gemini";

// ── Resolution ─────────────────────────────────────────────────────

export interface ResolveSlotDeps {
  slots: ModelSlotsSettings;
  mainModel: SlotResolution;
  /** Provider model catalog: providerId → modelId[] */
  modelCatalog?: Record<string, string[]>;
}

const SLOTS_DEFAULTING_TO_MAIN: ReadonlySet<SlotId> = new Set(["hardImplement", "review"]);

export function resolveSlot(slot: SlotId, deps: ResolveSlotDeps): SlotResolution | null {
  const { slots, mainModel } = deps;
  const configured = slots[slot];
  if (configured) return configured;
  if (SLOTS_DEFAULTING_TO_MAIN.has(slot)) return mainModel;
  return null;
}

// ── Presets ────────────────────────────────────────────────────────

const PRESET_PATTERNS: Record<PresetName, Partial<Record<SlotId, string[]>>> = {
  anthropic: {
    explore: ["claude-3-haiku", "claude-3-5-haiku", "claude-haiku"],
    retrievalAgent: ["claude-3-haiku", "claude-3-5-haiku", "claude-haiku"],
    quickImplement: ["claude-3-haiku", "claude-3-5-haiku", "claude-haiku"],
    check: ["claude-3-haiku", "claude-3-5-haiku", "claude-haiku"],
    reader: ["claude-3-haiku", "claude-3-5-haiku", "claude-haiku"],
    suggestions: ["claude-3-haiku", "claude-3-5-haiku", "claude-haiku"],
    permissionJudge: ["claude-3-haiku", "claude-3-5-haiku", "claude-haiku"],
  },
  openai: {
    explore: ["gpt-4o-mini", "gpt-4o-nano", "o4-mini"],
    retrievalAgent: ["gpt-4o-mini", "gpt-4o-nano"],
    quickImplement: ["gpt-4o-mini", "gpt-4o-nano"],
    check: ["gpt-4o-mini", "gpt-4o-nano"],
    reader: ["gpt-4o-mini", "gpt-4o-nano"],
    suggestions: ["gpt-4o-mini", "gpt-4o-nano"],
    permissionJudge: ["gpt-4o-mini", "gpt-4o-nano"],
  },
  gemini: {
    explore: ["gemini-2.0-flash", "gemini-1.5-flash"],
    retrievalAgent: ["gemini-2.0-flash", "gemini-1.5-flash"],
    quickImplement: ["gemini-2.0-flash", "gemini-1.5-flash"],
    check: ["gemini-2.0-flash", "gemini-1.5-flash"],
    reader: ["gemini-2.0-flash", "gemini-1.5-flash"],
    suggestions: ["gemini-2.0-flash", "gemini-1.5-flash"],
    permissionJudge: ["gemini-2.0-flash", "gemini-1.5-flash"],
  },
};

export function applyPreset(
  preset: PresetName,
  deps: { providerId: string; modelCatalog?: string[] },
): ModelSlotsSettings {
  const patterns = PRESET_PATTERNS[preset];
  const result: ModelSlotsSettings = {};

  for (const [slot, candidates] of Object.entries(patterns)) {
    const slotId = slot as SlotId;
    const catalog = deps.modelCatalog ?? [];
    // Find first matching model in catalog
    const match = (candidates as string[]).find((pattern) =>
      catalog.some((model) => model.includes(pattern)),
    );
    if (match) {
      const modelId = catalog.find((m) => m.includes(match))!;
      result[slotId] = { providerId: deps.providerId, modelId };
    }
  }

  return result;
}

// ── Usage attribution ──────────────────────────────────────────────

export function attributeSlotUsage(slot: SlotId, tokens: number): { slot: SlotId; tokens: number } {
  return { slot, tokens };
}
