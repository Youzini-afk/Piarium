import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { HostServicesBridge } from "./host-services-bridge.js";
import type { SearchContentResult } from "@piarium/protocol";

const GrepParams = Type.Object({
  pattern: Type.String(),
  path: Type.Optional(Type.String()),
  glob: Type.Optional(Type.Array(Type.String())),
  type: Type.Optional(Type.String()),
  ignoreCase: Type.Optional(Type.Boolean()),
  fixedStrings: Type.Optional(Type.Boolean()),
  before: Type.Optional(Type.Integer({ minimum: 0 })),
  after: Type.Optional(Type.Integer({ minimum: 0 })),
  context: Type.Optional(Type.Integer({ minimum: 0 })),
  mode: Type.Optional(Type.Union([
    Type.Literal("content"),
    Type.Literal("files"),
    Type.Literal("count"),
  ])),
  limit: Type.Optional(Type.Integer({ minimum: 1 })),
});

function formatSearchResult(result: SearchContentResult, pattern: string): string {
  if (result.status === "empty") {
    return `0 hits (searched ${result.searchedFiles} files)`;
  }
  if (result.status === "unavailable") {
    return `search unavailable`;
  }
  // ready
  const partialSuffix = result.partial ? " (search incomplete: timed out)" : "";
  const lines: string[] = [`${result.totalHits} hits in ${result.totalFiles} files for ${pattern}${partialSuffix}`, ""];

  for (const file of result.files) {
    lines.push(file.path);
    for (const hit of file.hits) {
      lines.push(`  ${hit.line}: ${hit.text}`);
    }
  }

  // If there are more hits than shown, add handle annotation
  const shownHits = result.files.reduce((sum, f) => sum + f.hits.length, 0);
  if (shownHits < result.totalHits && result.handle) {
    const remaining = result.totalHits - shownHits;
    const moreFiles = result.totalFiles - result.files.length;
    lines.push(`\n[${remaining} more hits in ${moreFiles} files — get_output("${result.handle}") or narrow with glob/path]`);
  }

  return lines.join("\n");
}

export function createGrepTool(bridge: HostServicesBridge, sessionId: string): ToolDefinition {
  return defineTool({
    name: "grep",
    label: "Grep",
    description: "Search file contents with ripgrep semantics",
    promptSnippet: "grep: search file contents with ripgrep semantics",
    promptGuidelines: [
      "Use grep to search file contents. Prefer it over shell grep or rg.",
      "A non-zero exit or empty result is a result, not an error.",
    ],
    parameters: GrepParams,
    executionMode: "sequential",
    execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
      try {
        const result = await bridge.request("search.content", {
          pattern: params.pattern,
          ...(params.path !== undefined ? { path: params.path } : {}),
          ...(params.glob !== undefined ? { glob: params.glob } : {}),
          ...(params.type !== undefined ? { type: params.type } : {}),
          ...(params.ignoreCase !== undefined ? { ignoreCase: params.ignoreCase } : {}),
          ...(params.fixedStrings !== undefined ? { fixedStrings: params.fixedStrings } : {}),
          ...(params.before !== undefined ? { before: params.before } : {}),
          ...(params.after !== undefined ? { after: params.after } : {}),
          ...(params.context !== undefined ? { context: params.context } : {}),
          ...(params.mode !== undefined ? { mode: params.mode } : {}),
          ...(params.limit !== undefined ? { limit: params.limit } : {}),
        });
        const text = formatSearchResult(result, params.pattern);
        return {
          content: [{ type: "text", text }],
          details: { status: result.status, totalHits: result.totalHits, totalFiles: result.totalFiles, partial: result.partial },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `search failed: ${message}` }],
          details: { status: "unavailable", totalHits: 0, totalFiles: 0, partial: false },
        };
      }
    },
  });
}
