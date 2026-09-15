import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import {
  defaultDecisionForAction,
  defaultRules,
  evaluateGate,
  isHighRisk,
  type GateResult,
  type PermissionAuditRecord,
  type PermissionDecision,
  type PermissionInspectResult,
  type PermissionMode,
  type PermissionPolicy,
} from "@piarium/protocol";
import type { HostServicesBridge } from "./host-services-bridge.js";
import {
  buildPermissionInspection,
  permissionGrantKey,
  permissionPolicyGeneration,
  type PiToolInfoLike,
} from "./permission-target.js";

/**
 * Piarium's sole interactive permission authority. Every concrete Pi tool call
 * reaches this hook, including Pi built-ins, Harness SDK overrides, MCP tools,
 * package tools, and nested-thread tools.
 */
export interface PermissionGateOptions {
  policy: PermissionPolicy;
  sessionId: string;
  cwd: string;
  bridge: Pick<HostServicesBridge, "request">;
  smartJudge?: (toolName: string, params: Record<string, unknown>) => Promise<"allow" | "ask">;
}

const ALLOW_ONCE = "Allow once";
const ALLOW_SESSION = "Allow for this session scope";
const DENY = "Deny";

const fallbackInspection = (
  candidate: ReturnType<typeof buildPermissionInspection>,
): PermissionInspectResult => ({
  tool: candidate.tool,
  source: candidate.source,
  action: candidate.action,
  executionWorkspaceId: null,
  owningWorkspaceId: null,
  cwd: candidate.cwd,
  paths: [],
  networkTargets: candidate.networkTargets,
  threadScopes: candidate.threadScopes,
  // A failed Host inspection is deliberately non-memorable and Smart-ineligible.
  evidenceComplete: false,
});

const summarizeTarget = (target: PermissionInspectResult): string => {
  if (target.paths.length > 0) {
    const first = target.paths[0]!.canonicalResourceId;
    return target.paths.length === 1 ? first : `${first} (+${target.paths.length - 1})`;
  }
  if (target.networkTargets.length > 0) return target.networkTargets.join(", ");
  if (target.threadScopes.length > 0) return target.threadScopes.join(", ");
  return target.cwd;
};

const buildDialogTitle = (target: PermissionInspectResult): string => {
  const source = target.source.kind === "harness" || target.source.kind === "builtin"
    ? target.source.kind
    : `${target.source.kind} tool`;
  const scope = summarizeTarget(target);
  return `Allow ${source} ${target.tool} (${target.action})${scope ? `: ${scope}` : ""}`;
};

const audit = async (
  bridge: Pick<HostServicesBridge, "request">,
  record: PermissionAuditRecord,
  signal?: AbortSignal,
): Promise<void> => {
  try {
    await bridge.request("permission.audit", record, signal ? { signal } : undefined);
  } catch {
    // Audit projection must never rewrite an already-made user decision.
  }
};

export function createPermissionGateExtension(options: PermissionGateOptions): ExtensionFactory {
  const { policy } = options;
  const policyGeneration = permissionPolicyGeneration(policy);
  const sessionAllow = new Map<string, string>();

  return (pi) => {
    pi.registerCommand("piarium-permissions", {
      description: "Review or revoke Piarium session-scoped tool approvals",
      handler: async (_args, ctx) => {
        if (sessionAllow.size === 0) {
          ctx.ui.notify("No Piarium session-scoped approvals are active.", "info");
          return;
        }
        const revokeAll = "Revoke all session approvals";
        const entries = [...sessionAllow.entries()];
        const labels = entries.map(([, label], index) => `Revoke ${index + 1}: ${label}`);
        const choice = await ctx.ui.select("Piarium session approvals", [revokeAll, ...labels, "Cancel"]);
        if (choice === revokeAll) {
          sessionAllow.clear();
          ctx.ui.notify("Revoked all Piarium session approvals.", "info");
          return;
        }
        const index = labels.indexOf(choice ?? "");
        if (index >= 0) {
          const key = entries[index]?.[0];
          if (key) sessionAllow.delete(key);
          ctx.ui.notify("Revoked the selected Piarium session approval.", "info");
        }
      },
    });
    pi.on("tool_call", async (event, ctx) => {
      const toolName = event.toolName;
      const params = event.input as Record<string, unknown>;
      const tool = pi.getAllTools().find((candidate) => candidate.name === toolName) as PiToolInfoLike | undefined;
      const candidate = buildPermissionInspection({
        cwd: ctx.cwd || options.cwd,
        toolName,
        params,
        tool,
      });

      let target: PermissionInspectResult;
      try {
        target = await options.bridge.request(
          "permission.inspect",
          candidate,
          ctx.signal ? { signal: ctx.signal } : undefined,
        );
      } catch {
        target = fallbackInspection(candidate);
      }

      let result: GateResult = evaluateGate(toolName, params, policy);
      if (target.action === "unknown" && policy.mode !== "bypass") {
        result = { decision: "ask", reason: "unknown third-party action requires confirmation" };
      }
      if (result.reason === "unknown tool requires confirmation") {
        result = {
          decision: defaultDecisionForAction(target.action, policy.mode),
          reason: `normalized ${target.action} action`,
        };
      }

      const highRisk = isHighRisk(toolName, params)
        || !target.evidenceComplete
        || target.action === "unknown";
      if (
        policy.mode === "smart"
        && result.decision === "ask"
        && !highRisk
        && options.smartJudge
      ) {
        try {
          const judged = await options.smartJudge(toolName, params);
          result = { decision: judged, reason: `smart mode: model judged ${judged}` };
        } catch {
          result = { decision: "ask", reason: "smart mode judge failed" };
        }
      }

      const grantKey = permissionGrantKey(target);
      if (result.decision === "ask" && !highRisk && sessionAllow.has(grantKey)) {
        await audit(options.bridge, {
          decision: "allow",
          prompted: false,
          remembered: true,
          policyGeneration,
          target,
          reason: "session-scoped grant",
        }, ctx.signal);
        return undefined;
      }

      const finish = async (
        decision: PermissionDecision,
        prompted: boolean,
        remembered: boolean,
        reason?: string,
      ) => {
        await audit(options.bridge, {
          decision,
          prompted,
          remembered,
          policyGeneration,
          target,
          ...(reason ? { reason } : {}),
        }, ctx.signal);
        if (decision === "deny") {
          return { block: true, reason: reason ?? `denied: ${toolName}` };
        }
        return undefined;
      };

      if (result.decision === "deny") return finish("deny", false, false, result.reason);
      if (result.decision === "allow") return finish("allow", false, false, result.reason);

      const choice = await ctx.ui.select(
        buildDialogTitle(target),
        highRisk ? [ALLOW_ONCE, DENY] : [ALLOW_ONCE, ALLOW_SESSION, DENY],
        ctx.signal ? { signal: ctx.signal } : undefined,
      );
      if (choice === ALLOW_ONCE) return finish("allow", true, false, result.reason);
      if (choice === ALLOW_SESSION && !highRisk) {
        sessionAllow.set(grantKey, `${target.source.id} · ${target.action} · ${summarizeTarget(target)}`);
        return finish("allow", true, true, result.reason);
      }
      return finish(
        "deny",
        true,
        false,
        choice === DENY ? `User denied ${toolName}` : `Permission dialog dismissed for ${toolName}`,
      );
    });
  };
}

/** Build a PermissionPolicy from HarnessSettings. */
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
