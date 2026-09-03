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
 *
 * Pure types and evaluation functions are in @piarium/protocol
 * (permission-gate.ts) so both pi-host and web host can use them
 * without cross-package imports.
 */

export {
  type PermissionMode,
  type PermissionDecision,
  type PermissionRule,
  type PermissionPolicy,
  type GateResult,
  evaluateGate,
  defaultRules,
  mergePolicies,
} from "@piarium/protocol";

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
