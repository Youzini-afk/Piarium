import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import {
  evaluateGate,
  defaultRules,
  type PermissionPolicy,
  type PermissionMode,
  type PermissionDecision,
} from "@piarium/protocol";
import { HARNESS_TOOL_META } from "@piarium/protocol";

/**
 * Permission gate extension — hooks tool_call to gate tool execution
 * based on the permission policy.
 *
 * Design: agent-harness.md §9.1.2
 * Plan: agent-harness-plan.md §3b.1
 *
 * The policy is resolved from HarnessSettings at session creation time
 * and frozen for the session lifetime.
 *
 * Decision flow:
 *   - allow → proceed
 *   - ask → show ui.select (Allow once / Allow for this session / Deny)
 *     - "Allow once" → proceed for this call only
 *     - "Allow for this session" → proceed and remember for this session
 *     - "Deny" or dialog dismissed → block
 *   - deny → block
 *
 * Only harness tools (those in HARNESS_TOOL_META) are gated. Non-harness
 * tools (MCP, Pi built-in) pass through to Pi's own permission system.
 */
export interface PermissionGateOptions {
  policy: PermissionPolicy;
}

const ALLOW_ONCE = "Allow once";
const ALLOW_SESSION = "Allow for this session";
const DENY = "Deny";

export function createPermissionGateExtension(options: PermissionGateOptions): ExtensionFactory {
  const { policy } = options;

  // Session-scoped "always allow" set — tools the user approved for
  // the entire session.
  const sessionAllow = new Set<string>();

  return (pi) => {
    pi.on("tool_call", async (event, ctx) => {
      const toolName = event.toolName;
      const params = event.input as Record<string, unknown>;

      // Non-harness tools: pass through (Pi's own permission system handles them)
      if (!HARNESS_TOOL_META[toolName]) {
        return undefined;
      }

      // Check session-scoped "always allow" first
      if (sessionAllow.has(toolName)) {
        return undefined;
      }

      const result = evaluateGate(toolName, params, policy);
      const decision: PermissionDecision = result.decision;

      if (decision === "allow") {
        return undefined; // Proceed normally
      }

      if (decision === "ask") {
        // Show interactive dialog
        const choice = await ctx.ui.select(
          `Allow ${toolName}?`,
          [ALLOW_ONCE, ALLOW_SESSION, DENY],
        );

        if (choice === ALLOW_ONCE) {
          return undefined; // Proceed for this call only
        }
        if (choice === ALLOW_SESSION) {
          sessionAllow.add(toolName);
          return undefined; // Proceed and remember
        }
        // Deny or dialog dismissed (undefined)
        return {
          block: true,
          reason: choice === DENY
            ? `User denied ${toolName}`
            : `Permission dialog dismissed for ${toolName}`,
        };
      }

      // deny
      return {
        block: true,
        reason: result.reason ?? `denied: ${toolName}`,
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
