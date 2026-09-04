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

export const MAX_PERMISSION_PATTERN_LENGTH = 512;

export class PermissionPolicyValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermissionPolicyValidationError";
  }
}

const PERMISSION_MODES = new Set<PermissionMode>(["normal", "accept-edits", "bypass", "smart"]);

export function validatePermissionMode(value: unknown, source = "permission"): PermissionMode {
  if (typeof value !== "string" || !PERMISSION_MODES.has(value as PermissionMode)) {
    throw new PermissionPolicyValidationError(`${source} mode is invalid`);
  }
  return value as PermissionMode;
}

/**
 * Accept the regular subset needed by command/path policies while rejecting
 * constructs that can make JavaScript's backtracking engine super-linear.
 * 512 characters is over ten times the built-in policy patterns and still
 * leaves ample room for path/command matchers; it is a configuration error,
 * not a limit on commands or paths being evaluated.
 */
export function permissionPatternIssue(pattern: string): string | null {
  if (pattern.length > MAX_PERMISSION_PATTERN_LENGTH) {
    return `pattern exceeds ${MAX_PERMISSION_PATTERN_LENGTH} characters`;
  }
  try {
    new RegExp(pattern);
  } catch {
    return "pattern is not a valid regular expression";
  }
  if (/\\(?:[1-9]|k<)/.test(pattern)) return "backreferences are not supported";
  if (/\(\?(?:[=!]|<[=!])/.test(pattern)) return "lookaround is not supported";

  const stack: Array<{ alternation: boolean; variableQuantifier: boolean }> = [];
  let inClass = false;
  let escaped = false;
  let closedGroup: { alternation: boolean; variableQuantifier: boolean } | null = null;
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]!;
    if (escaped) {
      escaped = false;
      closedGroup = null;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "[" && !inClass) {
      inClass = true;
      closedGroup = null;
      continue;
    }
    if (char === "]" && inClass) {
      inClass = false;
      continue;
    }
    if (inClass) continue;
    if (char === "(") {
      if (pattern.slice(index, index + 3) === "(?:") index += 2;
      stack.push({ alternation: false, variableQuantifier: false });
      closedGroup = null;
      continue;
    }
    if (char === ")") {
      closedGroup = stack.pop() ?? null;
      if (closedGroup && stack.length > 0) {
        const parent = stack[stack.length - 1]!;
        parent.alternation ||= closedGroup.alternation;
        parent.variableQuantifier ||= closedGroup.variableQuantifier;
      }
      continue;
    }
    if (char === "|") {
      if (stack.length > 0) stack[stack.length - 1]!.alternation = true;
      closedGroup = null;
      continue;
    }
    let variableQuantifier = char === "*" || char === "+" || char === "?";
    if (char === "{") {
      const match = pattern.slice(index).match(/^\{(\d+)(?:,(\d*)?)?\}/);
      if (match) {
        index += match[0].length - 1;
        variableQuantifier = match[2] !== undefined && match[2] !== match[1];
      }
    }
    if (variableQuantifier) {
      if (closedGroup?.alternation || closedGroup?.variableQuantifier) {
        return "quantified groups cannot contain alternation or another variable quantifier";
      }
      for (const group of stack) group.variableQuantifier = true;
      closedGroup = null;
      continue;
    }
    closedGroup = null;
  }
  return null;
}

export function validatePermissionRule(rule: PermissionRule, source = "permission"): PermissionRule {
  if (!rule || typeof rule !== "object") {
    throw new PermissionPolicyValidationError(`${source} rule must be an object`);
  }
  if (typeof rule.tool !== "string" || !rule.tool.trim()) {
    throw new PermissionPolicyValidationError(`${source} rule tool must be non-empty`);
  }
  if (rule.decision !== "allow" && rule.decision !== "ask" && rule.decision !== "deny") {
    throw new PermissionPolicyValidationError(`${source} rule has an invalid decision`);
  }
  const match = (rule as PermissionRule & { match?: unknown }).match;
  if (match !== undefined) {
    if (!match || typeof match !== "object" || Array.isArray(match)) {
      throw new PermissionPolicyValidationError(`${source} rule match must be an object`);
    }
    const candidate = match as Record<string, unknown>;
    if (typeof candidate.param !== "string" || !candidate.param.trim() || typeof candidate.pattern !== "string") {
      throw new PermissionPolicyValidationError(`${source} rule match must contain param and pattern strings`);
    }
    const issue = permissionPatternIssue(candidate.pattern);
    if (issue) throw new PermissionPolicyValidationError(`${source} rule ${issue}`);
  }
  return {
    tool: rule.tool,
    decision: rule.decision,
    ...(match ? {
      match: {
        param: (match as Record<string, unknown>).param as string,
        pattern: (match as Record<string, unknown>).pattern as string,
      },
    } : {}),
  };
}

// ── Gate evaluation (pure function, shared) ────────────────────────

export function evaluateGate(
  tool: string,
  params: Record<string, unknown>,
  policy: PermissionPolicy,
): GateResult {
  for (const rule of policy.rules) {
    if (rule.tool !== "*" && rule.tool !== tool) continue;

    if (rule.match) {
      const paramValue = params[rule.match.param];
      if (typeof paramValue !== "string") continue;
      const issue = permissionPatternIssue(rule.match.pattern);
      if (issue) return { decision: "deny", reason: `invalid permission rule: ${issue}` };
      if (!new RegExp(rule.match.pattern).test(paramValue)) continue;
    }

    return { decision: rule.decision, reason: `matched rule: tool=${rule.tool}` };
  }

  if (policy.mode === "bypass") {
    return { decision: "allow", reason: "bypass mode" };
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
  { tools: ["bash"], param: "command", pattern: "\\b(rm|sudo|chmod|chown|mkfs|dd)\\b" },
  { tools: ["write_to_process"], param: "text", pattern: "\\b(rm|sudo|chmod|chown|mkfs|dd)\\b" },
  { tools: ["bash"], param: "command", pattern: "\\bgit\\s+(push|reset|checkout|rebase|clean)\\b" },
  { tools: ["write_to_process"], param: "text", pattern: "\\bgit\\s+(push|reset|checkout|rebase|clean)\\b" },
  { tools: ["bash"], param: "command", pattern: "\\b(npm|bun|yarn|pnpm)\\s+(install|add|remove)\\b" },
  { tools: ["write_to_process"], param: "text", pattern: "\\b(npm|bun|yarn|pnpm)\\s+(install|add|remove)\\b" },
  { tools: ["bash"], param: "command", pattern: "\\.[Ee][Nn][Vv]|id_rsa|\\.[Ss][Ss][Hh]" },
  { tools: ["write_to_process"], param: "text", pattern: "\\.[Ee][Nn][Vv]|id_rsa|\\.[Ss][Ss][Hh]" },
  // Sensitive paths reached through the edit tools, not only through a shell.
  { tools: ["write", "edit", "apply_patch"], param: "path", pattern: "\\.[Ee][Nn][Vv]|id_rsa|\\.[Ss][Ss][Hh]" },
  { tools: ["write", "edit", "apply_patch"], param: "file_path", pattern: "\\.[Ee][Nn][Vv]|id_rsa|\\.[Ss][Ss][Hh]" },
  { tools: ["apply_patch"], param: "patch", pattern: "\\*\\*\\* (?:Add|Update|Delete) File: .*?(?:\\.[Ee][Nn][Vv]|id_rsa|\\.[Ss][Ss][Hh])" },
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

  // Bypass is the user's explicit "do not ask" mode. A trusted workspace may
  // still prepend a deny/ask overlay through mergePolicies.
  if (mode !== "bypass") {
    for (const entry of HIGH_RISK_PATTERNS) {
      for (const tool of entry.tools) {
        rules.push({
          tool,
          match: { param: entry.param, pattern: entry.pattern },
          decision: "ask",
        });
      }
    }
  }

  // Dispatch askBefore rules (per-role) — must come BEFORE the
  // mutation-based dispatch:allow rule so they match first.
  for (const [role, ask] of Object.entries(askBefore)) {
    const literalRole = role.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    rules.push({
      tool: "dispatch",
      match: { param: "role", pattern: `^${literalRole}$` },
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
  if (!Array.isArray(user.rules)) {
    throw new PermissionPolicyValidationError("user permission rules must be an array");
  }
  if (workspace.rules !== undefined && !Array.isArray(workspace.rules)) {
    throw new PermissionPolicyValidationError("workspace permission rules must be an array");
  }
  const userMode = validatePermissionMode(user.mode, "user permission");
  const requestedMode = workspace.mode === undefined
    ? undefined
    : validatePermissionMode(workspace.mode, "workspace permission");
  const ranks: Record<Exclude<PermissionMode, "smart">, number> = {
    bypass: 0,
    "accept-edits": 1,
    normal: 2,
  };
  const mode = requestedMode === undefined
    ? userMode
    : requestedMode === "smart"
      ? userMode
      : userMode === "smart"
        ? requestedMode === "normal" ? "normal" : "smart"
        : ranks[requestedMode] > ranks[userMode] ? requestedMode : userMode;
  const userRules = user.rules.map((rule, index) => (
    validatePermissionRule(rule, `user permission[${index}]`)
  ));
  const workspaceRules = (workspace.rules ?? [])
    .map((rule, index) => validatePermissionRule(rule, `workspace permission[${index}]`))
    .filter((rule) => rule.decision !== "allow");
  return {
    mode,
    // A workspace constraint must run before user allows or it would not
    // tighten a first-match policy at all.
    rules: [...workspaceRules, ...userRules],
  };
}
