import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { HostServicesBridge } from "./host-services-bridge.js";

const ExploreParams = Type.Object({
  question: Type.String({ description: "What you want to find or understand in the codebase" }),
  anchors: Type.Optional(Type.Array(Type.String({ minLength: 1 }), {
    description: "Known symbols, method names, error text, or path fragments. Matched literally and prioritized; not a hard filter.",
  })),
  paths: Type.Optional(Type.Array(Type.String(), { description: "Optional subpaths or directories to restrict search to" })),
  limit: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum number of excerpts to return (default 20)" })),
});

export function createExploreTool(bridge: HostServicesBridge, _sessionId: string): ToolDefinition {
  return defineTool({
    name: "explore",
    label: "Explore",
    description: "Locate relevant code and read the related context in the same call (definitions, registration sites, callers, and the excerpts needed to judge). Use grep when you only need an exact match. Put known symbols, method names, error text, and path fragments in anchors. Natural-language questions are matched as repository vocabulary literals; without anchors or an explore model, conceptual cross-language questions may find nothing.",
    promptSnippet: "explore: locate and read related context in one call; put known symbols, method names, error text, and path fragments in anchors; use grep for exact match only",
    promptGuidelines: [
      "Use explore to locate code and read the related context (definitions, registration sites, callers, and excerpts needed to judge) in one call.",
      "Use grep when you only need exact matches.",
      "Put known symbols, method names, error text, and path fragments in anchors.",
      "Natural-language questions match repository vocabulary literally. Without anchors or an explore model, conceptual cross-language questions may find nothing.",
    ],
    parameters: ExploreParams,
    executionMode: "parallel",
    execute: async (_toolCallId, params, signal, _onUpdate, _ctx) => {
      try {
        const result = await bridge.request<"explore.search">(
          "explore.search",
          {
            question: params.question,
            ...(params.anchors ? { anchors: params.anchors } : {}),
            ...(params.paths ? { paths: params.paths } : {}),
            ...(params.limit ? { limit: params.limit } : {}),
          },
          ...(signal ? [{ signal }] : []),
        );
        return {
          content: [{ type: "text", text: result.text }],
          details: {
            snippets: result.snippets,
            searched: result.searched,
            handle: result.handle,
            issues: result.issues,
            partial: result.partial,
            notRequested: result.notRequested,
            omitted: result.omitted,
            provenance: result.details,
          },
        };
      } catch (error) {
        signal?.throwIfAborted();
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `explore failed: ${message}` }],
          details: { error: message },
          isError: true,
        };
      }
    },
  });
}
