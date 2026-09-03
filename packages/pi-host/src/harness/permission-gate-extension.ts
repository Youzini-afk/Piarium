import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import {
  evaluateGate,
  defaultRules,
  type PermissionPolicy,
  type PermissionMode,
} from "@piarium/protocol";

/**
 * Permission gate extension — hooks tool_call to gate tool execution
 * based on the permission policy.
 *
 * Design: agent-harness.md §9.1.2
 * Plan: agent-harness-plan.md §3b.1
 *
 * The policy is resolved from HarnessSettings at session creation time
 * and frozen for the session lifetime. The gate evaluates rules top-down:
 *   - allow → proceed
 *   - ask → block with reason (the host UI handles the ask flow)
 *   - deny → block with reason
 *
 * In smart mode, the host evaluates the model judge before returning.
 * The extension requests the gate decision from the host via
 * bridge.request("permission.gate", ...).
 *
 * For simplicity, the policy is passed directly to the extension factory
 * (resolved from settings at session creation). This avoids a round-trip
 * to the host for every tool call.
 */
export interface PermissionGateOptions {
  policy: PermissionPolicy;
}

export function createPermissionGateExtension(options: PermissionGateOptions): ExtensionFactory {
  const { policy } = options;

  return (pi) => {
    pi.on("tool_call", async (event) => {
      const toolName = event.toolName;
      const params = event.input as Record<string, unknown>;

      const result = evaluateGate(toolName, params, policy);

      if (result.decision === "allow") {
        return undefined; // Proceed normally
      }

      // Block the tool call — the host UI handles the ask/deny flow
      return {
        block: true,
        reason: result.reason ?? `${result.decision}: ${toolName}`,
        terminate: result.decision === "deny",
      };
    });
  };
}

/**
 * Build a PermissionPolicy from HarnessSettings.
 */
export function buildPermissionPolicy(
  mode: PermissionMode,
  askBefore: Record<string, boolean> = {},
  customRules?: PermissionPolicy["rules"],
): PermissionPolicy {
  if (customRules && customRules.length > 0) {
    return { mode, rules: customRules };
  }
  return { mode, rules: defaultRules(mode, askBefore) };
}
