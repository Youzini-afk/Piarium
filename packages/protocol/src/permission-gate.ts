/**
 * Permission gate protocol types — shared between pi-host and web host.
 *
 * Design: agent-harness.md §9.1.2
 * Plan: agent-harness-plan.md §3b.1
 */

export type PermissionMode = "normal" | "accept-edits" | "bypass" | "smart";
export type PermissionDecision = "allow" | "ask" | "deny";

export interface PermissionRule {
  tool: string | "*";
  match?: { param: string; pattern: string };
  decision: PermissionDecision;
}

export interface PermissionPolicy {
  mode: PermissionMode;
  rules: PermissionRule[];
}

export interface GateResult {
  decision: PermissionDecision;
  reason?: string;
}

// ── Gate evaluation (pure function, shared) ────────────────────────

export function evaluateGate(
  tool: string,
  params: Record<string, unknown>,
  policy: PermissionPolicy,
): GateResult {
  if (policy.mode === "bypass") {
    return { decision: "allow", reason: "bypass mode" };
  }

  for (const rule of policy.rules) {
    if (rule.tool !== "*" && rule.tool !== tool) continue;

    if (rule.match) {
      const paramValue = params[rule.match.param];
      if (typeof paramValue !== "string") continue;
      try {
        const regex = new RegExp(rule.match.pattern);
        if (!regex.test(paramValue)) continue;
      } catch {
        continue;
      }
    }

    return { decision: rule.decision, reason: `matched rule: tool=${rule.tool}` };
  }

  // No matching rule: if the tool is not in HARNESS_TOOL_META, it's a
  // non-harness tool (MCP, Pi built-in) — pass through to Pi's own
  // permission system (allow here, Pi will handle it).
  // If it IS a harness tool but somehow has no rule, ask to be safe.
  if (!HARNESS_TOOL_META[tool]) {
    return { decision: "allow", reason: "non-harness tool (passthrough)" };
  }
  return { decision: "ask", reason: "no matching rule for harness tool" };
}

// ── High-risk detection ────────────────────────────────────────────

/**
 * Categories that always ask, regardless of mode and regardless of a
 * session-scoped "always allow" grant (plan §3b.2). Each entry lists the
 * tools it applies to, the parameter to inspect, and the pattern.
 */
export const HIGH_RISK_PATTERNS: ReadonlyArray<{
  tools: readonly string[];
  param: string;
  pattern: string;
}> = [
  { tools: ["bash", "write_to_process"], param: "command", pattern: "\\b(rm|sudo|chmod|chown|mkfs|dd)\\b" },
  { tools: ["bash", "write_to_process"], param: "command", pattern: "\\bgit\\s+(push|reset|checkout|rebase|clean)\\b" },
  { tools: ["bash", "write_to_process"], param: "command", pattern: "\\b(npm|bun|yarn|pnpm)\\s+(install|add|remove)\\b" },
  { tools: ["bash", "write_to_process"], param: "command", pattern: "\\.env|id_rsa|\\.ssh" },
  // Sensitive paths reached through the edit tools, not only through a shell.
  { tools: ["write", "edit", "apply_patch"], param: "path", pattern: "\\.env|id_rsa|\\.ssh" },
  { tools: ["write", "edit", "apply_patch"], param: "file_path", pattern: "\\.env|id_rsa|\\.ssh" },
];

export function isHighRisk(tool: string, params: Record<string, unknown>): boolean {
  for (const entry of HIGH_RISK_PATTERNS) {
    if (!entry.tools.includes(tool)) continue;
    const value = params[entry.param];
    if (typeof value !== "string") continue;
    try {
      if (new RegExp(entry.pattern).test(value)) return true;
    } catch {
      // ignore invalid regex
    }
  }
  return false;
}

// ── Default rules (mutation-based, from HARNESS_TOOL_META) ────────

import { HARNESS_TOOL_META, type HarnessToolMutation } from "./harness-tools.js";

export function defaultRules(mode: PermissionMode, askBefore: Record<string, boolean> = {}): PermissionRule[] {
  const rules: PermissionRule[] = [];

  // High-risk categories always ask (even in accept-edits/bypass)
  for (const entry of HIGH_RISK_PATTERNS) {
    for (const tool of entry.tools) {
      rules.push({
        tool,
        match: { param: entry.param, pattern: entry.pattern },
        decision: "ask",
      });
    }
  }

  // Dispatch askBefore rules (per-role) — must come BEFORE the
  // mutation-based dispatch:allow rule so they match first.
  for (const [role, ask] of Object.entries(askBefore)) {
    rules.push({
      tool: "dispatch",
      match: { param: "role", pattern: `^${role}$` },
      decision: ask ? "ask" : "allow",
    });
  }

  // Build rules from HARNESS_TOOL_META mutation attribute
  for (const [tool, meta] of Object.entries(HARNESS_TOOL_META)) {
    const mutation: HarnessToolMutation = meta.mutation;
    if (mutation === "none") {
      // Read-only tools always allowed
      rules.push({ tool, decision: "allow" });
    } else if (mutation === "journaled") {
      // Edit tools: allow in accept-edits/bypass, ask in normal
      rules.push({ tool, decision: (mode === "accept-edits" || mode === "bypass") ? "allow" : "ask" });
    } else if (mutation === "process") {
      // Shell tools: allow in bypass, ask otherwise
      rules.push({ tool, decision: mode === "bypass" ? "allow" : "ask" });
    }
  }

  // Catch-all: only in bypass mode. Non-harness tools pass through
  // (evaluateGate returns "allow" for tools not in HARNESS_TOOL_META).
  if (mode === "bypass") {
    rules.push({ tool: "*", decision: "allow" });
  }

  return rules;
}

// ── Policy merge ───────────────────────────────────────────────────

export function mergePolicies(user: PermissionPolicy, workspace: Partial<PermissionPolicy>): PermissionPolicy {
  return {
    mode: workspace.mode ?? user.mode,
    rules: workspace.rules ?? user.rules,
  };
}
