/**
 * Harness settings — stored under the `harness` key in user-level settings.
 * Workspace overrides stored in `~/.config/piarium/projects/<path-id>.json` under `harness`.
 * Effective at next session creation; frozen into `session.harness` for the session lifetime.
 */

import { mergePolicies, type PermissionMode, type PermissionRule } from "./permission-gate.js";

/** A provider + model pair, as stored in a model slot. */
export interface ModelSelection {
  providerId: string;
  modelId: string;
}

export interface HarnessSettings {
  tools: Partial<Record<string, boolean>>;
  shell: "auto" | "git-bash" | "powershell" | "wsl";
  output: { visibleBytes: number };
  bash: { waitMs: number };
  models: Partial<Record<HarnessModelRole, ModelSelection>>;
  dispatch: { concurrency: number; askBefore: Partial<Record<string, boolean>> };
  knowledge: {
    eventRetentionDays: number;
    autoAcceptSuggestions: { workspace: boolean; user: boolean };
  };
  web?: {
    maxFetchesPerTurn?: number;
    render?: boolean;
  };
  permissions?: {
    mode?: PermissionMode;
    rules?: PermissionRule[];
  };
}

export type HarnessModelRole =
  | "explore"
  | "retrievalAgent"
  | "quickImplement"
  | "hardImplement"
  | "frontend"
  | "review"
  | "check"
  | "reader"
  | "suggestions"
  | "permissionJudge";

export const DEFAULT_HARNESS_SETTINGS: HarnessSettings = {
  tools: {},
  shell: "auto",
  output: { visibleBytes: 32768 },
  bash: { waitMs: 60000 },
  models: {},
  dispatch: { concurrency: 12, askBefore: {} },
  knowledge: {
    eventRetentionDays: 30,
    autoAcceptSuggestions: { workspace: false, user: false },
  },
  permissions: { mode: "normal", rules: [] },
};

export function mergeHarnessSettings(
  user: Partial<HarnessSettings>,
  workspace: Partial<HarnessSettings>,
): HarnessSettings {
  const askBeforeKeys = new Set([
    ...Object.keys(user.dispatch?.askBefore ?? {}),
    ...Object.keys(workspace.dispatch?.askBefore ?? {}),
  ]);
  const askBefore = Object.fromEntries([...askBeforeKeys].map((key) => [
    key,
    user.dispatch?.askBefore?.[key] === true || workspace.dispatch?.askBefore?.[key] === true,
  ]));
  const permissions = mergePolicies(
    {
      mode: user.permissions?.mode ?? DEFAULT_HARNESS_SETTINGS.permissions?.mode ?? "normal",
      rules: user.permissions?.rules ?? [],
    },
    {
      ...(workspace.permissions?.mode === undefined ? {} : { mode: workspace.permissions.mode }),
      ...(workspace.permissions?.rules === undefined ? {} : { rules: workspace.permissions.rules }),
    },
  );
  const merged: HarnessSettings = {
    ...DEFAULT_HARNESS_SETTINGS,
    ...user,
    ...workspace,
    // Deep merge (depth 1) for nested objects
    tools: { ...DEFAULT_HARNESS_SETTINGS.tools, ...user.tools, ...workspace.tools },
    output: { ...DEFAULT_HARNESS_SETTINGS.output, ...user.output, ...workspace.output },
    bash: { ...DEFAULT_HARNESS_SETTINGS.bash, ...user.bash, ...workspace.bash },
    // Model/provider selection is user-owned. A repository cannot redirect
    // auxiliary requests to another provider.
    models: { ...DEFAULT_HARNESS_SETTINGS.models, ...user.models },
    dispatch: {
      ...DEFAULT_HARNESS_SETTINGS.dispatch,
      ...user.dispatch,
      ...workspace.dispatch,
      askBefore,
    },
    knowledge: {
      ...DEFAULT_HARNESS_SETTINGS.knowledge,
      ...user.knowledge,
      ...workspace.knowledge,
      autoAcceptSuggestions: {
        user: user.knowledge?.autoAcceptSuggestions?.user
          ?? DEFAULT_HARNESS_SETTINGS.knowledge.autoAcceptSuggestions.user,
        workspace: workspace.knowledge?.autoAcceptSuggestions?.workspace
          ?? user.knowledge?.autoAcceptSuggestions?.workspace
          ?? DEFAULT_HARNESS_SETTINGS.knowledge.autoAcceptSuggestions.workspace,
      },
    },
    ...(user.web || workspace.web
      ? { web: { ...user.web, ...workspace.web } }
      : {}),
    permissions,
  };
  return merged;
}
