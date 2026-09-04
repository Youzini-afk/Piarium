import { describe, it, expect } from "vitest";
import {
  resolveSearchProvider,
  filterByDomainPolicy,
  createWebSearchService,
  type SearchProviderConfig,
} from "./web-search.js";
import type { HarnessServiceContext } from "./router.js";

const SERVICE_CONTEXT: HarnessServiceContext = {
  actor: {
    authorityInstanceId: "test-authority",
    sessionId: "s1",
    workerId: "test-worker",
    workerGeneration: 1,
    workspaceId: "ws",
    grantedCapabilities: ["read.web"],
  },
  sessionId: "s1",
  workspaceId: "ws",
  signal: new AbortController().signal,
};

describe("resolveSearchProvider", () => {
  it("returns Anthropic adapter when model provider has webSearch capability", () => {
    const result = resolveSearchProvider({
      modelProviderId: "anthropic",
      modelProviderCapabilities: { webSearch: true },
      configured: null,
    });
    expect("unavailable" in result).toBe(false);
    if (!("unavailable" in result)) {
      expect(result.id).toBe("anthropic-web-search");
    }
  });

  it("returns OpenAI adapter for openai provider with webSearch", () => {
    const result = resolveSearchProvider({
      modelProviderId: "openai",
      modelProviderCapabilities: { webSearch: true },
      configured: null,
    });
    expect("unavailable" in result).toBe(false);
    if (!("unavailable" in result)) {
      expect(result.id).toBe("openai-web-search");
    }
  });

  it("returns Gemini adapter for google provider with webSearch", () => {
    const result = resolveSearchProvider({
      modelProviderId: "google",
      modelProviderCapabilities: { webSearch: true },
      configured: null,
    });
    expect("unavailable" in result).toBe(false);
    if (!("unavailable" in result)) {
      expect(result.id).toBe("gemini-grounding");
    }
  });

  it("returns configured provider when model provider has no webSearch", () => {
    const config: SearchProviderConfig = {
      type: "brave",
      endpoint: "https://api.search.brave.com/res/v1/web/search",
      credentialRef: "brave-api-key",
    };
    const result = resolveSearchProvider({
      modelProviderId: "some-other",
      modelProviderCapabilities: {},
      configured: config,
    });
    expect("unavailable" in result).toBe(false);
    if (!("unavailable" in result)) {
      expect(result.id).toBe("configured-brave");
    }
  });

  it("returns unavailable when no provider and no config", () => {
    const result = resolveSearchProvider({
      modelProviderId: "some-other",
      modelProviderCapabilities: {},
      configured: null,
    });
    expect("unavailable" in result).toBe(true);
    if ("unavailable" in result) {
      expect(result.hint).toContain("no search provider configured");
    }
  });

  it("returns unavailable when model provider has no webSearch even with known id", () => {
    const result = resolveSearchProvider({
      modelProviderId: "anthropic",
      modelProviderCapabilities: {}, // webSearch not set
      configured: null,
    });
    expect("unavailable" in result).toBe(true);
  });
});

describe("filterByDomainPolicy", () => {
  it("filters out blocked domains", () => {
    const results = [
      { url: "https://good.com/page" },
      { url: "https://evil.com/page" },
      { url: "https://sub.evil.com/page" },
    ];
    const filtered = filterByDomainPolicy(results, undefined, ["evil.com"]);
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.url).toBe("https://good.com/page");
  });

  it("filters to allowed domains only (whitelist mode)", () => {
    const results = [
      { url: "https://allowed.com/page" },
      { url: "https://other.com/page" },
    ];
    const filtered = filterByDomainPolicy(results, ["allowed.com"], undefined);
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.url).toBe("https://allowed.com/page");
  });

  it("passes all when no policy set", () => {
    const results = [
      { url: "https://a.com/page" },
      { url: "https://b.com/page" },
    ];
    const filtered = filterByDomainPolicy(results, undefined, undefined);
    expect(filtered).toHaveLength(2);
  });

  it("handles invalid URLs by filtering them out", () => {
    const results = [
      { url: "not-a-url" },
      { url: "https://good.com/page" },
    ];
    const filtered = filterByDomainPolicy(results, undefined, undefined);
    expect(filtered).toHaveLength(1);
  });
});

describe("createWebSearchService", () => {
  it("returns empty results with providerId 'none' when unavailable", async () => {
    const service = createWebSearchService(async () => ({ unavailable: true, hint: "no provider" }));
    const result = await service.handle(
      { query: "test" },
      SERVICE_CONTEXT,
    );
    expect(result.providerId).toBe("none");
    expect(result.results).toEqual([]);
  });

  it("returns results from provider", async () => {
    const service = createWebSearchService(async () => ({
      id: "test-provider",
      search: async () => [
        { title: "Result 1", url: "https://example.com/1", snippet: "Snippet 1" },
        { title: "Result 2", url: "https://example.com/2", snippet: "Snippet 2" },
      ],
    }));
    const result = await service.handle(
      { query: "test" },
      SERVICE_CONTEXT,
    );
    expect(result.providerId).toBe("test-provider");
    expect(result.results).toHaveLength(2);
    expect(result.results[0]?.title).toBe("Result 1");
  });

  it("applies domain filtering to results", async () => {
    const service = createWebSearchService(async () => ({
      id: "test-provider",
      search: async () => [
        { title: "Good", url: "https://good.com/1", snippet: "S" },
        { title: "Bad", url: "https://bad.com/1", snippet: "S" },
      ],
    }));
    const result = await service.handle(
      { query: "test", blockedDomains: ["bad.com"] },
      SERVICE_CONTEXT,
    );
    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.title).toBe("Good");
  });
});
