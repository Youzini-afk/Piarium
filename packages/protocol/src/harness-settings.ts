/**
 * Harness settings live under `harness` in Pi's agent-directory settings.json.
 * Trusted project overrides come from <workspace>/.pi/settings.json.
 * Pi owns source loading and project trust; tool assembly resolves them at session creation.
 */

import {
  parseHarnessEmbeddingSettings,
  parseHarnessRerankSettings,
  type HarnessEmbeddingSettings,
  type HarnessRerankSettings,
} from "./harness-inference.js";
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

export type HarnessMemoryMode = "off" | "assist" | "takeover";

export interface HarnessMemorySettings {
  mode: HarnessMemoryMode;
}

export interface HarnessReviewSettings {
  /** Default true: review a published non-empty child result once. */
  enabled: boolean;
  /** Default false: do not block ordinary settlement on the review finding. */
  gate: boolean;
}

/**
 * Raw persisted shape accepted while reading Pi settings. `shadowMode` is the
 * pre-takeover setting and is intentionally not part of HarnessSettings.
 */
export interface HarnessMemorySettingsInput {
  mode?: unknown;
  shadowMode?: unknown;
}

export class HarnessSettingsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HarnessSettingsValidationError";
  }
}

const HARNESS_MEMORY_MODES = ["off", "assist", "takeover"] as const;

/** Resolve the user-owned memory setting, including the legacy boolean. */
const DEFAULT_HARNESS_REVIEW_SETTINGS: HarnessReviewSettings = { enabled: true, gate: false };

export function resolveHarnessReviewSettings(value: unknown): HarnessReviewSettings {
  if (value === undefined) return { ...DEFAULT_HARNESS_REVIEW_SETTINGS };
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HarnessSettingsValidationError("harness.review must be an object");
  }
  const input = value as Record<string, unknown>;
  if (input.enabled !== undefined && typeof input.enabled !== "boolean") {
    throw new HarnessSettingsValidationError("harness.review.enabled must be a boolean");
  }
  if (input.gate !== undefined && typeof input.gate !== "boolean") {
    throw new HarnessSettingsValidationError("harness.review.gate must be a boolean");
  }
  return {
    enabled: input.enabled ?? DEFAULT_HARNESS_REVIEW_SETTINGS.enabled,
    gate: input.gate ?? DEFAULT_HARNESS_REVIEW_SETTINGS.gate,
  };
}

export function resolveHarnessMemoryMode(value: unknown): HarnessMemoryMode {
  if (value === undefined) return "takeover";
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HarnessSettingsValidationError("harness.memory must be an object");
  }
  const input = value as HarnessMemorySettingsInput;
  if (input.mode !== undefined) {
    if (!HARNESS_MEMORY_MODES.includes(input.mode as HarnessMemoryMode)) {
      throw new HarnessSettingsValidationError(
        `harness.memory.mode must be one of: ${HARNESS_MEMORY_MODES.join(", ")}`,
      );
    }
    return input.mode as HarnessMemoryMode;
  }
  if (input.shadowMode !== undefined) {
    if (typeof input.shadowMode !== "boolean") {
      throw new HarnessSettingsValidationError("harness.memory.shadowMode must be a boolean");
    }
    return input.shadowMode ? "assist" : "off";
  }
  return "takeover";
}

export type HarnessSettingsInput = Omit<Partial<HarnessSettings>, "memory" | "review"> & {
  memory?: HarnessMemorySettingsInput;
  review?: Partial<HarnessReviewSettings>;
};

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
  memory: HarnessMemorySettings;
  /** User-owned automatic review of published child results. */
  review: HarnessReviewSettings;
  /** Dedicated embedding backend. Not a chat model slot. */
  embedding?: HarnessEmbeddingSettings;
  /** Dedicated rerank backend. Not a chat completion or embeddings alias. */
  rerank?: HarnessRerankSettings;
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
  memory: { mode: "takeover" },
  review: { enabled: true, gate: false },
  worktree: {
    copyIgnored: [],
    shareDependencies: false,
    reclaimIdle: true,
  },
  permissions: { mode: "normal", rules: [] },
};

export function mergeHarnessSettings(
  user: HarnessSettingsInput,
  workspace: HarnessSettingsInput,
): HarnessSettings {
  const { embedding: userEmbedding, rerank: userRerank, ...userRest } = user;
  const { embedding: _workspaceEmbedding, rerank: _workspaceRerank, ...workspaceRest } = workspace;
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
    ...userRest,
    ...workspaceRest,
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
    // Memory execution is user-owned. A repository cannot disable the keeper,
    // enable background model calls, or change compaction ownership.
    memory: { mode: resolveHarnessMemoryMode(user.memory) },
    // Automatic review enablement and the completion gate are user-owned.
    review: resolveHarnessReviewSettings(user.review),
    // Embedding and rerank bindings are user-owned. A repository cannot
    // redirect remote inference or select another provider credential.
    ...((() => {
      // Optional background inference cannot make ordinary chat unusable when
      // an older/external file is malformed. Its direct consumers parse the
      // raw global value and report invalid/unavailable; settings.update still
      // rejects writing a malformed candidate.
      let embedding: HarnessEmbeddingSettings | undefined;
      let rerank: HarnessRerankSettings | undefined;
      try { embedding = parseHarnessEmbeddingSettings(userEmbedding); } catch { embedding = undefined; }
      try { rerank = parseHarnessRerankSettings(userRerank); } catch { rerank = undefined; }
      return {
        ...(embedding ? { embedding } : {}),
        ...(rerank ? { rerank } : {}),
      };
    })()),
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
