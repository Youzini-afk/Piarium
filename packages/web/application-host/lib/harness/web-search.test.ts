import { describe, expect, it, vi } from "vitest";
import {
  createConfiguredSearchProvider,
  createWebSearchService,
  filterByDomainPolicy,
  parseSearchProviderSettings,
  resolveConfiguredSearchProvider,
  resolveSearchCredential,
} from "./web-search.js";
import type { HarnessServiceContext } from "./router.js";

const context: HarnessServiceContext = {
  actor: {
    authorityInstanceId: "test-authority",
    sessionId: "s1",
    workerId: "test-worker",
    workerGeneration: 1,
    workspaceId: "ws",
    grantedCapabilities: ["read.web"],
  },
  authorizedPaths: [],
  sessionId: "s1",
  workspaceId: "ws",
  signal: new AbortController().signal,
};

const jsonResponse = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), {
  status,
  headers: { "Content-Type": "application/json" },
});

describe("configured web search providers", () => {
  it("calls Brave with its documented header, freshness, and result shape", async () => {
    const fetch = vi.fn(async (_input: Parameters<typeof globalThis.fetch>[0], _init?: RequestInit) => jsonResponse({
      web: { results: [{ title: "Brave result", url: "https://docs.example/a", description: "snippet" }] },
    }));
    const provider = createConfiguredSearchProvider({ provider: "brave" }, { apiKey: "brave-secret", fetch });
    await expect(provider.search("query", { limit: 50, recency: "week" })).resolves.toEqual([
      { title: "Brave result", url: "https://docs.example/a", snippet: "snippet" },
    ]);
    const [requestUrl, init] = fetch.mock.calls[0]!;
    const url = new URL(String(requestUrl));
    expect(url.origin + url.pathname).toBe("https://api.search.brave.com/res/v1/web/search");
    expect(url.searchParams.get("q")).toBe("query");
    expect(url.searchParams.get("count")).toBe("20");
    expect(url.searchParams.get("freshness")).toBe("pw");
    expect((init?.headers as Record<string, string>)["X-Subscription-Token"]).toBe("brave-secret");
  });

  it("maps Exa domain and recency options without exposing its credential", async () => {
    const fetch = vi.fn(async (_input: Parameters<typeof globalThis.fetch>[0], _init?: RequestInit) => jsonResponse({
      results: [{ title: "Exa result", url: "https://exa.example/a", highlights: ["first", "second"], publishedDate: "2026-09-01" }],
    }));
    const provider = createConfiguredSearchProvider({ provider: "exa", credentialRef: "exa-search" }, {
      apiKey: "exa-secret",
      fetch,
      now: () => Date.parse("2026-09-05T00:00:00.000Z"),
    });
    const results = await provider.search("query", {
      allowedDomains: ["exa.example"],
      blockedDomains: ["blocked.example"],
      recency: "day",
      limit: 4,
    });
    expect(results[0]).toMatchObject({ snippet: "first … second", publishedAt: "2026-09-01" });
    const [, init] = fetch.mock.calls[0]!;
    expect(JSON.parse(String(init?.body))).toMatchObject({
      query: "query",
      numResults: 4,
      includeDomains: ["exa.example"],
      excludeDomains: ["blocked.example"],
      startPublishedDate: "2026-09-04T00:00:00.000Z",
    });
    expect(JSON.stringify(init)).not.toContain("credentialRef");
  });

  it("supports Tavily, Jina, and credential-optional SearXNG response shapes", async () => {
    const tavilyFetch = vi.fn(async (_input: Parameters<typeof globalThis.fetch>[0], _init?: RequestInit) => jsonResponse({ results: [{ title: "T", url: "https://t.example", content: "T body" }] }));
    const tavily = createConfiguredSearchProvider({ provider: "tavily" }, { apiKey: "tvly", fetch: tavilyFetch });
    expect((await tavily.search("q", { recency: "month" }))[0]?.snippet).toBe("T body");
    expect(JSON.parse(String(tavilyFetch.mock.calls[0]![1]?.body))).toMatchObject({ time_range: "month" });

    const jinaFetch = vi.fn(async (_input: Parameters<typeof globalThis.fetch>[0], _init?: RequestInit) => jsonResponse({ data: [{ title: "J", url: "https://j.example", content: "J body" }] }));
    const jina = createConfiguredSearchProvider({ provider: "jina" }, { apiKey: "jina", fetch: jinaFetch });
    expect(await jina.search("q", {})).toEqual([{ title: "J", url: "https://j.example", snippet: "J body" }]);
    expect(new URL(String(jinaFetch.mock.calls[0]![0])).searchParams.get("q")).toBe("q");

    const searxFetch = vi.fn(async (_input: Parameters<typeof globalThis.fetch>[0], _init?: RequestInit) => jsonResponse({ results: [{ title: "S", url: "https://s.example", content: "S body" }] }));
    const searx = createConfiguredSearchProvider({ provider: "searxng", endpoint: "http://127.0.0.1:8080" }, { fetch: searxFetch });
    expect(await searx.search("q", { recency: "month" })).toHaveLength(1);
    const searxUrl = new URL(String(searxFetch.mock.calls[0]![0]));
    expect(searxUrl.pathname).toBe("/search");
    expect(searxUrl.searchParams.get("format")).toBe("json");
    expect(searxUrl.searchParams.get("time_range")).toBe("month");
    await expect(searx.search("q", { recency: "week" })).rejects.toThrow("exact week");
  });

  it("parses public settings and resolves only the named Pi auth entry", () => {
    expect(parseSearchProviderSettings({ provider: "brave", credentialRef: "brave-search", unknown: true })).toEqual({
      provider: "brave",
      credentialRef: "brave-search",
    });
    expect(parseSearchProviderSettings({ provider: "unknown" })).toBeNull();
    expect(resolveSearchCredential({
      brave: { type: "api_key", key: "secret" },
      other: { token: "other-secret" },
    }, "brave")).toBe("secret");
    expect(resolveSearchCredential({ brave: { key: "secret" } }, "missing")).toBeNull();
    expect(resolveConfiguredSearchProvider({
      settings: { provider: "brave", credentialRef: "missing" },
      auth: {},
    })).toEqual({ unavailable: true, hint: "search credential is unavailable: missing" });
    expect(resolveConfiguredSearchProvider({
      settings: { provider: "searxng", endpoint: "http://localhost:8080" },
      auth: {},
      fetch: vi.fn(),
    })).toMatchObject({ id: "configured-searxng" });
  });

  it("filters returned domains and surfaces provider failure instead of reporting empty success", async () => {
    expect(filterByDomainPolicy([
      { url: "https://docs.example/a" },
      { url: "https://blocked.example/b" },
      { url: "not-a-url" },
    ], ["example"], ["blocked.example"])).toEqual([{ url: "https://docs.example/a" }]);

    const service = createWebSearchService(async () => ({
      id: "broken",
      search: async () => { throw new Error("provider unavailable"); },
    }));
    await expect(service.handle({ query: "q" }, context)).rejects.toThrow("provider unavailable");
    const unavailable = createWebSearchService(async () => ({ unavailable: true, hint: "configure search" }));
    await expect(unavailable.handle({ query: "q" }, context)).rejects.toThrow("configure search");
  });
});
