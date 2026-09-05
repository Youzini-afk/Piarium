import { mergeHarnessSettings, type HarnessWorktreeSettings, type PiSettingsSnapshot } from "@piarium/protocol";

const object = (value: unknown, label: string): Record<string, unknown> => {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
};

const worktreeSettings = (value: unknown, label: string): HarnessWorktreeSettings => {
  const config = object(value, label);
  const harness = object(config.harness, `${label}.harness`);
  const input = object(harness.worktree, `${label}.harness.worktree`);
  const result: HarnessWorktreeSettings = {};
  if (input.setup !== undefined) {
    if (typeof input.setup !== "string") throw new Error(`${label}.harness.worktree.setup must be a command string`);
    result.setup = input.setup;
  }
  if (input.setupTimeoutMs !== undefined) {
    if (typeof input.setupTimeoutMs !== "number" || !Number.isFinite(input.setupTimeoutMs) || input.setupTimeoutMs <= 0) throw new Error(`${label}.harness.worktree.setupTimeoutMs must be positive`);
    result.setupTimeoutMs = input.setupTimeoutMs;
  }
  if (input.copyIgnored !== undefined) {
    if (!Array.isArray(input.copyIgnored) || input.copyIgnored.some((entry) => typeof entry !== "string" || !entry.trim())) throw new Error(`${label}.harness.worktree.copyIgnored must contain paths`);
    result.copyIgnored = input.copyIgnored;
  }
  for (const key of ["shareDependencies", "reclaimIdle"] as const) {
    if (input[key] === undefined) continue;
    if (typeof input[key] !== "boolean") throw new Error(`${label}.harness.worktree.${key} must be a boolean`);
    result[key] = input[key];
  }
  if (input.budget !== undefined) {
    const budget = object(input.budget, `${label}.harness.worktree.budget`);
    result.budget = {};
    for (const key of ["maxBytes", "minFreeRatio"] as const) {
      const amount = budget[key];
      if (amount === undefined) continue;
      if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0 || (key === "minFreeRatio" && amount > 1)) throw new Error(`${label}.harness.worktree.budget.${key} is invalid`);
      result.budget[key] = amount;
    }
  }
  return result;
};

/** Pi owns both the configuration source and the project trust decision. */
export const resolveThreadWorktreeSettings = (snapshot: PiSettingsSnapshot): HarnessWorktreeSettings | undefined => mergeHarnessSettings(
  { worktree: worktreeSettings(snapshot.global, "global settings") },
  snapshot.projectTrusted ? { worktree: worktreeSettings(snapshot.project, "project settings") } : {},
).worktree;
