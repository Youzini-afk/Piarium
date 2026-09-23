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

  it("expands OpenAlex references one resolved page at a time", async () => {
    const requested: string[] = [];
    const fetch = vi.fn(async (input: Parameters<typeof globalThis.fetch>[0]) => {
      const url = new URL(String(input));
      requested.push(`${url.pathname}${url.search ? `?${url.searchParams.get("filter") ?? ""}` : ""}`);
      if (url.pathname === "/works/W9") {
        return json({
          id: "https://openalex.org/W9",
          title: "Source work",
          doi: "https://doi.org/10.1/source",
          referenced_works: ["https://openalex.org/W1", "https://openalex.org/W2", "https://openalex.org/W3"],
          related_works: ["https://openalex.org/W7"],
        });
      }
      expect(url.searchParams.get("filter")).toContain("ids.openalex:");
      return json({
        results: [
          { id: "https://openalex.org/W1", title: "Ref one", ids: { doi: "https://doi.org/10.1/a", arxiv: "https://arxiv.org/abs/2401.0001" }, primary_location: { version: "publishedVersion" } },
          { id: "https://openalex.org/W2", title: "Ref two" },
        ],
      });
    });
    const service = createResearchSearchService({ fetch });
    const page = await service.handle({ action: "relations", paperId: "W9", relation: "references", limit: 2 }, context);
    expect(page.status).toBe("ok");
    expect(page.relation).toMatchObject({ kind: "references", source: { provider: "openalex", id: "W9", doi: "10.1/source", title: "Source work" } });
    expect(page.papers.map((paper) => paper.id)).toEqual(["https://openalex.org/W1", "https://openalex.org/W2"]);
    // Identity fields stay distinct: DOI/arXiv aliases and the version marker.
    expect(page.papers[0]).toMatchObject({
      doi: "10.1/a",
      externalIds: { doi: "10.1/a", arxiv: "2401.0001" },
      version: "publishedVersion",
      content: "metadata-only",
    });
    expect(page.papers[0]!.availableFields).toEqual(expect.arrayContaining(["externalIds", "version"]));
    expect(page.nextCursor).toBe("oa-list:references:W9:2");

    // The minted cursor continues the same work's remaining references.
    const next = await service.handle({ action: "relations", paperId: "W9", relation: "references", cursor: page.nextCursor!, limit: 2 }, context);
    expect(next.status).toBe("ok");
    expect(next.papers.map((paper) => paper.id)).toEqual(["https://openalex.org/W1", "https://openalex.org/W2"]);
    expect(next.nextCursor).toBeUndefined();
  });

  it("rejects a cursor minted for a different paper or relation", async () => {
    const service = createResearchSearchService({ fetch: vi.fn() });
    await expect(service.handle(
      { action: "relations", paperId: "W9", relation: "references", cursor: "oa-list:related:W9:2" },
      context,
    )).rejects.toMatchObject({ harnessCode: "invalid-params" });
    await expect(service.handle(
      { action: "relations", paperId: "W1", relation: "references", cursor: "oa-list:references:W9:2" },
      context,
    )).rejects.toMatchObject({ harnessCode: "invalid-params" });
  });

  it("expands OpenAlex citations through the provider's own cursor", async () => {
    const fetch = vi.fn(async (input: Parameters<typeof globalThis.fetch>[0]) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe("/works");
      expect(url.searchParams.get("filter")).toBe("cites:W9");
      return json({
        meta: { next_cursor: "cit-page-2" },
        results: [{ id: "https://openalex.org/W5", title: "Citing work", cited_by_count: 7 }],
      });
    });
    const service = createResearchSearchService({ fetch });
    const page = await service.handle({ action: "relations", paperId: "W9", relation: "citations" }, context);
    expect(page).toMatchObject({
      status: "ok",
      relation: { kind: "citations", source: { id: "W9" } },
      nextCursor: "cit-page-2",
    });
  });

  it("expands Semantic Scholar references with per-edge direction", async () => {
    const fetch = vi.fn(async (input: Parameters<typeof globalThis.fetch>[0]) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe("/graph/v1/paper/P9/references");
      return json({
        next: 10,
        data: [
          { citedPaper: { paperId: "P1", title: "Cited one", externalIds: { DOI: "10.2/a", ArXiv: "2401.9999" }, openAccessPdf: { url: "https://example.org/p1.pdf" } } },
          { citedPaper: null },
        ],
      });
    });
    const service = createResearchSearchService({ fetch });
    const page = await service.handle({ action: "relations", provider: "semantic-scholar", paperId: "P9", relation: "references" }, context);
    expect(page.status).toBe("ok");
    expect(page.nextCursor).toBe("10");
    expect(page.papers).toHaveLength(1);
    expect(page.papers[0]).toMatchObject({
      provider: "semantic-scholar",
      id: "P1",
      doi: "10.2/a",
      externalIds: { doi: "10.2/a", arxiv: "2401.9999" },
      content: "open-location",
    });
    expect(page.relation).toMatchObject({ kind: "references", source: { provider: "semantic-scholar", id: "P9" } });
  });

  it("reports the Semantic Scholar related relation as unavailable, not failed", async () => {
    const fetch = vi.fn();
    const service = createResearchSearchService({ fetch });
    const result = await service.handle({ action: "relations", provider: "semantic-scholar", paperId: "P9", relation: "related" }, context);
    expect(result.status).toBe("unavailable");
    expect(result.relationKinds).not.toContain("related");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps an empty relation page distinct from a failed provider", async () => {
    const fetch = vi.fn(async () => json({
      id: "https://openalex.org/W9",
      title: "Source work",
      referenced_works: [],
    }));
    const service = createResearchSearchService({ fetch });
    const page = await service.handle({ action: "relations", paperId: "W9", relation: "references" }, context);
    expect(page).toMatchObject({ status: "empty", papers: [], relation: { kind: "references" } });
  });
});
