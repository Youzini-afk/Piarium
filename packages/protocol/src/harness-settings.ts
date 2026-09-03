/**
 * Harness settings — stored under the `harness` key in user-level settings.
 * Workspace overrides stored in `~/.config/piarium/projects/<path-id>.json` under `harness`.
 * Effective at next session creation; frozen into `session.harness` for the session lifetime.
 */

import type { PermissionMode } from "./permission-gate.js";

export interface HarnessSettings {
  tools: Partial<Record<string, boolean>>;
  shell: "auto" | "git-bash" | "powershell" | "wsl";
  output: { visibleBytes: number };
  bash: { waitMs: number };
  models: Partial<Record<HarnessModelRole, { providerId: string; modelId: string }>>;
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
};

export function mergeHarnessSettings(
  user: Partial<HarnessSettings>,
  workspace: Partial<HarnessSettings>,
): HarnessSettings {
  const merged: HarnessSettings = {
    ...DEFAULT_HARNESS_SETTINGS,
    ...user,
    ...workspace,
    // Deep merge (depth 1) for nested objects
    tools: { ...DEFAULT_HARNESS_SETTINGS.tools, ...user.tools, ...workspace.tools },
    output: { ...DEFAULT_HARNESS_SETTINGS.output, ...user.output, ...workspace.output },
    bash: { ...DEFAULT_HARNESS_SETTINGS.bash, ...user.bash, ...workspace.bash },
    models: { ...DEFAULT_HARNESS_SETTINGS.models, ...user.models, ...workspace.models },
    dispatch: {
      ...DEFAULT_HARNESS_SETTINGS.dispatch,
      ...user.dispatch,
      ...workspace.dispatch,
      askBefore: {
        ...DEFAULT_HARNESS_SETTINGS.dispatch.askBefore,
        ...user.dispatch?.askBefore,
        ...workspace.dispatch?.askBefore,
      },
    },
    knowledge: {
      ...DEFAULT_HARNESS_SETTINGS.knowledge,
      ...user.knowledge,
      ...workspace.knowledge,
      autoAcceptSuggestions: {
        ...DEFAULT_HARNESS_SETTINGS.knowledge.autoAcceptSuggestions,
        ...user.knowledge?.autoAcceptSuggestions,
        ...workspace.knowledge?.autoAcceptSuggestions,
      },
    },
    ...(user.web || workspace.web
      ? { web: { ...user.web, ...workspace.web } }
      : {}),
    ...(user.permissions || workspace.permissions
      ? { permissions: { ...user.permissions, ...workspace.permissions } }
      : {}),
  };
  return merged;
}
