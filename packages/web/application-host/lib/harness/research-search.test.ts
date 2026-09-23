import { describe, expect, it, vi } from "vitest";
import type { HarnessServiceContext } from "./router.js";
import { createResearchSearchService } from "./research-search.js";

const context: HarnessServiceContext = {
  actor: {
    authorityInstanceId: "host",
    sessionId: "session",
    workerId: "worker",
    workerGeneration: 1,
    workspaceId: "workspace",
    grantedCapabilities: ["read.web"],
  },
  authorizedPaths: [],
  sessionId: "session",
  workspaceId: "workspace",
  signal: new AbortController().signal,
};

const json = (value: unknown): Response => new Response(JSON.stringify(value), {
  status: 200,
  headers: { "content-type": "application/json" },
});

describe("scholarly search service", () => {
  it("normalizes OpenAlex metadata without treating it as read content", async () => {
    const fetch = vi.fn(async (input: Parameters<typeof globalThis.fetch>[0]) => {
      expect(String(input)).toContain("api.openalex.org/works");
      expect(new URL(String(input)).searchParams.get("search")).toBe("agent retrieval");
      return json({
        meta: { next_cursor: "next-page" },
        results: [{
          id: "https://openalex.org/W1",
          title: "A paper",
          publication_year: 2025,
          abstract_inverted_index: { Agent: [1], Retrieval: [0] },
          authorships: [{ author: { id: "A1", display_name: "Ada" } }],
          doi: "https://doi.org/10.1234/example",
          primary_location: { landing_page_url: "https://example.org/paper", pdf_url: "https://example.org/paper.pdf" },
          cited_by_count: 3,
        }],
      });
    });
    const service = createResearchSearchService({ fetch });
    const result = await service.handle({ action: "search", query: "agent retrieval" }, context);
    expect(result.status).toBe("ok");
    expect(result.nextCursor).toBe("next-page");
    expect(result.papers[0]).toMatchObject({
      id: "https://openalex.org/W1",
      title: "A paper",
      abstract: "Retrieval Agent",
      doi: "10.1234/example",
      content: "open-location",
    });
  });

  it("keeps provider errors distinct from an empty search", async () => {
    const empty = createResearchSearchService({ fetch: vi.fn(async () => json({ data: [] })) });
    await expect(empty.handle({ action: "search", provider: "semantic-scholar", query: "no match" }, context)).resolves.toMatchObject({
      status: "empty",
      provider: "semantic-scholar",
      papers: [],
    });
    const failed = createResearchSearchService({ fetch: vi.fn(async () => new Response("no", { status: 503 })) });
    await expect(failed.handle({ action: "paper", provider: "openalex", paperId: "W1" }, context)).resolves.toMatchObject({
      status: "failed",
      provider: "openalex",
      papers: [],
      message: expect.stringContaining("HTTP 503"),
    });
  });
});
