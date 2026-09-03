/**
 * Role catalog — six roles for sub-agents.
 *
 * Design: agent-harness.md §9.2.2
 * Plan: agent-harness-plan.md §3.6
 *
 * Roles: quick-implement, hard-implement, frontend, review, check, retrieval
 * Unconfigured slots → role omitted from catalog and team prompt.
 */

import type { SlotId, SlotResolution } from "./model-slots.js";

// ── Types ──────────────────────────────────────────────────────────

export type RoleId =
  | "quick-implement"
  | "hard-implement"
  | "frontend"
  | "review"
  | "check"
  | "retrieval";

export type WorktreeMode = "shared" | "isolated-when-parallel" | "none";

export interface RoleDefinition {
  id: RoleId;
  slot: SlotId;
  tools: string[];
  worktree: WorktreeMode;
  systemPromptFragment: string;
  resultSchema: unknown;
  budget: { maxTurns: number; maxTokens: number };
}

// ── Role definitions ───────────────────────────────────────────────

export const ROLE_DEFINITIONS: Record<RoleId, RoleDefinition> = {
  "quick-implement": {
    id: "quick-implement",
    slot: "quickImplement",
    tools: ["read", "edit", "write", "bash", "grep", "glob"],
    worktree: "shared",
    systemPromptFragment: "You are a quick implementation agent. Make mechanical, well-specified changes efficiently.",
    resultSchema: { changedFiles: "string[]", conclusion: "string" },
    budget: { maxTurns: 20, maxTokens: 50_000 },
  },
  "hard-implement": {
    id: "hard-implement",
    slot: "hardImplement",
    tools: ["read", "edit", "write", "bash", "grep", "glob", "explore", "recall", "todo"],
    worktree: "isolated-when-parallel",
    systemPromptFragment: "You are a hard implementation agent. Handle ambiguous or cross-cutting work that requires deeper reasoning.",
    resultSchema: { changedFiles: "string[]", conclusion: "string", unresolved: "string[]" },
    budget: { maxTurns: 50, maxTokens: 200_000 },
  },
  "frontend": {
    id: "frontend",
    slot: "hardImplement",
    tools: ["read", "edit", "write", "bash", "grep", "glob", "explore"],
    worktree: "isolated-when-parallel",
    systemPromptFragment: "You are a frontend specialist. Focus on UI components, styles, and user-facing behavior.",
    resultSchema: { changedFiles: "string[]", conclusion: "string" },
    budget: { maxTurns: 40, maxTokens: 150_000 },
  },
  "review": {
    id: "review",
    slot: "review",
    tools: ["read", "grep", "glob", "bash"],
    worktree: "none",
    systemPromptFragment: "You have not seen the conversation; review the diff on its own merits.",
    resultSchema: { conclusion: "string", issues: "string[]", severity: "string" },
    budget: { maxTurns: 15, maxTokens: 50_000 },
  },
  "check": {
    id: "check",
    slot: "check",
    tools: ["read", "bash", "grep", "glob"],
    worktree: "shared",
    systemPromptFragment: "You are a check agent. Run tests and lint, report results. Do not make changes.",
    resultSchema: { conclusion: "string", passed: "boolean", output: "string" },
    budget: { maxTurns: 10, maxTokens: 30_000 },
  },
  "retrieval": {
    id: "retrieval",
    slot: "retrievalAgent",
    tools: ["read", "grep", "glob", "explore", "related", "recall", "symbols", "definition", "references", "hover"],
    worktree: "none",
    systemPromptFragment: "You are a retrieval agent. Perform multi-step code search to answer open questions.",
    resultSchema: { conclusion: "string", snippets: "string[]" },
    budget: { maxTurns: 15, maxTokens: 50_000 },
  },
};

// ── Catalog resolution ─────────────────────────────────────────────

export interface ResolvedRole {
  id: RoleId;
  model: SlotResolution;
  definition: RoleDefinition;
}

export function resolveRoles(
  slots: Partial<Record<SlotId, SlotResolution | null>>,
  mainModel: SlotResolution,
): ResolvedRole[] {
  const resolved: ResolvedRole[] = [];
  for (const role of Object.values(ROLE_DEFINITIONS)) {
    const slotResolution = slots[role.slot] ?? null;
    // hardImplement and review default to main
    let model: SlotResolution | null = slotResolution;
    if (!model && (role.slot === "hardImplement" || role.slot === "review")) {
      model = mainModel;
    }
    if (model) {
      resolved.push({ id: role.id, model, definition: role });
    }
  }
  return resolved;
}

// ── Team prompt ────────────────────────────────────────────────────

export function buildTeamPrompt(roles: ResolvedRole[]): string {
  if (roles.length === 0) return "";
  const roleList = roles.map((r) => {
    const def = r.definition;
    const desc = def.systemPromptFragment.split(". ")[0];
    return `${def.id} (${desc})`;
  }).join(", ");
  return `You can hand work to teammates with dispatch(role, task). Teammates: ${roleList}. Judge by time and cost: if you can finish in a few tool calls yourself, do it yourself. Dispatch is asynchronous; use wait to collect results.`;
}

export const TEAM_PROMPT_GUIDELINES = ["team"];
