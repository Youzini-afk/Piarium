import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ScholarlySearchResult } from "@varin/protocol";
import { HarnessRequestError, type HostServicesBridge } from "./host-services-bridge.js";

const ResearchSearchParams = Type.Object({
  action: Type.Union([Type.Literal("search"), Type.Literal("paper")]),
  provider: Type.Optional(Type.Union([Type.Literal("openalex"), Type.Literal("semantic-scholar")])),
  query: Type.Optional(Type.String()),
  paper_id: Type.Optional(Type.String()),
  cursor: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Integer({ minimum: 1 })),
});

const encode = (value: string): string => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

type ResearchSearchDetails = {
  kind: "research-search";
  status: ScholarlySearchResult["status"];
  provider?: string;
  action?: string;
  papers: unknown[] | number;
  capabilities?: string[];
  nextCursor?: string;
};

const details = (value: ResearchSearchDetails): ResearchSearchDetails => value;

const formatPaper = (paper: ScholarlySearchResult["papers"][number], index?: number): string => {
  const prefix = index === undefined ? "" : `${index + 1}. `;
  const lines = [`${prefix}${encode(paper.title)} [${paper.provider}:${paper.id}]`];
  if (paper.year !== undefined) lines.push(`   Year: ${paper.year}`);
  if (paper.authors.length) lines.push(`   Authors: ${paper.authors.slice(0, 8).map((author) => encode(author.name)).join(", ")}`);
  if (paper.doi) lines.push(`   DOI: ${encode(paper.doi)}`);
  if (paper.landingUrl) lines.push(`   URL: ${paper.landingUrl}`);
  if (paper.openAccessUrl) lines.push(`   Open access: ${paper.openAccessUrl}`);
  lines.push(`   Content: ${paper.content}`);
  if (paper.abstract) lines.push(`   Abstract: ${encode(paper.abstract)}`);
  return lines.join("\n");
};

export function createResearchSearchTool(bridge: HostServicesBridge): ToolDefinition {
  return defineTool({
    name: "research_search",
    label: "Research Search",
    description: "Search scholarly metadata or look up one paper through OpenAlex or Semantic Scholar. Metadata discovery is separate from reading the linked source.",
    promptSnippet: "research_search: find papers, metadata, and open-access locations",
    promptGuidelines: [
      "Use action=search with a focused query; use the returned provider id with action=paper to inspect one record.",
      "Metadata, an open-access URL, and read content are separate states. Fetch the linked source before relying on paper details.",
      "Use cursor for the provider's next page when it is returned. Preserve provider ids and versions when handing papers to another thread.",
    ],
    parameters: ResearchSearchParams,
    executionMode: "parallel",
    execute: async (_toolCallId, params, signal) => {
      try {
        const result = await bridge.request("research.search", {
          action: params.action,
          ...(params.provider ? { provider: params.provider } : {}),
          ...(params.query ? { query: params.query } : {}),
          ...(params.paper_id ? { paperId: params.paper_id } : {}),
          ...(params.cursor ? { cursor: params.cursor } : {}),
          ...(params.limit ? { limit: params.limit } : {}),
        }, signal ? { signal } : undefined) as ScholarlySearchResult;
        if (result.status === "failed" || result.status === "unavailable") {
          return {
            content: [{ type: "text", text: `research_search ${result.status}: ${result.message ?? "no further detail"}` }],
            details: details({ kind: "research-search", status: result.status, provider: result.provider, papers: 0, capabilities: result.capabilities }),
            isError: result.status === "failed",
          };
        }
        const header = `${result.status === "empty" ? "No papers" : `${result.papers.length} papers`} (${result.provider}, ${result.action})`;
        const body = result.papers.map((paper, index) => formatPaper(paper, index)).join("\n");
        const next = result.nextCursor ? `\nNext cursor: ${result.nextCursor}` : "";
        return {
          content: [{ type: "text", text: `${header}${body ? `\n${body}` : ""}${next}\nMetadata is not paper content; use webfetch on a trusted landing/open-access URL to read it.` }],
          details: details({
            kind: "research-search",
            status: result.status,
            provider: result.provider,
            action: result.action,
            papers: result.papers.map((paper) => ({ id: paper.id, title: paper.title, provider: paper.provider, content: paper.content, ...(paper.openAccessUrl ? { openAccessUrl: paper.openAccessUrl } : {}) })),
            capabilities: result.capabilities,
            ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
          }),
        };
      } catch (error) {
        const unavailable = error instanceof HarnessRequestError && error.code === "unavailable";
        return {
          content: [{ type: "text", text: `research_search ${unavailable ? "unavailable" : "error"}: ${error instanceof Error ? error.message : String(error)}` }],
          details: details({ kind: "research-search", status: unavailable ? "unavailable" : "failed", papers: 0 }),
          isError: !unavailable,
        };
      }
    },
  });
}
