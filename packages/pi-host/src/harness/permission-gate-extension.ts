import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import {
  evaluateGate,
  isHighRisk,
  defaultRules,
  type PermissionPolicy,
  type PermissionMode,
  type PermissionDecision,
  type GateResult,
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
 * A session-scoped grant never covers a high-risk call (§3b.2): approving
 * `bash` for the session must not also approve `rm -rf` or a write into
 * `.ssh`. Those are asked every time and never remembered.
 *
 * Only harness tools (those in HARNESS_TOOL_META) are gated. Non-harness
 * tools (MCP, Pi built-in) pass through to Pi's own permission system.
 */
export interface PermissionGateOptions {
  policy: PermissionPolicy;
  sessionId: string;
  smartJudge?: (toolName: string, params: Record<string, unknown>) => Promise<"allow" | "ask">;
  onExternalGateDetected?: () => void;
}

const ALLOW_ONCE = "Allow once";
const ALLOW_SESSION = "Allow for this session";
const DENY = "Deny";
const PERMISSION_SERVICES_KEY = Symbol.for("@gotgenes/pi-permission-system:session-services");

const hasPublishedPermissionService = (sessionId: string): boolean => {
  const value = (globalThis as Record<symbol, unknown>)[PERMISSION_SERVICES_KEY];
  return value instanceof Map && value.has(sessionId);
};

const hasSessionServiceRegistry = (): boolean => (
  (globalThis as Record<symbol, unknown>)[PERMISSION_SERVICES_KEY] instanceof Map
);

export function createPermissionGateExtension(options: PermissionGateOptions): ExtensionFactory {
  const { policy } = options;

  // Session-scoped "always allow" set — tools the user approved for
  // the entire session.
  const sessionAllow = new Set<string>();
  let externalGateReported = false;
  let legacyExternalGateActive = false;

  const externalGateActive = (): boolean => {
    const active = legacyExternalGateActive || hasPublishedPermissionService(options.sessionId);
    if (active && !externalGateReported) {
      externalGateReported = true;
      options.onExternalGateDetected?.();
    }
    return active;
  };

  return (pi) => {
    pi.events.on("permissions:ready", (value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return;
      const sessionId = (value as Record<string, unknown>).sessionId;
      if (sessionId !== options.sessionId) return;
      // Releases before the session-keyed service locator announced their
      // presence only through this session-local event. Support them without
      // treating a missing entry in a modern registry as an active service.
      if (!hasSessionServiceRegistry()) legacyExternalGateActive = true;
      externalGateActive();
    });
    pi.on("tool_call", async (event, ctx) => {
      const toolName = event.toolName;
      const params = event.input as Record<string, unknown>;

      // Non-harness tools: pass through (Pi's own permission system handles them)
      if (!HARNESS_TOOL_META[toolName]) {
        return undefined;
      }

      // The mature permission-system package is the sole gate when this exact
      // session currently publishes its service. Resolve on every call so a
      // sibling session cannot trigger yielding and hot-unload restores the
      // Harness-only fallback without restarting the worker.
      if (externalGateActive()) return undefined;

      let result: GateResult = evaluateGate(toolName, params, policy);
      if (
        policy.mode === "smart"
        && result.decision === "ask"
        && !isHighRisk(toolName, params)
        && options.smartJudge
      ) {
        try {
          const judged = await options.smartJudge(toolName, params);
          result = { decision: judged, reason: `smart mode: model judged ${judged}` };
        } catch {
          result = { decision: "ask", reason: "smart mode judge failed" };
        }
      }
      const decision: PermissionDecision = result.decision;

      if (decision === "deny") {
        return { block: true, reason: result.reason ?? `denied: ${toolName}` };
      }
      if (decision === "allow") {
        // An explicit allow — a mutation:none tool, an accept-edits/bypass
        // mode, or a rule the user wrote. High-risk categories already
        // evaluate to "ask" through defaultRules in every mode but bypass,
        // and bypass is the user saying "stop asking me".
        return undefined;
      }

      // decision === "ask". A session-scoped grant covers it, except for
      // high-risk categories: "allow bash for this session" must not also
      // approve `rm -rf` or a write into `.ssh`.
      const highRisk = isHighRisk(toolName, params);
      if (!highRisk && sessionAllow.has(toolName)) {
        return undefined;
      }

      const choice = await ctx.ui.select(
        buildDialogTitle(toolName, params),
        [ALLOW_ONCE, ALLOW_SESSION, DENY],
      );

      if (choice === ALLOW_ONCE) {
        return undefined;
      }
      if (choice === ALLOW_SESSION) {
        // High-risk calls are approved once and never remembered.
        if (!highRisk) sessionAllow.add(toolName);
        return undefined;
      }
      return {
        block: true,
        reason: choice === DENY
          ? `User denied ${toolName}`
          : `Permission dialog dismissed for ${toolName}`,
      };
    });
  };
}

/**
 * Build a dialog title with key parameters for the tool call.
 * Shows the first line of bash command, the path for edit/write,
 * or the role for dispatch.
 */
function buildDialogTitle(toolName: string, params: Record<string, unknown>): string {
  if (toolName === "bash" || toolName === "write_to_process") {
    const command = params[toolName === "bash" ? "command" : "text"];
    if (typeof command === "string") {
      const firstLine = command.split("\n")[0] ?? command;
      const truncated = firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine;
      return `Allow ${toolName}: ${truncated}`;
    }
  }
  if (toolName === "edit" || toolName === "write" || toolName === "apply_patch") {
    const path = params["path"] ?? params["file_path"];
    if (typeof path === "string") {
      return `Allow ${toolName}: ${path}`;
    }
  }
  if (toolName === "dispatch") {
    const role = params["role"];
    if (typeof role === "string") {
      const task = params["task"];
      const taskStr = typeof task === "string" ? ` — ${task.split("\n")[0]?.slice(0, 60) ?? ""}` : "";
      return `Allow dispatch (${role})${taskStr}`;
    }
  }
  return `Allow ${toolName}?`;
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
    return { mode, rules: [...customRules, ...defaultRules(mode, askBefore)] };
  }
  return { mode, rules: defaultRules(mode, askBefore) };
}
