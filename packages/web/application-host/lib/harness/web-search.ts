import type { HarnessWebSearchSettings, SearchResultItem } from "@piarium/protocol";
import type { HarnessService, HarnessServiceContext } from "./router.js";

export interface SearchProvider {
  id: string;
  search(query: string, options: {
    allowedDomains?: string[];
    blockedDomains?: string[];
    recency?: "day" | "week" | "month" | "year";
    limit?: number;
    signal?: AbortSignal;
  }): Promise<Array<{ title: string; url: string; snippet: string; publishedAt?: string }>>;
}

export type ResolveSearchProviderResult = SearchProvider | { unavailable: true; hint: string };

interface SearchProviderRuntime {
  apiKey: string | null;
  fetch: typeof globalThis.fetch;
  now: () => number;
}

const DEFAULT_ENDPOINTS: Record<Exclude<HarnessWebSearchSettings["provider"], "searxng">, string> = {
  brave: "https://api.search.brave.com/res/v1/web/search",
  exa: "https://api.exa.ai/search",
  tavily: "https://api.tavily.com/search",
  jina: "https://s.jina.ai/",
};

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === "object" && !Array.isArray(value)
);

const text = (value: unknown): string => typeof value === "string" ? value.trim() : "";

const stringList = (value: unknown): string[] => (
  Array.isArray(value) ? value.map(text).filter(Boolean) : []
);

const endpointFor = (settings: HarnessWebSearchSettings): string => {
  const configured = settings.endpoint?.trim();
  const raw = configured || (settings.provider === "searxng" ? "" : DEFAULT_ENDPOINTS[settings.provider]);
  if (!raw) throw new Error("SearXNG search requires an endpoint");
  const endpoint = new URL(raw);
  if ((endpoint.protocol !== "https:" && endpoint.protocol !== "http:") || endpoint.username || endpoint.password) {
    throw new Error("Search provider endpoint must be an HTTP(S) URL without embedded credentials");
  }
  return endpoint.href;
};

const requireCredential = (settings: HarnessWebSearchSettings, apiKey: string | null): string => {
  if (apiKey) return apiKey;
  throw new Error(`Search credential is not configured for ${settings.provider}`);
};

const responseJson = async (response: Response, provider: string): Promise<Record<string, unknown>> => {
  if (!response.ok) throw new Error(`${provider} search failed with HTTP ${response.status}`);
  const value = await response.json() as unknown;
  if (!isRecord(value)) throw new Error(`${provider} search returned malformed JSON`);
  return value;
};

const recencyStart = (recency: "day" | "week" | "month" | "year", now: number): string => {
  const days = recency === "day" ? 1 : recency === "week" ? 7 : recency === "month" ? 31 : 365;
  return new Date(now - days * 24 * 60 * 60 * 1_000).toISOString();
};

const normalizeResults = (values: unknown[]): Array<{ title: string; url: string; snippet: string; publishedAt?: string }> => (
  values.flatMap((value) => {
    if (!isRecord(value)) return [];
    const url = text(value.url) || text(value.link);
    if (!url) return [];
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return [];
    } catch {
      return [];
    }
    const highlights = stringList(value.highlights);
    const snippet = text(value.description)
      || text(value.content)
      || highlights.join(" … ")
      || text(value.text);
    const publishedAt = text(value.publishedAt)
      || text(value.publishedDate)
      || text(value.published_date)
      || text(value.date);
    return [{
      title: text(value.title) || url,
      url,
      snippet,
      ...(publishedAt ? { publishedAt } : {}),
    }];
  })
);

const braveProvider = (settings: HarnessWebSearchSettings, runtime: SearchProviderRuntime): SearchProvider => ({
  id: "configured-brave",
  search: async (query, options) => {
    const endpoint = new URL(endpointFor(settings));
    endpoint.searchParams.set("q", query);
    endpoint.searchParams.set("count", String(Math.min(options.limit ?? 10, 20)));
    if (options.recency) endpoint.searchParams.set("freshness", ({ day: "pd", week: "pw", month: "pm", year: "py" })[options.recency]);
    const payload = await responseJson(await runtime.fetch(endpoint, {
      headers: { Accept: "application/json", "X-Subscription-Token": requireCredential(settings, runtime.apiKey) },
      ...(options.signal ? { signal: options.signal } : {}),
    }), "Brave");
    const web = isRecord(payload.web) ? payload.web : {};
    return normalizeResults(Array.isArray(web.results) ? web.results : []);
  },
});

const exaProvider = (settings: HarnessWebSearchSettings, runtime: SearchProviderRuntime): SearchProvider => ({
  id: "configured-exa",
  search: async (query, options) => {
    const payload = await responseJson(await runtime.fetch(endpointFor(settings), {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": requireCredential(settings, runtime.apiKey) },
      body: JSON.stringify({
        query,
        numResults: options.limit ?? 10,
        contents: { highlights: true },
        ...(options.allowedDomains?.length ? { includeDomains: options.allowedDomains } : {}),
        ...(options.blockedDomains?.length ? { excludeDomains: options.blockedDomains } : {}),
        ...(options.recency ? { startPublishedDate: recencyStart(options.recency, runtime.now()) } : {}),
      }),
      ...(options.signal ? { signal: options.signal } : {}),
    }), "Exa");
    return normalizeResults(Array.isArray(payload.results) ? payload.results : []);
  },
});

const tavilyProvider = (settings: HarnessWebSearchSettings, runtime: SearchProviderRuntime): SearchProvider => ({
  id: "configured-tavily",
  search: async (query, options) => {
    const payload = await responseJson(await runtime.fetch(endpointFor(settings), {
      method: "POST",
      headers: { Authorization: `Bearer ${requireCredential(settings, runtime.apiKey)}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        query,
        max_results: options.limit ?? 10,
        ...(options.allowedDomains?.length ? { include_domains: options.allowedDomains } : {}),
        ...(options.blockedDomains?.length ? { exclude_domains: options.blockedDomains } : {}),
        ...(options.recency ? { time_range: options.recency } : {}),
      }),
      ...(options.signal ? { signal: options.signal } : {}),
    }), "Tavily");
    return normalizeResults(Array.isArray(payload.results) ? payload.results : []);
  },
});

const jinaProvider = (settings: HarnessWebSearchSettings, runtime: SearchProviderRuntime): SearchProvider => ({
  id: "configured-jina",
  search: async (query, options) => {
    const endpoint = new URL(endpointFor(settings));
    endpoint.searchParams.set("q", query);
    const payload = await responseJson(await runtime.fetch(endpoint, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${requireCredential(settings, runtime.apiKey)}`,
      },
      ...(options.signal ? { signal: options.signal } : {}),
    }), "Jina");
    const values = Array.isArray(payload.data) ? payload.data : Array.isArray(payload.results) ? payload.results : [];
    return normalizeResults(values).slice(0, options.limit ?? 10);
  },
});

const searxngProvider = (settings: HarnessWebSearchSettings, runtime: SearchProviderRuntime): SearchProvider => ({
  id: "configured-searxng",
  search: async (query, options) => {
    const endpoint = new URL(endpointFor(settings));
    if (endpoint.pathname === "/" || endpoint.pathname === "") endpoint.pathname = "/search";
    endpoint.searchParams.set("q", query);
    endpoint.searchParams.set("format", "json");
    if (options.recency === "week") {
      throw new Error("SearXNG does not support an exact week recency filter; use day, month, or year");
    }
    if (options.recency) endpoint.searchParams.set("time_range", options.recency);
    const payload = await responseJson(await runtime.fetch(endpoint, {
      headers: {
        Accept: "application/json",
        ...(runtime.apiKey ? { Authorization: `Bearer ${runtime.apiKey}` } : {}),
      },
      ...(options.signal ? { signal: options.signal } : {}),
    }), "SearXNG");
    return normalizeResults(Array.isArray(payload.results) ? payload.results : []).slice(0, options.limit ?? 10);
  },
});

export const parseSearchProviderSettings = (value: unknown): HarnessWebSearchSettings | null => {
  if (!isRecord(value)) return null;
  const provider = value.provider;
  if (provider !== "brave" && provider !== "exa" && provider !== "tavily" && provider !== "jina" && provider !== "searxng") return null;
  const endpoint = text(value.endpoint);
  const credentialRef = text(value.credentialRef);
  return {
    provider,
    ...(endpoint ? { endpoint } : {}),
    ...(credentialRef ? { credentialRef } : {}),
  };
};

export const resolveSearchCredential = (auth: unknown, credentialRef: string | undefined): string | null => {
  if (!credentialRef || !isRecord(auth)) return null;
  const entry = auth[credentialRef];
  if (!isRecord(entry)) return null;
  return text(entry.key) || text(entry.token) || text(entry.access) || text(entry.apiKey) || null;
};

export const createConfiguredSearchProvider = (
  settings: HarnessWebSearchSettings,
  options: { apiKey?: string | null; fetch?: typeof globalThis.fetch; now?: () => number } = {},
): SearchProvider => {
  const runtime: SearchProviderRuntime = {
    apiKey: options.apiKey ?? null,
    fetch: options.fetch ?? globalThis.fetch,
    now: options.now ?? Date.now,
  };
  if (settings.provider === "brave") return braveProvider(settings, runtime);
  if (settings.provider === "exa") return exaProvider(settings, runtime);
  if (settings.provider === "tavily") return tavilyProvider(settings, runtime);
  if (settings.provider === "jina") return jinaProvider(settings, runtime);
  return searxngProvider(settings, runtime);
};

export const resolveConfiguredSearchProvider = (input: {
  settings: unknown;
  auth: unknown;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}): ResolveSearchProviderResult => {
  const settings = parseSearchProviderSettings(input.settings);
  if (!settings) return { unavailable: true, hint: "no search provider configured" };
  const credentialRef = settings.credentialRef;
  const apiKey = resolveSearchCredential(input.auth, credentialRef);
  if (settings.provider !== "searxng" && !apiKey) {
    return {
      unavailable: true,
      hint: credentialRef
        ? `search credential is unavailable: ${credentialRef}`
        : `search credential reference is required for ${settings.provider}`,
    };
  }
  try {
    // Validate endpoint eagerly so a malformed setting does not advertise a
    // tool that can only fail after the session has been constructed.
    endpointFor(settings);
    return createConfiguredSearchProvider(settings, {
      apiKey,
      ...(input.fetch ? { fetch: input.fetch } : {}),
      ...(input.now ? { now: input.now } : {}),
    });
  } catch (error) {
    return { unavailable: true, hint: error instanceof Error ? error.message : "invalid search provider configuration" };
  }
};

export function filterByDomainPolicy<T extends { url: string }>(
  results: T[],
  allowedDomains: string[] | undefined,
  blockedDomains: string[] | undefined,
): T[] {
  return results.filter((result) => {
    try {
      const hostname = new URL(result.url).hostname.toLowerCase();
      if (blockedDomains?.some((domain) => hostname === domain.toLowerCase() || hostname.endsWith(`.${domain.toLowerCase()}`))) return false;
      if (allowedDomains?.length && !allowedDomains.some((domain) => hostname === domain.toLowerCase() || hostname.endsWith(`.${domain.toLowerCase()}`))) return false;
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
        throw new Error(providerResult.hint);
      }
      const rawResults = await providerResult.search(params.query, {
        ...(params.allowedDomains ? { allowedDomains: params.allowedDomains } : {}),
        ...(params.blockedDomains ? { blockedDomains: params.blockedDomains } : {}),
        ...(params.recency ? { recency: params.recency } : {}),
        ...(params.limit ? { limit: params.limit } : {}),
        signal: ctx.signal,
      });
      const filtered = filterByDomainPolicy(rawResults, params.allowedDomains, params.blockedDomains);
      const results: SearchResultItem[] = filtered.map((result) => ({
        title: result.title,
        url: result.url,
        snippet: result.snippet,
        ...(result.publishedAt ? { publishedAt: result.publishedAt } : {}),
      }));
      return { providerId: providerResult.id, results };
    },
  };
}
