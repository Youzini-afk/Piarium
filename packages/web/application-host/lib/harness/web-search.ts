import type { HarnessService, HarnessServiceContext } from "./router.js";
import type { SearchResultItem } from "@piarium/protocol";

export interface SearchProvider {
  id: string;
  search(query: string, options: {
    allowedDomains?: string[];
    blockedDomains?: string[];
    recency?: "day" | "week" | "month" | "year";
    limit?: number;
  }): Promise<Array<{ title: string; url: string; snippet: string; publishedAt?: string }>>;
}

export interface SearchProviderConfig {
  type: "brave" | "exa" | "tavily" | "jina" | "searxng";
  endpoint: string;
  credentialRef: string; // reference to Pi AuthStorage
}

export interface ResolveSearchProviderInput {
  modelProviderId: string;
  modelProviderCapabilities: { webSearch?: boolean };
  configured: SearchProviderConfig | null;
}

export type ResolveSearchProviderResult = SearchProvider | { unavailable: true; hint: string };

/**
 * Three-layer search provider resolution:
 * 1. Model provider built-in search (Anthropic web_search, OpenAI web search, Gemini grounding)
 * 2. Settings-configured search API (Brave, Exa, Tavily, Jina, SearXNG)
 * 3. None → unavailable with hint
 */
export function resolveSearchProvider(input: ResolveSearchProviderInput): ResolveSearchProviderResult {
  // Layer 1: Model provider built-in search
  const providerId = input.modelProviderId.toLowerCase();
  if (input.modelProviderCapabilities.webSearch) {
    if (providerId.includes("anthropic") || providerId.includes("claude")) {
      return {
        id: "anthropic-web-search",
        search: async () => {
          // Anthropic web_search is a server-side tool — the model handles it
          // This adapter is a placeholder; actual integration happens at the model request level
          return [];
        },
      };
    }
    if (providerId.includes("openai") || providerId.includes("gpt")) {
      return {
        id: "openai-web-search",
        search: async () => {
          // OpenAI web search is server-side
          return [];
        },
      };
    }
    if (providerId.includes("google") || providerId.includes("gemini")) {
      return {
        id: "gemini-grounding",
        search: async () => {
          // Gemini grounding is server-side
          return [];
        },
      };
    }
  }

  // Layer 2: Settings-configured search API
  if (input.configured) {
    return createConfiguredSearchProvider(input.configured);
  }

  // Layer 3: None
  return {
    unavailable: true,
    hint: "no search provider configured; add one in Settings → Agent harness → Web",
  };
}

function createConfiguredSearchProvider(config: SearchProviderConfig): SearchProvider {
  const id = `configured-${config.type}`;
  return {
    id,
    search: async (query, options) => {
      // Each provider type has a different API shape
      // This is a simplified implementation — real adapters would make HTTP requests
      const results = await searchWithProvider(config, query, options);
      return results;
    },
  };
}

async function searchWithProvider(
  config: SearchProviderConfig,
  query: string,
  options: { allowedDomains?: string[]; blockedDomains?: string[]; recency?: string; limit?: number },
): Promise<Array<{ title: string; url: string; snippet: string; publishedAt?: string }>> {
  const limit = options.limit ?? 10;
  // This is a placeholder — real implementation would make HTTP requests to the configured endpoint
  // For now, return empty results. The actual HTTP adapters will be implemented when
  // credentials are wired through Pi AuthStorage.
  void config; void query; void options; void limit;
  return [];
}

/**
 * Apply domain filtering to search results.
 */
export function filterByDomainPolicy<T extends { url: string }>(
  results: T[],
  allowedDomains: string[] | undefined,
  blockedDomains: string[] | undefined,
): T[] {
  return results.filter((r) => {
    try {
      const hostname = new URL(r.url).hostname.toLowerCase();
      if (blockedDomains?.some((d) => hostname === d.toLowerCase() || hostname.endsWith(`.${d.toLowerCase()}`))) {
        return false;
      }
      if (allowedDomains && allowedDomains.length > 0) {
        if (!allowedDomains.some((d) => hostname === d.toLowerCase() || hostname.endsWith(`.${d.toLowerCase()}`))) {
          return false;
        }
      }
      return true;
    } catch {
      return false;
    }
  });
}

export function createWebSearchService(
  resolveProvider: (ctx: { sessionId: string; workspaceId: string | null }) => Promise<ResolveSearchProviderResult>,
): HarnessService<"web.search"> {
  return {
    handle: async (params, ctx: HarnessServiceContext) => {
      const providerResult = await resolveProvider(ctx);
      if ("unavailable" in providerResult) {
        return {
          providerId: "none",
          results: [],
        };
      }
      try {
        const rawResults = await providerResult.search(params.query, {
          ...(params.allowedDomains ? { allowedDomains: params.allowedDomains } : {}),
          ...(params.blockedDomains ? { blockedDomains: params.blockedDomains } : {}),
          ...(params.recency ? { recency: params.recency } : {}),
          ...(params.limit ? { limit: params.limit } : {}),
        });
        const filtered = filterByDomainPolicy(rawResults, params.allowedDomains, params.blockedDomains);
        const results: SearchResultItem[] = filtered.map((r) => ({
          title: r.title,
          url: r.url,
          snippet: r.snippet,
          ...(r.publishedAt ? { publishedAt: r.publishedAt } : {}),
        }));
        return {
          providerId: providerResult.id,
          results,
        };
      } catch {
        return {
          providerId: providerResult.id,
          results: [],
        };
      }
    },
  };
}
