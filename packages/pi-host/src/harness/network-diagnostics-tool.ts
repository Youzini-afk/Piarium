import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { HostServicesBridge } from "./host-services-bridge.js";
import type { NetworkDiagnosisResult } from "@varin/protocol";

const NetworkDiagParams = Type.Object({
  url: Type.String({ description: "URL to probe, e.g. https://example.com/path" }),
});

const formatDiagnosis = (r: NetworkDiagnosisResult): string => {
  const lines: string[] = [];
  lines.push(`decision: ${r.decision}${r.reason ? ` (${r.reason})` : ""}`);
  const proxyBits = r.policy.mode === "proxy"
    ? `proxy ${r.policy.proxyOrigin ?? "?"}${r.policy.proxyAuth ? ` (${r.policy.proxyAuth} auth)` : ""}`
    : "direct";
  lines.push(`egress: ${proxyBits} [policy ${r.policy.source}]${r.policy.invalid ? ` INVALID: ${r.policy.invalid}` : ""}`);
  if (r.policy.noProxy.length > 0) lines.push(`no_proxy entries: ${r.policy.noProxy.join(", ")}`);
  if (r.resolution === "proxy-side") {
    lines.push("resolution: target name resolves inside the proxy — local DNS does not decide reachability");
  } else if (r.addresses?.length) {
    lines.push(`resolution: ${r.addresses.map((a) => `${a.address}(${a.class})`).join(", ")}`);
  }
  if (r.lookupError) lines.push(`local lookup: ${r.lookupError}`);
  return lines.join("\n");
};

/**
 * Read-only outbound-network diagnostics: reports the effective egress
 * policy, the static allow/block decision, and how the target resolves
 * (local classes or proxy-side). It never performs the fetch and never
 * mutates proxy or credential settings.
 */
export function createNetworkDiagnosticsTool(bridge: HostServicesBridge): ToolDefinition {
  return defineTool({
    name: "network_diag",
    label: "Network Diagnostics",
    description:
      "Probe how an outbound request would leave the host: effective egress policy (proxy/direct, " +
      "NO_PROXY), the allow/block decision, and whether the target resolves locally or inside the " +
      "proxy. Read-only — never fetches the URL and never changes system/proxy settings.",
    promptSnippet: "network_diag: inspect outbound network policy and resolution for a URL (read-only)",
    promptGuidelines: [
      "Use network_diag before retrying a failed webfetch/websearch to learn whether the failure is DNS, proxy, TLS, or a policy block.",
      "Reported proxyOrigin is sanitized (no credentials); the tool cannot change proxy or credential settings.",
    ],
    parameters: NetworkDiagParams,
    executionMode: "parallel",
    execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
      try {
        const result = await bridge.request("network.diagnose", { url: params.url });
        return {
          content: [{ type: "text", text: formatDiagnosis(result) }],
          details: { kind: "network_diag", status: result.decision },
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `network_diag error: ${error instanceof Error ? error.message : String(error)}` }],
          details: { kind: "network_diag", status: "failed" },
        };
      }
    },
  });
}
