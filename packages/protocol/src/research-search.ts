/**
 * Host-owned scholarly discovery contract (D-315 L2).
 *
 * The result deliberately keeps metadata, an open-access location, and
 * material availability separate. Finding a record is not reading its paper.
 */

export type ScholarlyProvider = "openalex" | "semantic-scholar";

export type ScholarlySearchAction = "search" | "paper";

export interface ScholarlySearchParams {
  action: ScholarlySearchAction;
  provider?: ScholarlyProvider;
  query?: string;
  paperId?: string;
  cursor?: string;
  limit?: number;
}

export interface ScholarlyAuthor {
  name: string;
  id?: string;
}

export interface ScholarlyPaper {
  provider: ScholarlyProvider;
  id: string;
  title: string;
  abstract?: string;
  year?: number;
  authors: ScholarlyAuthor[];
  doi?: string;
  citedByCount?: number;
  landingUrl?: string;
  openAccessUrl?: string;
  /** Metadata was returned; this does not imply the content was read. */
  content: "metadata-only" | "open-location";
}

export interface ScholarlySearchResult {
  status: "ok" | "empty" | "unavailable" | "failed";
  provider: ScholarlyProvider;
  action: ScholarlySearchAction;
  papers: ScholarlyPaper[];
  nextCursor?: string;
  capabilities: Array<"search" | "paper" | "relations" | "open-access-location">;
  message?: string;
}
