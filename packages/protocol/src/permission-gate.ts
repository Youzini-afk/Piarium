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

const HIGH_RISK_PATTERNS: Array<{ tool: string; param: string; pattern: string }> = [
  { tool: "bash", param: "command", pattern: "\\b(rm|sudo|chmod|chown|mkfs|dd)\\b" },
  { tool: "bash", param: "command", pattern: "\\bgit\\s+(push|reset|checkout|rebase|clean)\\b" },
  { tool: "bash", param: "command", pattern: "\\b(npm|bun|yarn|pnpm)\\s+(install|add|remove)\\b" },
  { tool: "bash", param: "command", pattern: "\\.env|id_rsa|\\.ssh" },
];

export function isHighRisk(tool: string, params: Record<string, unknown>): boolean {
  for (const pattern of HIGH_RISK_PATTERNS) {
    if (pattern.tool !== tool) continue;
    const value = params[pattern.param];
    if (typeof value !== "string") continue;
    try {
      const regex = new RegExp(pattern.pattern);
      if (regex.test(value)) return true;
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

  // High-risk bash patterns always ask (even in accept-edits/bypass)
  for (const pattern of HIGH_RISK_PATTERNS) {
    rules.push({
      tool: pattern.tool,
      match: { param: pattern.param, pattern: pattern.pattern },
      decision: "ask",
    });
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
