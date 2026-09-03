import type { SearchContentParams, SearchContentResult, SearchContentFile, SearchContentHit } from "@piarium/protocol";
import type { WorkspaceContentSearchResult, WorkspaceSearchHit } from "../search/content.js";

export interface HarnessSearchDeps {
  search: (request: { query: string; workspaceId: string; maxResults?: number }, options: { signal?: AbortSignal }) => Promise<WorkspaceContentSearchResult>;
  resolveWorkspaceRoot: (workspaceId: string) => Promise<string | null>;
}

const DEFAULT_LIMIT = 100;
const DEFAULT_CONTEXT = 2;
const DEFAULT_TIMEOUT_MS = 20_000;

function fileScore(input: {
  hits: number;
  path: string;
  root: string;
  gitModified: boolean;
  ageDays: number;
}): number {
  const { hits, path, gitModified, ageDays } = input;
  const recency = gitModified ? 1 : Math.exp(-ageDays / 30);
  const pathPref = /test|spec|__tests__|fixtures/.test(path) ? 0.6 : 1.0;
  const depth = path.split("/").length - 1;
  const depthPenalty = 0.05 * Math.max(0, depth - 3);
  return 0.5 * Math.log1p(hits) + 0.3 * recency + 0.2 * pathPref - depthPenalty;
}

function groupAndSort(
  hits: WorkspaceSearchHit[],
  root: string,
  limit: number,
): { files: SearchContentFile[]; totalHits: number; totalFiles: number } {
  // Group by file path
  const byFile = new Map<string, WorkspaceSearchHit[]>();
  for (const hit of hits) {
    const path = hit.resource.resourceId;
    const fileHits = byFile.get(path) ?? [];
    fileHits.push(hit);
    byFile.set(path, fileHits);
  }

  // Score and sort files
  const scored = Array.from(byFile.entries()).map(([path, fileHits]) => ({
    path,
    hits: fileHits,
    score: fileScore({
      hits: fileHits.length,
      path,
      root,
      gitModified: false, // TODO: integrate with git status
      ageDays: 0, // TODO: integrate with file mtime
    }),
  }));

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.path.localeCompare(b.path);
  });

  // Sort hits within each file by line number
  const files: SearchContentFile[] = scored.map(({ path, hits: fileHits }) => ({
    path,
    hits: fileHits
      .sort((a, b) => a.line - b.line)
      .map((hit): SearchContentHit => ({
        line: hit.line,
        text: hit.preview,
        before: [],
        after: [],
      })),
  }));

  const totalHits = hits.length;
  const totalFiles = byFile.size;

  // Apply limit: keep all files but truncate hits if over limit
  if (totalHits > limit) {
    let remaining = limit;
    const limitedFiles: SearchContentFile[] = [];
    for (const file of files) {
      if (remaining <= 0) break;
      const take = Math.min(remaining, file.hits.length);
      limitedFiles.push({ path: file.path, hits: file.hits.slice(0, take) });
      remaining -= take;
    }
    return { files: limitedFiles, totalHits, totalFiles };
  }

  return { files, totalHits, totalFiles };
}

export type HarnessSearchService = ReturnType<typeof createHarnessSearchService>;

export function createHarnessSearchService(deps: HarnessSearchDeps) {
  return {
    async search(
      params: SearchContentParams,
      ctx: { workspaceId: string | null; signal: AbortSignal },
    ): Promise<SearchContentResult> {
      if (!ctx.workspaceId) {
        return { status: "unavailable", files: [], totalHits: 0, totalFiles: 0, searchedFiles: 0, partial: false };
      }

      const limit = params.limit ?? DEFAULT_LIMIT;
      const timeoutMs = DEFAULT_TIMEOUT_MS;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      // Also abort if the parent signal aborts
      if (ctx.signal.aborted) controller.abort();
      ctx.signal.addEventListener("abort", () => controller.abort(), { once: true });

      try {
        const result = await deps.search(
          {
            query: params.pattern,
            workspaceId: ctx.workspaceId,
            maxResults: limit * 3, // Over-fetch for grouping
          },
          { signal: controller.signal },
        );

        if (result.status === "empty") {
          return { status: "empty", files: [], totalHits: 0, totalFiles: 0, searchedFiles: 0, partial: false };
        }
        if (result.status === "failure" || result.status === "cancelled") {
          return { status: "unavailable", files: [], totalHits: 0, totalFiles: 0, searchedFiles: 0, partial: false };
        }
        if (result.status === "ready") {
          const root = await deps.resolveWorkspaceRoot(ctx.workspaceId) ?? "";
          const { files, totalHits, totalFiles } = groupAndSort(result.hits, root, limit);
          const partial = totalHits > limit;
          return {
            status: "ready",
            files,
            totalHits,
            totalFiles,
            searchedFiles: totalFiles,
            partial,
          };
        }
        return { status: "unavailable", files: [], totalHits: 0, totalFiles: 0, searchedFiles: 0, partial: false };
      } catch {
        // Timeout or abort
        return { status: "unavailable", files: [], totalHits: 0, totalFiles: 0, searchedFiles: 0, partial: false };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
