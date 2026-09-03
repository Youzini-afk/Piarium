import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { HostServicesBridge } from "./host-services-bridge.js";

const WebSearchParams = Type.Object({
  query: Type.String(),
  allowed_domains: Type.Optional(Type.Array(Type.String())),
  blocked_domains: Type.Optional(Type.Array(Type.String())),
  recency: Type.Optional(Type.Union([
    Type.Literal("day"),
    Type.Literal("week"),
    Type.Literal("month"),
    Type.Literal("year"),
  ])),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
});

export function createWebSearchTool(bridge: HostServicesBridge, sessionId: string): ToolDefinition {
  return defineTool({
    name: "websearch",
    label: "Web Search",
    description: "Search the web and return results. Uses the session model's built-in search if available, otherwise a configured search API provider. Returns title, URL, and snippet for each result. Does not fetch page content — use webfetch for that.",
    promptSnippet: "websearch: search the web for current information",
    promptGuidelines: [
      "Use websearch to find current information. Follow up with webfetch to read specific pages.",
      "Results are summaries — always verify important claims by reading the source page.",
      "Domain filters (allowed_domains / blocked_domains) restrict results to/from specific sites.",
    ],
    parameters: WebSearchParams,
    execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
      try {
        const result = await bridge.request("web.search", {
          query: params.query,
          ...(params.allowed_domains ? { allowedDomains: params.allowed_domains } : {}),
          ...(params.blocked_domains ? { blockedDomains: params.blocked_domains } : {}),
          ...(params.recency ? { recency: params.recency } : {}),
          ...(params.limit ? { limit: params.limit } : {}),
        });

        if (result.providerId === "none" || result.results.length === 0) {
          return {
            content: [{
              type: "text",
              text: `no search provider configured; add one in Settings → Agent harness → Web`,
            }],
            details: { kind: "websearch", providerId: result.providerId, count: 0 },
            isError: true,
          };
        }

        const lines: string[] = [
          `${result.results.length} results for "${params.query}" (${result.providerId})`,
        ];
        for (const item of result.results) {
          lines.push(`- ${item.title}`);
          lines.push(`  ${item.url}`);
          lines.push(`  ${item.snippet}`);
        }

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: { kind: "websearch", providerId: result.providerId, count: result.results.length },
        };
      } catch (error) {
        return {
          content: [{
            type: "text",
            text: `websearch error: ${error instanceof Error ? error.message : String(error)}`,
          }],
          details: { kind: "websearch", providerId: "error", count: 0 },
          isError: true,
        };
      }
    },
  });
}
