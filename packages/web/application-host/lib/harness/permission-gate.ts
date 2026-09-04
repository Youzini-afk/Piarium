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
  isHighRisk,
  HIGH_RISK_PATTERNS,
} from "@piarium/protocol";
