/**
 * Role catalog — the six sub-agent roles of the code profile.
 *
 * Design: agent-harness.md §9.2.2
 * Plan: agent-harness-plan.md §3.6
 *
 * The catalog is a pure static table with no host dependencies, so it lives
 * in the protocol package: the host needs it to build a thread from a role,
 * and pi-host needs it to build the `dispatch` tool's team prompt and to
 * reject roles whose model slot is not configured.
 *
 * A role whose slot is unconfigured is omitted from the catalog entirely —
 * it is not listed in the team prompt and `dispatch` rejects it. Roles never
 * fall back to the main model silently (invariant 6); `hardImplement` and
 * `review` resolve to the main model by design, which is explicit.
 */

import type { HarnessModelRole, ModelSelection } from "./harness-settings.js";

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
  slot: HarnessModelRole;
  tools: string[];
  worktree: WorktreeMode;
  /** Appended to the end of the thread's system prompt (Zone 0 stays shared). */
  systemPromptFragment: string;
  /** One clause describing the teammate, used to build the team prompt. */
  teamDescription: string;
  resultSchema: unknown;
}

// ── Role definitions ───────────────────────────────────────────────

export const ROLE_DEFINITIONS: Readonly<Record<RoleId, RoleDefinition>> = {
  "quick-implement": {
    id: "quick-implement",
    slot: "quickImplement",
    tools: ["read", "edit", "write", "apply_patch", "bash", "grep", "glob", "get_output", "write_to_process", "kill_shell"],
    worktree: "shared",
    systemPromptFragment:
      "You are a quick implementation agent. Make mechanical, well-specified changes efficiently.",
    teamDescription: "cheap model; mechanical, well-specified changes",
    resultSchema: { changedFiles: "string[]", conclusion: "string" },
  },
  "hard-implement": {
    id: "hard-implement",
    slot: "hardImplement",
    tools: ["read", "edit", "write", "apply_patch", "bash", "grep", "glob", "get_output", "write_to_process", "kill_shell", "explore", "recall", "todo"],
    worktree: "isolated-when-parallel",
    systemPromptFragment:
      "You are a hard implementation agent. Handle ambiguous or cross-cutting work that requires deeper reasoning.",
    teamDescription: "strong model; ambiguous or cross-cutting work",
    resultSchema: { changedFiles: "string[]", conclusion: "string", unresolved: "string[]" },
  },
  "frontend": {
    id: "frontend",
    slot: "frontend",
    tools: ["read", "edit", "write", "apply_patch", "bash", "grep", "glob", "get_output", "write_to_process", "kill_shell", "explore"],
    worktree: "isolated-when-parallel",
    systemPromptFragment:
      "You are a frontend specialist. Focus on UI components, styles, and user-facing behavior.",
    teamDescription: "UI specialist",
    resultSchema: { changedFiles: "string[]", conclusion: "string" },
  },
  "review": {
    id: "review",
    slot: "review",
    tools: ["read", "grep", "glob", "bash", "get_output", "write_to_process", "kill_shell"],
    worktree: "none",
    systemPromptFragment: "You have not seen the conversation; review the diff on its own merits.",
    teamDescription: "strong model; independent review of a diff",
    resultSchema: { conclusion: "string", issues: "string[]", severity: "string" },
  },
  "check": {
    id: "check",
    slot: "check",
    tools: ["read", "bash", "grep", "glob", "get_output", "write_to_process", "kill_shell"],
    worktree: "shared",
    systemPromptFragment:
      "You are a check agent. Run tests and lint, report results. Do not make changes.",
    teamDescription: "cheap model; run tests/lint and report",
    resultSchema: { conclusion: "string", passed: "boolean", output: "string" },
  },
  "retrieval": {
    id: "retrieval",
    slot: "retrievalAgent",
    tools: ["read", "grep", "glob", "explore", "related", "recall", "symbols", "definition", "references", "hover"],
    worktree: "none",
    systemPromptFragment:
      "You are a retrieval agent. Perform multi-step code search to answer open questions.",
    teamDescription: "cheap model; multi-step code search",
    resultSchema: { conclusion: "string", snippets: "string[]" },
  },
};

export function isRoleId(value: string): value is RoleId {
  return Object.prototype.hasOwnProperty.call(ROLE_DEFINITIONS, value);
}

// ── Catalog resolution ─────────────────────────────────────────────

export interface ResolvedRole {
  id: RoleId;
  model: ModelSelection;
  definition: RoleDefinition;
}

/** Slots that resolve to the session's main model when left unconfigured. */
const SLOTS_DEFAULTING_TO_MAIN: ReadonlySet<HarnessModelRole> = new Set(["hardImplement", "review"]);

export function resolveRoles(
  slots: Partial<Record<HarnessModelRole, ModelSelection | null>>,
  mainModel: ModelSelection | null,
): ResolvedRole[] {
  const resolved: ResolvedRole[] = [];
  for (const role of Object.values(ROLE_DEFINITIONS)) {
    let model = slots[role.slot] ?? null;
    if (!model && SLOTS_DEFAULTING_TO_MAIN.has(role.slot)) model = mainModel;
    if (model) resolved.push({ id: role.id, model, definition: role });
  }
  return resolved;
}

// ── Team prompt ────────────────────────────────────────────────────

/**
 * The team prompt is static for a given role set, so it can live in the
 * `dispatch` tool's promptGuidelines without invalidating the prefix cache
 * mid-session.
 */
export function buildTeamPrompt(roles: ResolvedRole[]): string {
  if (roles.length === 0) return "";
  const roleList = roles
    .map((r) => `${r.definition.id} (${r.definition.teamDescription})`)
    .join(", ");
  return (
    `You can hand work to teammates with dispatch(role, task). Teammates: ${roleList}. ` +
    "Judge by time and cost: if you can finish in a few tool calls yourself, do it yourself. " +
    "Dispatch is asynchronous: wait blocks until a teammate changes state, threads is a quick glance, " +
    "send passes a teammate new information, read_thread shows their notes. " +
    "The user may also open and talk to teammates directly; their final report tells you what actually happened."
  );
}
