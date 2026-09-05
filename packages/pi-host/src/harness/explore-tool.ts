import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { HostServicesBridge } from "./host-services-bridge.js";

const ExploreParams = Type.Object({
  question: Type.String({ description: "Open question or code pattern to search for across the codebase" }),
  paths: Type.Optional(Type.Array(Type.String(), { description: "Optional subpaths or directories to restrict search to" })),
  limit: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum number of excerpts to return (default 20)" })),
});

export function createExploreTool(bridge: HostServicesBridge, _sessionId: string): ToolDefinition {
  return defineTool({
    name: "explore",
    label: "Explore",
    description: "Search code using question terms and return current, versioned document excerpts with source gaps when a file cannot be read.",
    promptSnippet: "explore: locate code and read current matching regions with source revisions",
    promptGuidelines: [
      "Use explore to locate relevant symbols, concepts, and code regions when asking broad questions about the codebase.",
    ],
    parameters: ExploreParams,
    executionMode: "parallel",
    execute: async (_toolCallId, params, signal, _onUpdate, _ctx) => {
      try {
        const result = await bridge.request<"explore.search">(
          "explore.search",
          {
            question: params.question,
            ...(params.paths ? { paths: params.paths } : {}),
            ...(params.limit ? { limit: params.limit } : {}),
          },
          ...(signal ? [{ signal }] : []),
        );
        return {
          content: [{ type: "text", text: result.text }],
          details: { snippets: result.snippets, searched: result.searched, handle: result.handle, issues: result.issues, partial: result.partial },
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
