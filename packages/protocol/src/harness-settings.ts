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

export type HarnessWebSearchProvider = "brave" | "exa" | "tavily" | "jina" | "searxng";

export interface HarnessWebSearchSettings {
  provider: HarnessWebSearchProvider;
  /** Required for SearXNG; optional override for hosted providers. */
  endpoint?: string;
  /** Pi auth.json entry name. SearXNG may omit it for an unauthenticated instance. */
  credentialRef?: string;
}

export interface HarnessWorktreeBudget {
  maxBytes?: number;
  minFreeRatio?: number;
}

export interface HarnessWorktreeSettings {
  setup?: string;
  setupTimeoutMs?: number;
  copyIgnored?: string[];
  shareDependencies?: boolean;
  reclaimIdle?: boolean;
  budget?: HarnessWorktreeBudget;
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
  memory: { shadowMode: boolean };
  worktree?: HarnessWorktreeSettings;
  web?: {
    maxFetchesPerTurn?: number;
    render?: boolean;
    search?: HarnessWebSearchSettings;
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
  memory: { shadowMode: true },
  worktree: {
    copyIgnored: [],
    shareDependencies: false,
    reclaimIdle: true,
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
    // Background model calls and their cost are user-owned. A repository may
    // not silently enable the experimental memory keeper.
    memory: {
      ...DEFAULT_HARNESS_SETTINGS.memory,
      ...user.memory,
    },
    ...(user.web || workspace.web
      ? {
          web: {
            ...user.web,
            // A repository may tune fetch behavior, but cannot redirect web
            // searches or select a credential from the user's auth store.
            ...(workspace.web?.maxFetchesPerTurn === undefined
              ? {}
              : { maxFetchesPerTurn: workspace.web.maxFetchesPerTurn }),
            ...(workspace.web?.render === undefined ? {} : { render: workspace.web.render }),
            ...(user.web?.search ? { search: { ...user.web.search } } : {}),
          },
        }
      : {}),
    worktree: {
      ...DEFAULT_HARNESS_SETTINGS.worktree,
      ...user.worktree,
      ...workspace.worktree,
      ...(user.worktree?.budget || workspace.worktree?.budget
        ? {
            budget: {
              ...user.worktree?.budget,
              ...workspace.worktree?.budget,
            },
          }
        : {}),
    },
    permissions,
  };
  return merged;
}
