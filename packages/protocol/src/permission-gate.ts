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

  return { decision: "ask", reason: "no matching rule" };
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

// ── Default rules ──────────────────────────────────────────────────

const READ_ONLY_TOOLS = new Set([
  "read", "grep", "glob", "explore", "related", "recall",
  "symbols", "definition", "references", "hover",
  "todo", "wait", "ls", "threads", "send", "read_thread",
]);

const EDIT_TOOLS = new Set(["edit", "write", "apply_patch", "merge"]);
const SHELL_TOOLS = new Set(["bash", "write_to_process"]);

export function defaultRules(mode: PermissionMode, askBefore: Record<string, boolean> = {}): PermissionRule[] {
  const rules: PermissionRule[] = [];

  for (const tool of READ_ONLY_TOOLS) {
    rules.push({ tool, decision: "allow" });
  }

  // High-risk bash patterns always ask (even in accept-edits)
  for (const pattern of HIGH_RISK_PATTERNS) {
    rules.push({
      tool: pattern.tool,
      match: { param: pattern.param, pattern: pattern.pattern },
      decision: "ask",
    });
  }

  if (mode === "accept-edits" || mode === "bypass") {
    for (const tool of EDIT_TOOLS) {
      rules.push({ tool, decision: "allow" });
    }
  } else {
    for (const tool of EDIT_TOOLS) {
      rules.push({ tool, decision: "ask" });
    }
  }

  if (mode === "bypass") {
    for (const tool of SHELL_TOOLS) {
      rules.push({ tool, decision: "allow" });
    }
  } else {
    for (const tool of SHELL_TOOLS) {
      rules.push({ tool, decision: "ask" });
    }
  }

  for (const [role, ask] of Object.entries(askBefore)) {
    rules.push({
      tool: "dispatch",
      match: { param: "role", pattern: `^${role}$` },
      decision: ask ? "ask" : "allow",
    });
  }

  if (mode === "bypass") {
    rules.push({ tool: "*", decision: "allow" });
  } else {
    rules.push({ tool: "*", decision: "ask" });
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
