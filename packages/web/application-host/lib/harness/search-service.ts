import path from "node:path";
import type { SearchContentParams, SearchContentResult, SearchContentFile, SearchContentHit } from "@piarium/protocol";
import type { AgentInputContext, HarnessActorContext } from "@piarium/protocol";
import type { WorkspaceContentSearchResult, WorkspaceSearchHit } from "../search/content.js";
import type { ExploreFileReader } from "./explore-file-reader.js";
import { compileGlobFilter } from "./glob-matcher.js";
import { uniqueFileCoverage } from "./explore-distinctiveness.js";

export interface HarnessSearchDeps {
  search: (request: {
    query: string;
    workspaceId: string;
    maxResults?: number;
    paths?: string[];
    glob?: string[];
    excludeResourceIds?: string[];
    ignoreCase?: boolean;
    fixedStrings?: boolean;
  }, options: { signal?: AbortSignal }) => Promise<WorkspaceContentSearchResult>;
  resolveWorkspaceRoot: (workspaceId: string) => Promise<string | null>;
  readFile?: ExploreFileReader;
  /** Dirty paths this turn's fixed source still owns (D-088). */
  draftPaths?: (sessionId: string, context: AgentInputContext) => readonly string[];
  /**
   * Isolated Thread Run corpus. A non-null result is exclusive: never merge
   * parent or worktree disk hits into the same answer.
   */
  branchCorpus?: (sessionId: string) => Promise<Array<{ path: string; text: string }> | null>;
}

export interface HarnessSearchContext {
  workspaceId: string | null;
  workspaceScope?: readonly string[];
  signal: AbortSignal;
  actor?: HarnessActorContext;
  inputContext?: AgentInputContext;
  /**
   * Explore-only working hit budget. Absent for `search.content` / grep, which
   * keep `params.limit` as the displayed-hit cap and `maxResults = 3 * limit`.
   */
  candidateBudget?: number;
  /** Explore-only per-file hit cap applied before the working budget. */
  hitsPerFile?: number;
  /**
   * Immutable WorkingState corpus pinned at explore.query.start.
   * When present, lexical search consumes this snapshot instead of a live branch read.
   */
  pinnedBranchCorpus?: Array<{ path: string; text: string }> | null;
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

function toSearchFile(path: string, fileHits: WorkspaceSearchHit[]): SearchContentFile {
  return {
    path,
    hits: fileHits.map((hit): SearchContentHit => ({
      line: hit.line,
      text: hit.preview,
      before: hit.before ?? [],
      after: hit.after ?? [],
    })),
  };
}

function takeDepthFirst(files: SearchContentFile[], limit: number): SearchContentFile[] {
  let remaining = limit;
  const limited: SearchContentFile[] = [];
  for (const file of files) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, file.hits.length);
    limited.push({ path: file.path, hits: file.hits.slice(0, take) });
    remaining -= take;
  }
  return limited;
}

/** Round-robin one hit per file, then deepen. Drops files only when file count exceeds the budget. */
function takeBreadthFirst(files: SearchContentFile[], limit: number): { files: SearchContentFile[]; filesDropped: number } {
  const kept = files.length > limit ? files.slice(0, limit) : files;
  const filesDropped = files.length - kept.length;
  const cursors = kept.map((file) => ({ path: file.path, source: file.hits, hits: [] as SearchContentHit[] }));
  let remaining = limit;
  let depth = 0;
  while (remaining > 0) {
    let progressed = false;
    for (const cursor of cursors) {
      if (remaining <= 0) break;
      if (depth < cursor.source.length) {
        cursor.hits.push(cursor.source[depth]!);
        remaining -= 1;
        progressed = true;
      }
    }
    if (!progressed) break;
    depth += 1;
  }
  return {
    files: cursors.filter((cursor) => cursor.hits.length > 0).map(({ path, hits }) => ({ path, hits })),
    filesDropped,
  };
}

function groupAndSort(
  hits: WorkspaceSearchHit[],
  root: string,
  limit: number,
  options?: { hitsPerFile?: number; useFileScore?: boolean; breadthFirst?: boolean },
): { files: SearchContentFile[]; totalHits: number; totalFiles: number; perFileCapped: boolean; filesDropped: number } {
  const byFile = new Map<string, WorkspaceSearchHit[]>();
  for (const hit of hits) {
    const path = hit.resource.resourceId;
    const fileHits = byFile.get(path) ?? [];
    fileHits.push(hit);
    byFile.set(path, fileHits);
  }

  const hitsPerFile = options?.hitsPerFile;
  let perFileCapped = false;
  const prepared = Array.from(byFile.entries()).map(([path, fileHits]) => {
    const ordered = [...fileHits].sort((a, b) => a.line - b.line);
    if (hitsPerFile !== undefined && ordered.length > hitsPerFile) {
      perFileCapped = true;
      return { path, hits: ordered.slice(0, hitsPerFile) };
    }
    return { path, hits: ordered };
  });

  const useFileScore = options?.useFileScore !== false;
  const scored = prepared.map((file) => ({
    ...file,
    score: useFileScore
      ? fileScore({
        hits: file.hits.length,
        path: file.path,
        root,
        gitModified: false, // TODO: integrate with git status
        ageDays: 0, // TODO: integrate with file mtime
      })
      : 0,
  }));
  scored.sort((a, b) => {
    if (useFileScore && b.score !== a.score) return b.score - a.score;
    return a.path.localeCompare(b.path);
  });

  const files: SearchContentFile[] = scored.map(({ path, hits: fileHits }) => toSearchFile(path, fileHits));
  const totalHits = hits.length;
  const totalFiles = byFile.size;
  const displayedHits = files.reduce((sum, file) => sum + file.hits.length, 0);

  if (displayedHits <= limit) {
    return { files, totalHits, totalFiles, perFileCapped, filesDropped: 0 };
  }
  if (options?.breadthFirst === true) {
    const allocated = takeBreadthFirst(files, limit);
    return { files: allocated.files, totalHits, totalFiles, perFileCapped, filesDropped: allocated.filesDropped };
  }
  return { files: takeDepthFirst(files, limit), totalHits, totalFiles, perFileCapped, filesDropped: 0 };
}

const unavailableResult = (): SearchContentResult => ({
  status: "unavailable",
  files: [],
  totalHits: 0,
  totalFiles: 0,
  searchedFiles: 0,
  partial: false,
});

const emptyResult = (): SearchContentResult => ({
  status: "empty",
  files: [],
  totalHits: 0,
  totalFiles: 0,
  searchedFiles: 0,
  partial: false,
});

const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** SearchContent uses ripgrep's default line-oriented regular-expression mode. */
const compileDraftPattern = (pattern: string, fixedStrings: boolean | undefined, ignoreCase: boolean | undefined): RegExp | null => {
  try {
    return new RegExp(fixedStrings ? escapeRegex(pattern) : pattern, ignoreCase ? "i" : "");
  } catch {
    return null;
  }
};

const splitLines = (content: string): string[] => {
  if (content.length === 0) return [];
  const lines = content.split(/\r\n|\n|\r/);
  // A line terminator closes the final line; it does not create another
  // searchable empty line (matching ripgrep's line-oriented output).
  if (/\r\n$|[\n\r]$/u.test(content)) lines.pop();
  return lines;
};

interface SearchContextWindow {
  before: number;
  after: number;
}

const contextWindowFor = (params: SearchContentParams): SearchContextWindow => ({
  before: Math.max(0, params.before ?? params.context ?? 0),
  after: Math.max(0, params.after ?? params.context ?? 0),
});

const hasContext = (window: SearchContextWindow): boolean => window.before > 0 || window.after > 0;

const withContext = (lines: string[], line: number, window: SearchContextWindow): { before: string[]; after: string[] } => ({
  before: window.before > 0 ? lines.slice(Math.max(0, line - 1 - window.before), line - 1) : [],
  after: window.after > 0 ? lines.slice(line, line + window.after) : [],
});

const draftHitsFor = (
  pathName: string,
  workspaceId: string,
  content: string,
  matcher: RegExp,
  window: SearchContextWindow,
): WorkspaceSearchHit[] => {
  const lines = splitLines(content);
  return lines.flatMap((text, index) => {
    const column = text.search(matcher);
    return column < 0 ? [] : [{
      resource: { workspaceId, resourceId: pathName },
      line: index + 1,
      column: column + 1,
      preview: text,
      ...withContext(lines, index + 1, window),
    }];
  });
};

export type HarnessSearchService = ReturnType<typeof createHarnessSearchService>;

export function createHarnessSearchService(deps: HarnessSearchDeps) {
  return {
    async search(
      params: SearchContentParams,
      ctx: HarnessSearchContext,
    ): Promise<SearchContentResult> {
      if (!ctx.workspaceId) {
        return unavailableResult();
      }

      const candidateMode = ctx.candidateBudget !== undefined;
      const limit = candidateMode ? ctx.candidateBudget! : (params.limit ?? DEFAULT_LIMIT);
      const timeoutMs = DEFAULT_TIMEOUT_MS;
      const groupOptions = {
        ...(ctx.hitsPerFile !== undefined ? { hitsPerFile: ctx.hitsPerFile } : {}),
        ...(candidateMode ? { useFileScore: false, breadthFirst: true } : {}),
      };

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      // Also abort if the parent signal aborts
      if (ctx.signal.aborted) controller.abort();
      ctx.signal.addEventListener("abort", () => controller.abort(), { once: true });

      try {
        const root = await deps.resolveWorkspaceRoot(ctx.workspaceId);
        if (!root) {
          return unavailableResult();
        }
        const inputContext = ctx.inputContext ?? { source: "disk" as const };
        if (inputContext.source === "surface" && inputContext.workspaceId !== ctx.workspaceId) {
          return unavailableResult();
        }
        if (typeof params.pattern !== "string" || !params.pattern.trim()) return emptyResult();
        const contextWindow = contextWindowFor(params);
        const globFilter = compileGlobFilter(params.glob);
        if (!globFilter) return unavailableResult();
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
          return emptyResult();
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
            return emptyResult();
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

        const pinnedCorpus = ctx.pinnedBranchCorpus;
        if (pinnedCorpus || (deps.branchCorpus && ctx.actor)) {
          const corpus = pinnedCorpus ?? await deps.branchCorpus!(ctx.actor!.sessionId);
          if (corpus) {
            const matcher = compileDraftPattern(params.pattern.trim(), params.fixedStrings, params.ignoreCase);
            if (!matcher) return unavailableResult();
            const hits: WorkspaceSearchHit[] = [];
            for (const file of corpus) {
              controller.signal.throwIfAborted();
              if (searchPrefixes && !within(file.path, searchPrefixes)) continue;
              if (!globFilter.matches(file.path)) continue;
              hits.push(...draftHitsFor(file.path, ctx.workspaceId, file.text, matcher, contextWindow));
            }
            if (hits.length === 0) return emptyResult();
            const grouped = groupAndSort(hits, root, limit, groupOptions);
            return {
              status: "ready",
              files: grouped.files,
              totalHits: grouped.totalHits,
              totalFiles: grouped.totalFiles,
              searchedFiles: grouped.totalFiles,
              partial: grouped.totalHits > limit || grouped.perFileCapped || grouped.filesDropped > 0,
              ...(candidateMode ? {
                filesDropped: grouped.filesDropped,
                fileCoverage: uniqueFileCoverage({
                  filesDropped: grouped.filesDropped,
                  backendIncomplete: false,
                  backendCapped: false,
                }),
              } : {}),
            };
          }
        }

        // A path written during this turn is no longer draft-owned: its disk
        // hits must be searched normally instead of replaced by the older
        // draft, which would hide the agent's own write (D-088).
        const ownedDirtyPaths = inputContext.source === "surface"
          ? (ctx.actor && deps.draftPaths
            ? deps.draftPaths(ctx.actor.sessionId, inputContext)
            : inputContext.dirtyPaths)
          : [];
        const dirtyPaths = inputContext.source === "surface"
          ? [...new Set(ownedDirtyPaths
            .map((dirtyPath) => toPrefix(dirtyPath))
            .filter((dirtyPath): dirtyPath is string => dirtyPath !== null))]
            .filter((dirtyPath) => (
              (ctx.workspaceScope === undefined || within(dirtyPath, actorPrefixes))
              && (params.path === undefined || within(dirtyPath, requestedPrefixes))
              && globFilter.matches(dirtyPath)
            ))
          : [];
        const dirtyPathKeys = new Set(dirtyPaths.map((dirtyPath) => comparable(dirtyPath)));
        const draftHits: WorkspaceSearchHit[] = [];
        if (dirtyPaths.length > 0) {
          if (!deps.readFile || !ctx.actor || inputContext.source !== "surface" || inputContext.workspaceId !== ctx.workspaceId) {
            return unavailableResult();
          }
          const matcher = compileDraftPattern(params.pattern.trim(), params.fixedStrings, params.ignoreCase);
          if (!matcher) return unavailableResult();
          let snapshots: Array<readonly [string, Awaited<ReturnType<ExploreFileReader>>]>;
          try {
            snapshots = await Promise.all(dirtyPaths.map(async (dirtyPath) => {
              controller.signal.throwIfAborted();
              return [dirtyPath, await deps.readFile!(ctx.actor!, dirtyPath, controller.signal, inputContext)] as const;
            }));
          } catch {
            controller.signal.throwIfAborted();
            return unavailableResult();
          }
          for (const [dirtyPath, snapshot] of snapshots) {
            if (snapshot.status !== "ready" || snapshot.source !== "surface-draft") return unavailableResult();
            draftHits.push(...draftHitsFor(dirtyPath, ctx.workspaceId, snapshot.content, matcher, contextWindow));
          }
        }
        let contextIncomplete = false;
        const result = await deps.search(
          {
            query: params.pattern,
            workspaceId: ctx.workspaceId,
            // A surface overlay must be merged with every disk hit before the
            // service applies its own ranking and limit. The backend excludes
            // dirty paths before counting this bounded over-fetch.
            maxResults: limit * 3,
            ...(searchPrefixes ? { paths: searchPrefixes.map((prefix) => prefix || ".") } : {}),
            ...(globFilter.rgPatterns.length > 0 ? { glob: globFilter.rgPatterns } : {}),
            ...(dirtyPaths.length > 0 ? { excludeResourceIds: dirtyPaths } : {}),
            ...(params.ignoreCase !== undefined ? { ignoreCase: params.ignoreCase } : {}),
            ...(params.fixedStrings !== undefined ? { fixedStrings: params.fixedStrings } : {}),
          },
          { signal: controller.signal },
        );
        controller.signal.throwIfAborted();

        // The backend produced matches and then hit a non-fatal error, so its
        // sweep did not cover everything. The hits are usable; the caller has
        // to be told the coverage is partial (D-142).
        const backendIncomplete = (result as { incomplete?: boolean }).incomplete === true;
        if (result.status === "empty") {
          if (draftHits.length === 0) return emptyResult();
          const grouped = groupAndSort(draftHits, root, limit, groupOptions);
          return {
            status: "ready",
            files: grouped.files,
            totalHits: grouped.totalHits,
            totalFiles: grouped.totalFiles,
            searchedFiles: grouped.totalFiles,
            partial: backendIncomplete || grouped.totalHits > limit || grouped.perFileCapped || grouped.filesDropped > 0,
            ...(candidateMode ? {
              filesDropped: grouped.filesDropped,
              fileCoverage: uniqueFileCoverage({
                filesDropped: grouped.filesDropped,
                backendIncomplete,
                backendCapped: false,
              }),
            } : {}),
          };
        }
        if (result.status === "failure" || result.status === "cancelled") {
          return unavailableResult();
        }
        if (result.status === "ready") {
          let hits = result.hits.filter((hit) => {
            const resourceId = toPrefix(hit.resource.resourceId);
            if (resourceId === null) return false;
            if (dirtyPathKeys.has(comparable(resourceId))) return false;
            return (
              (ctx.workspaceScope === undefined || within(resourceId, actorPrefixes))
              && (params.path === undefined || within(resourceId, requestedPrefixes))
              && globFilter.matches(resourceId)
            );
          });
          hits = hits.map((hit) => {
            const resourceId = toPrefix(hit.resource.resourceId)!;
            return {
              ...hit,
              resource: { ...hit.resource, resourceId },
            };
          });
          if (hasContext(contextWindow) && hits.some((hit) => hit.before === undefined || hit.after === undefined)) {
            if (!deps.readFile || !ctx.actor) return unavailableResult();
            const paths = [...new Set(hits
              .filter((hit) => hit.before === undefined || hit.after === undefined)
              .map((hit) => hit.resource.resourceId))];
            const snapshots = await Promise.all(paths.map(async (resourceId) => {
              controller.signal.throwIfAborted();
              return [resourceId, await deps.readFile!(ctx.actor!, resourceId, controller.signal, inputContext)] as const;
            }));
            const linesByPath = new Map<string, string[]>();
            for (const [resourceId, snapshot] of snapshots) {
              if (snapshot.status !== "ready") return unavailableResult();
              linesByPath.set(resourceId, splitLines(snapshot.content));
            }
            hits = hits.map((hit) => {
              if (hit.before !== undefined && hit.after !== undefined) return hit;
              const lines = linesByPath.get(hit.resource.resourceId) ?? [];
              if (lines[hit.line - 1] !== hit.preview) {
                contextIncomplete = true;
                return { ...hit, before: [], after: [] };
              }
              return { ...hit, ...withContext(lines, hit.line, contextWindow) };
            });
          }
          const mergedHits = [...hits, ...draftHits];
          if (mergedHits.length === 0) {
            return emptyResult();
          }
          const { files, totalHits, totalFiles, perFileCapped, filesDropped } = groupAndSort(mergedHits, root, limit, groupOptions);
          const backendCapped = hits.length >= limit * 3;
          const partial = backendIncomplete || totalHits > limit || contextIncomplete || perFileCapped || backendCapped || filesDropped > 0;
          return {
            status: "ready",
            files,
            totalHits,
            totalFiles,
            searchedFiles: totalFiles,
            partial,
            ...(candidateMode ? {
              filesDropped,
              fileCoverage: uniqueFileCoverage({
                filesDropped,
                backendIncomplete,
                backendCapped,
              }),
            } : {}),
          };
        }
        return unavailableResult();
      } catch {
        // Timeout or abort
        return unavailableResult();
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
