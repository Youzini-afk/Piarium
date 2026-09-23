import type {
  HarnessServiceMap,
  ScholarlyAuthor,
  ScholarlyPaper,
  ScholarlyProvider,
  ScholarlySearchResult,
} from "@varin/protocol";
import type { HarnessService, HarnessServiceContext } from "./router.js";
import { HarnessServiceError } from "./service-error.js";

type SearchParams = HarnessServiceMap["research.search"]["params"];

interface ScholarlySearchDeps {
  fetch?: typeof globalThis.fetch;
}

const DEFAULT_LIMIT = 10;
const OPENALEX = "https://api.openalex.org";
const SEMANTIC_SCHOLAR = "https://api.semanticscholar.org/graph/v1";

const text = (value: unknown): string => typeof value === "string" ? value.trim() : "";
const positiveInteger = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const record = (value: unknown): Record<string, unknown> => (
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
);

const abstractFromInvertedIndex = (value: unknown): string | undefined => {
  const inverted = record(value);
  const words: Array<{ position: number; word: string }> = [];
  for (const [word, positions] of Object.entries(inverted)) {
    if (!Array.isArray(positions)) continue;
    for (const position of positions) {
      if (Number.isSafeInteger(position) && Number(position) >= 0) words.push({ position: Number(position), word });
    }
  }
  if (words.length === 0) return undefined;
  words.sort((left, right) => left.position - right.position);
  return words.map((item) => item.word).join(" ");
};

const authorList = (value: unknown, provider: ScholarlyProvider): ScholarlyAuthor[] => {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const row = record(entry);
    const author = provider === "openalex" ? record(row.author) : row;
    const name = text(author.display_name) || text(author.name);
    if (!name) return [];
    const id = text(author.id) || text(author.authorId);
    return [{ name, ...(id ? { id } : {}) }];
  });
};

const openAlexPaper = (value: unknown): ScholarlyPaper | null => {
  const row = record(value);
  const id = text(row.id);
  const title = text(row.title) || text(row.display_name);
  if (!id || !title) return null;
  const primary = record(row.primary_location);
  const landingUrl = text(primary.landing_page_url) || text(row.primary_location);
  const openAccess = record(row.open_access);
  const openAccessUrl = text(primary.pdf_url) || text(openAccess.oa_url) || undefined;
  const doi = text(row.doi).replace(/^https?:\/\/doi\.org\//iu, "") || undefined;
  const year = Number.isSafeInteger(row.publication_year) ? Number(row.publication_year) : undefined;
  const citedByCount = Number.isSafeInteger(row.cited_by_count) ? Number(row.cited_by_count) : undefined;
  const abstract = abstractFromInvertedIndex(row.abstract_inverted_index);
  return {
    provider: "openalex",
    id,
    title,
    authors: authorList(row.authorships, "openalex"),
    ...(abstract ? { abstract } : {}),
    ...(year !== undefined ? { year } : {}),
    ...(doi ? { doi } : {}),
    ...(citedByCount !== undefined ? { citedByCount } : {}),
    ...(landingUrl ? { landingUrl } : {}),
    ...(openAccessUrl ? { openAccessUrl } : {}),
    content: openAccessUrl ? "open-location" : "metadata-only",
  };
};

const semanticScholarPaper = (value: unknown): ScholarlyPaper | null => {
  const row = record(value);
  const id = text(row.paperId);
  const title = text(row.title);
  if (!id || !title) return null;
  const externalIds = record(row.externalIds);
  const openAccessPdf = record(row.openAccessPdf);
  const doi = text(externalIds.DOI) || undefined;
  const openAccessUrl = text(openAccessPdf.url) || undefined;
  const year = Number.isSafeInteger(row.year) ? Number(row.year) : undefined;
  const citedByCount = Number.isSafeInteger(row.citationCount) ? Number(row.citationCount) : undefined;
  const abstract = text(row.abstract) || undefined;
  return {
    provider: "semantic-scholar",
    id,
    title,
    authors: authorList(row.authors, "semantic-scholar"),
    ...(abstract ? { abstract } : {}),
    ...(year !== undefined ? { year } : {}),
    ...(doi ? { doi } : {}),
    ...(citedByCount !== undefined ? { citedByCount } : {}),
    ...(text(row.url) ? { landingUrl: text(row.url) } : {}),
    ...(openAccessUrl ? { openAccessUrl } : {}),
    content: openAccessUrl ? "open-location" : "metadata-only",
  };
};

const requestJson = async (
  fetcher: typeof globalThis.fetch,
  url: URL,
  signal: AbortSignal,
): Promise<Record<string, unknown>> => {
  const response = await fetcher(url, {
    signal,
    headers: { Accept: "application/json", "User-Agent": "Varin scholarly search" },
  });
  if (!response.ok) throw new Error(`scholarly provider returned HTTP ${response.status}`);
  const value = await response.json() as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("scholarly provider returned malformed JSON");
  return value as Record<string, unknown>;
};

const providerCapabilities = ["search", "paper", "open-access-location"] as const;

const openAlexWorkId = (value: string): string => {
  try {
    const parsed = new URL(value);
    if (parsed.hostname === "openalex.org") return parsed.pathname.replace(/^\//u, "");
  } catch {
    // The provider also accepts its short work id.
  }
  return value;
};

export function createResearchSearchService(deps: ScholarlySearchDeps = {}): HarnessService<"research.search"> {
  const fetcher = deps.fetch ?? globalThis.fetch;
  return {
    handle: async (params: SearchParams, ctx: HarnessServiceContext): Promise<ScholarlySearchResult> => {
      const provider = params.provider ?? "openalex";
      const limit = params.limit ?? DEFAULT_LIMIT;
      if (!positiveInteger(limit)) throw new HarnessServiceError("invalid-params", "research search limit must be a positive integer");
      const action = params.action;
      if (action === "search" && !text(params.query)) throw new HarnessServiceError("invalid-params", "research search requires a query");
      if (action === "paper" && !text(params.paperId)) throw new HarnessServiceError("invalid-params", "research paper lookup requires paperId");
      if (!fetcher) throw new HarnessServiceError("unavailable", "No HTTP client is available for scholarly search");

      try {
        let url: URL;
        if (provider === "openalex") {
          if (action === "search") {
            url = new URL(`${OPENALEX}/works`);
            url.searchParams.set("search", text(params.query));
            url.searchParams.set("per-page", String(limit));
            if (params.cursor) url.searchParams.set("cursor", params.cursor);
          } else {
            const paperId = openAlexWorkId(text(params.paperId));
            url = new URL(`${OPENALEX}/works/${encodeURIComponent(paperId)}`);
          }
          const body = await requestJson(fetcher, url, ctx.signal);
          const papers = action === "search"
            ? (Array.isArray(body.results) ? body.results.flatMap((item) => { const paper = openAlexPaper(item); return paper ? [paper] : []; }) : [])
            : (openAlexPaper(body) ? [openAlexPaper(body)!] : []);
          const meta = record(body.meta);
          const nextCursor = text(meta.next_cursor) || undefined;
          return {
            status: papers.length ? "ok" : "empty",
            provider,
            action,
            papers,
            ...(nextCursor ? { nextCursor } : {}),
            capabilities: [...providerCapabilities],
          };
        }

        if (action === "search") {
          url = new URL(`${SEMANTIC_SCHOLAR}/paper/search`);
          url.searchParams.set("query", text(params.query));
          url.searchParams.set("limit", String(limit));
          url.searchParams.set("fields", "paperId,title,abstract,year,authors,externalIds,citationCount,url,openAccessPdf");
          if (params.cursor && /^\d+$/u.test(params.cursor)) url.searchParams.set("offset", params.cursor);
        } else {
          url = new URL(`${SEMANTIC_SCHOLAR}/paper/${encodeURIComponent(text(params.paperId))}`);
          url.searchParams.set("fields", "paperId,title,abstract,year,authors,externalIds,citationCount,url,openAccessPdf");
        }
        const body = await requestJson(fetcher, url, ctx.signal);
        const papers = action === "search"
          ? (Array.isArray(body.data) ? body.data.flatMap((item) => { const paper = semanticScholarPaper(item); return paper ? [paper] : []; }) : [])
          : (semanticScholarPaper(body) ? [semanticScholarPaper(body)!] : []);
        const nextOffset = action === "search" && typeof body.next === "number" ? String(body.next) : undefined;
        return {
          status: papers.length ? "ok" : "empty",
          provider,
          action,
          papers,
          ...(nextOffset ? { nextCursor: nextOffset } : {}),
          capabilities: [...providerCapabilities],
        };
      } catch (error) {
        if (ctx.signal.aborted || (error instanceof Error && error.name === "AbortError")) throw error;
        return {
          status: "failed",
          provider,
          action,
          papers: [],
          capabilities: [...providerCapabilities],
          message: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}
