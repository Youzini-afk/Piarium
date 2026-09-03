/**
 * Native permission gate — tool_call gating with policy file.
 *
 * Design: agent-harness.md §9.1.2
 * Plan: agent-harness-plan.md §3b.1
 *
 * Policy schema: { mode, rules: [{ tool, match?, decision }] }
 * mode: normal | accept-edits | bypass | smart
 * Default rules: mutation:none → allow; edit/write/apply_patch/merge →
 *   ask (normal) / allow (accept-edits); bash/write_to_process → ask;
 *   bypass → all allow; dispatch → askBefore[role]
 * Rules evaluated top-down, first match wins.
 */

// ── Types ──────────────────────────────────────────────────────────

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

// ── Default rules ──────────────────────────────────────────────────

const READ_ONLY_TOOLS = new Set([
  "read", "grep", "glob", "explore", "related", "recall",
  "symbols", "definition", "references", "hover",
  "todo", "wait", "ls",
]);

const EDIT_TOOLS = new Set(["edit", "write", "apply_patch", "merge"]);
const SHELL_TOOLS = new Set(["bash", "write_to_process"]);

export function defaultRules(mode: PermissionMode, askBefore: Record<string, boolean> = {}): PermissionRule[] {
  const rules: PermissionRule[] = [];

  // Read-only tools always allowed
  for (const tool of READ_ONLY_TOOLS) {
    rules.push({ tool, decision: "allow" });
  }

  // High-risk bash patterns always ask (even in accept-edits)
  rules.push({
    tool: "bash",
    match: { param: "command", pattern: "\\b(rm|sudo|chmod|chown|mkfs|dd)\\b" },
    decision: "ask",
  });
  rules.push({
    tool: "bash",
    match: { param: "command", pattern: "\\bgit\\s+(push|reset|checkout|rebase|clean)\\b" },
    decision: "ask",
  });
  rules.push({
    tool: "bash",
    match: { param: "command", pattern: "\\b(npm|bun|yarn|pnpm)\\s+(install|add|remove)\\b" },
    decision: "ask",
  });
  rules.push({
    tool: "bash",
    match: { param: "command", pattern: "\\.env|id_rsa|\\.ssh" },
    decision: "ask",
  });

  // Edit tools
  if (mode === "accept-edits" || mode === "bypass") {
    for (const tool of EDIT_TOOLS) {
      rules.push({ tool, decision: "allow" });
    }
  } else {
    for (const tool of EDIT_TOOLS) {
      rules.push({ tool, decision: "ask" });
    }
  }

  // Shell tools
  if (mode === "bypass") {
    for (const tool of SHELL_TOOLS) {
      rules.push({ tool, decision: "allow" });
    }
  } else {
    for (const tool of SHELL_TOOLS) {
      rules.push({ tool, decision: "ask" });
    }
  }

  // Dispatch
  for (const [role, ask] of Object.entries(askBefore)) {
    rules.push({
      tool: "dispatch",
      match: { param: "role", pattern: `^${role}$` },
      decision: ask ? "ask" : "allow",
    });
  }

  // Catch-all
  if (mode === "bypass") {
    rules.push({ tool: "*", decision: "allow" });
  } else {
    rules.push({ tool: "*", decision: "ask" });
  }

  return rules;
}

// ── Gate evaluation ────────────────────────────────────────────────

export function evaluateGate(
  tool: string,
  params: Record<string, unknown>,
  policy: PermissionPolicy,
): GateResult {
  if (policy.mode === "bypass") {
    return { decision: "allow", reason: "bypass mode" };
  }

  for (const rule of policy.rules) {
    // Check tool match
    if (rule.tool !== "*" && rule.tool !== tool) continue;

    // Check param match if specified
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

  // Default: ask in normal/smart, allow in bypass (already handled above)
  return { decision: "ask", reason: "no matching rule" };
}

// ── Policy merge (user + workspace override) ───────────────────────

export function mergePolicies(user: PermissionPolicy, workspace: Partial<PermissionPolicy>): PermissionPolicy {
  return {
    mode: workspace.mode ?? user.mode,
    rules: workspace.rules ?? user.rules,
  };
}

// ── Smart mode high-risk categories ────────────────────────────────

export const HIGH_RISK_PATTERNS: Array<{ param: string; pattern: string }> = [
  { param: "command", pattern: "\\b(rm|sudo|chmod|chown|mkfs|dd)\\b" },
  { param: "command", pattern: "\\b(npm|bun|yarn|pnpm)\\s+(install|add|remove)\\b" },
  { param: "command", pattern: "\\bgit\\s+(push|reset|checkout|rebase|clean)\\b" },
  { param: "command", pattern: "\\.env|id_rsa|\\.ssh" },
  { param: "path", pattern: "\\.env|id_rsa|\\.ssh" },
];

export function isHighRisk(tool: string, params: Record<string, unknown>): boolean {
  if (tool !== "bash" && tool !== "write" && tool !== "edit") return false;
  for (const { param, pattern } of HIGH_RISK_PATTERNS) {
    const value = params[param];
    if (typeof value === "string") {
      try {
        if (new RegExp(pattern).test(value)) return true;
      } catch {
        // ignore
      }
    }
  }
  return false;
}
