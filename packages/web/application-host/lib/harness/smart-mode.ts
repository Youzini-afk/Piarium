/**
 * Smart mode — model-judged permission decisions.
 *
 * Design: agent-harness.md §9.1.2
 * Plan: agent-harness-plan.md §3b.2
 *
 * Smart mode requires models.permissionJudge slot.
 * For 'ask' decisions, the model judges first (prompt fixed, output allow|ask).
 * High-risk categories ALWAYS ask, never go through model.
 */

import type { SlotResolution } from "./model-slots.js";
import { isHighRisk, type PermissionPolicy, evaluateGate, type GateResult } from "./permission-gate.js";

// ── Types ──────────────────────────────────────────────────────────

export interface SmartModeDeps {
  permissionJudgeModel: SlotResolution | null;
  /** Call the permission judge model */
  callJudge: (prompt: string) => Promise<"allow" | "ask">;
}

export const SMART_MODE_PROMPT = `You are a permission judge. Given the tool call and its parameters, decide if it should be allowed automatically or if the user should be asked. Respond with "allow" or "ask".`;

// ── Smart mode evaluation ──────────────────────────────────────────

export async function evaluateSmartMode(
  tool: string,
  params: Record<string, unknown>,
  policy: PermissionPolicy,
  deps: SmartModeDeps,
): Promise<GateResult> {
  // First, get the base decision from rules
  const baseResult = evaluateGate(tool, params, policy);

  // If already allow or deny, return as-is
  if (baseResult.decision === "allow" || baseResult.decision === "deny") {
    return baseResult;
  }

  // High-risk categories always ask, never go through model
  if (isHighRisk(tool, params)) {
    return { decision: "ask", reason: "high-risk category (always ask)" };
  }

  // If no model configured, Smart mode is not available → just ask
  if (!deps.permissionJudgeModel) {
    return { decision: "ask", reason: "smart mode: no permission judge model configured" };
  }

  // Ask the model
  const paramsStr = JSON.stringify(params, null, 2);
  const prompt = `${SMART_MODE_PROMPT}\n\nTool: ${tool}\nParameters: ${paramsStr}`;
  const modelDecision = await deps.callJudge(prompt);

  return {
    decision: modelDecision,
    reason: `smart mode: model judged ${modelDecision}`,
  };
}

// ── Availability check ─────────────────────────────────────────────

export function isSmartModeAvailable(permissionJudgeModel: SlotResolution | null): boolean {
  return permissionJudgeModel !== null;
}
