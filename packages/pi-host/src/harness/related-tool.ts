import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { HostServicesBridge } from "./host-services-bridge.js";

const RelatedParams = Type.Object({
  anchor: Type.String({
    description: "Workspace path or symbol / connection-literal name. related answers file-level imports and connection endpoints, not who-references-this-symbol.",
  }),
});

export function createRelatedTool(bridge: HostServicesBridge, _sessionId: string): ToolDefinition {
  return defineTool({
    name: "related",
    label: "Related",
    description: "File-level topology from the symbol graph: what a path or symbol defines, what it imports, who imports it, and the other ends of its connection literals. This is not lsp.references — references answers who cites a symbol at a position and needs a language server; related answers import topology and register/request-style links and does not need a language server.",
    promptSnippet: "related: file-level imports and connection endpoints from the symbol graph; use lsp.references for precise symbol references",
    promptGuidelines: [
      "Use related for file-level import topology and connection-literal endpoints (register/request/on/emit).",
      "Use lsp.references when you need precise who-references-this-symbol at a position. related is not a weaker references.",
      "Pass a workspace path or a symbol / connection-literal name. Graph ranges are hints only; read current text to confirm.",
    ],
    parameters: RelatedParams,
    executionMode: "parallel",
    execute: async (_toolCallId, params, signal, _onUpdate, _ctx) => {
      try {
        const result = await bridge.request<"related.query">(
          "related.query",
          { anchor: params.anchor },
          ...(signal ? [{ signal }] : []),
        );
        return {
          content: [{ type: "text", text: result.text }],
          details: {
            status: result.status,
            anchor: result.anchor,
            definitions: result.definitions,
            imports: result.imports,
            importers: result.importers,
            connections: result.connections,
          },
        };
      } catch (error) {
        signal?.throwIfAborted();
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `related failed: ${message}` }],
          details: { error: message },
          isError: true,
        };
      }
    },
  });
}
