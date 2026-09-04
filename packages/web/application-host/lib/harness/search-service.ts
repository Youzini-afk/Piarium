import path from "node:path";
import type { SearchContentParams, SearchContentResult, SearchContentFile, SearchContentHit } from "@piarium/protocol";
import type { WorkspaceContentSearchResult, WorkspaceSearchHit } from "../search/content.js";

export interface HarnessSearchDeps {
  search: (request: { query: string; workspaceId: string; maxResults?: number; paths?: string[] }, options: { signal?: AbortSignal }) => Promise<WorkspaceContentSearchResult>;
  resolveWorkspaceRoot: (workspaceId: string) => Promise<string | null>;
}

const DEFAULT_LIMIT = 100;
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
      ctx: { workspaceId: string | null; workspaceScope?: readonly string[]; signal: AbortSignal },
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
        const root = await deps.resolveWorkspaceRoot(ctx.workspaceId);
        if (!root) {
          return { status: "unavailable", files: [], totalHits: 0, totalFiles: 0, searchedFiles: 0, partial: false };
        }
        const toPrefix = (input: string): string | null => {
          const absolute = path.isAbsolute(input) ? path.resolve(input) : path.resolve(root, input);
          const relative = path.relative(root, absolute);
          if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
          return relative.split(path.sep).join("/").replace(/\/$/, "");
        };
        const comparable = (input: string): string => process.platform === "win32" ? input.toLowerCase() : input;
        const within = (resourceId: string, prefixes: readonly string[]): boolean => {
          const resource = comparable(resourceId);
          return prefixes.some((rawPrefix) => {
            const prefix = comparable(rawPrefix);
            return !prefix || resource === prefix || resource.startsWith(`${prefix}/`);
          });
        };
        const actorPrefixes = ctx.workspaceScope?.map(toPrefix).filter((value): value is string => value !== null) ?? [];
        const requestedPrefixes = params.path === undefined
          ? []
          : [toPrefix(params.path)].filter((value): value is string => value !== null);
        if (
          (ctx.workspaceScope !== undefined && actorPrefixes.length !== ctx.workspaceScope.length)
          || (params.path !== undefined && requestedPrefixes.length !== 1)
        ) {
          return { status: "empty", files: [], totalHits: 0, totalFiles: 0, searchedFiles: 0, partial: false };
        }
        let searchPrefixes: string[] | undefined;
        if (ctx.workspaceScope !== undefined && params.path !== undefined) {
          searchPrefixes = [];
          for (const actorPrefix of actorPrefixes) {
            for (const requestedPrefix of requestedPrefixes) {
              if (within(actorPrefix, [requestedPrefix])) searchPrefixes.push(actorPrefix);
              else if (within(requestedPrefix, [actorPrefix])) searchPrefixes.push(requestedPrefix);
            }
          }
          if (searchPrefixes.length === 0) {
            return { status: "empty", files: [], totalHits: 0, totalFiles: 0, searchedFiles: 0, partial: false };
          }
        } else if (ctx.workspaceScope !== undefined) {
          searchPrefixes = [...actorPrefixes];
        } else if (params.path !== undefined) {
          searchPrefixes = [...requestedPrefixes];
        }
        if (searchPrefixes) {
          const minimal: string[] = [];
          for (const prefix of [...new Set(searchPrefixes)].sort((left, right) => left.length - right.length)) {
            if (!within(prefix, minimal)) minimal.push(prefix);
          }
          searchPrefixes = minimal;
        }
        const result = await deps.search(
          {
            query: params.pattern,
            workspaceId: ctx.workspaceId,
            maxResults: limit * 3, // Over-fetch for grouping
            ...(searchPrefixes ? { paths: searchPrefixes.map((prefix) => prefix || ".") } : {}),
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
          const hits = result.hits.filter((hit) => {
            const resourceId = toPrefix(hit.resource.resourceId);
            if (resourceId === null) return false;
            return (
              (ctx.workspaceScope === undefined || within(resourceId, actorPrefixes))
              && (params.path === undefined || within(resourceId, requestedPrefixes))
            );
          });
          if (hits.length === 0) {
            return { status: "empty", files: [], totalHits: 0, totalFiles: 0, searchedFiles: 0, partial: false };
          }
          const { files, totalHits, totalFiles } = groupAndSort(hits, root, limit);
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
