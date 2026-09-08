import type {
  AgentInputContext,
  ExploreFileRelation,
  ExploreRelationStatus,
  HarnessActorContext,
  HarnessServiceMap,
} from "@piarium/protocol";
import type { HarnessService } from "./router.js";
import type { HarnessServiceHost } from "./service-host.js";
import { HarnessServiceError } from "./service-error.js";
import {
  DEFAULT_BYTE_BUDGET,
  DEFAULT_CANDIDATE_BUDGET,
  DEFAULT_HITS_PER_FILE,
  explore,
  formatExploreOutput,
  type ExploreIssue,
} from "./explore.js";
import type { ExploreGraphRecall } from "./explore-graph.js";

type ExploreParams = HarnessServiceMap["explore.search"]["params"];

const comparable = (value: string): string => (
  process.platform === "win32" ? value.replace(/\\/g, "/").toLowerCase() : value.replace(/\\/g, "/")
);

const within = (candidate: string, prefix: string): boolean => {
  const path = comparable(candidate).replace(/^\.\//, "");
  const root = comparable(prefix).replace(/^\.\//, "").replace(/\/$/, "");
  return !root || path === root || path.startsWith(`${root}/`);
};

const ownedDirtyPathsFor = (
  inputContext: AgentInputContext,
  actor: HarnessActorContext,
  params: ExploreParams,
  authorizedPaths: ReadonlyArray<{ resourceId: string }>,
  draftPaths?: (sessionId: string, context: AgentInputContext) => readonly string[],
): string[] => {
  if (inputContext.source !== "surface") return [];
  const owned = draftPaths ? draftPaths(actor.sessionId, inputContext) : inputContext.dirtyPaths;
  return owned.filter((dirtyPath) => (
    params.paths === undefined
    || authorizedPaths.some((authorized) => within(dirtyPath, authorized.resourceId))
  ));
};

/**
 * Graph relations decorate a result that already succeeded, so a broken or
 * unopened knowledge store degrades the annotation and never fails the search
 * (plan 0.4). A revision that differs from the excerpt is reported as `stale`
 * rather than printed as current (agent-harness 7.2, D-112).
 */
async function loadSnippetRelations(
  host: Pick<HarnessServiceHost, "fileRelations">,
  workspaceId: string,
  snippets: ReadonlyArray<{ path: string; revision: string }>,
  signal: AbortSignal,
): Promise<{ status: ExploreRelationStatus; files: ExploreFileRelation[] } | undefined> {
  if (!host.fileRelations || snippets.length === 0) return undefined;
  const excerptRevisions = new Map<string, string>();
  for (const snippet of snippets) {
    if (!excerptRevisions.has(snippet.path)) excerptRevisions.set(snippet.path, snippet.revision);
  }
  const files: ExploreFileRelation[] = [];
  let asked = 0;
  let answered = 0;
  for (const [path, excerptRevision] of excerptRevisions) {
    signal.throwIfAborted();
    asked += 1;
    let relation: Awaited<ReturnType<NonNullable<HarnessServiceHost["fileRelations"]>>>;
    try {
      relation = await host.fileRelations(workspaceId, path);
    } catch {
      continue;
    }
    answered += 1;
    if (!relation) continue;
    if (relation.imports.length === 0 && relation.connections.length === 0 && relation.associations.length === 0) continue;
    files.push({ ...relation, stale: relation.documentRevision !== excerptRevision });
  }
  const status: ExploreRelationStatus = answered === asked ? "ready" : answered === 0 ? "unavailable" : "partial";
  if (files.length === 0 && status === "ready") return undefined;
  files.sort((left, right) => left.path.localeCompare(right.path));
  return { status, files };
}

export function createExploreSearchService(
  host: Pick<HarnessServiceHost, "searchService" | "outputStore" | "readExploreFile" | "agentInputDraftPaths" | "structureSource" | "fileRelations" | "graphRecall">,
  /**
   * Window traces are an observation meter, not a product field: one entry per
   * generated window with its hit text, measured at 482 windows / 185 KB for a
   * content-word question, against a 24 KiB visible budget. Off unless a meter
   * asks for them (D-157).
   */
  options?: { traceWindows?: boolean },
): HarnessService<"explore.search"> {
  return {
    handle: async (params, ctx) => {
      if (typeof params.question !== "string" || !params.question.trim()) {
        throw new HarnessServiceError("invalid-params", "Provide a non-empty search question.");
      }
      if (params.limit !== undefined && (!Number.isSafeInteger(params.limit) || params.limit < 1)) {
        throw new HarnessServiceError("invalid-params", "The excerpt limit must be a positive integer.");
      }
      if (params.paths !== undefined && (!Array.isArray(params.paths) || params.paths.some((path) => typeof path !== "string" || !path.trim()))) {
        throw new HarnessServiceError("invalid-params", "Search paths must be non-empty strings.");
      }
      if (params.anchors !== undefined && (!Array.isArray(params.anchors) || params.anchors.some((anchor) => typeof anchor !== "string"))) {
        throw new HarnessServiceError("invalid-params", "Anchors must be an array of strings.");
      }
      const workspaceId = ctx.actor.workspaceId;
      const readFile = host.readExploreFile;
      if (!workspaceId || !readFile) throw new HarnessServiceError("unavailable", "Workspace document reading is unavailable.");
      ctx.signal.throwIfAborted();
      const inputContext = ctx.inputContext ?? { source: "disk" as const };
      let searchPartial = false;
      const result = await explore(params, {
        rgSearch: async (pattern, options) => {
          const roots: Array<string | undefined> = options.paths?.length ? [...new Set(options.paths)] : [undefined];
          const batches = await Promise.all(roots.map(async (path) => {
            ctx.signal.throwIfAborted();
            const search = await host.searchService.search({
              pattern,
              fixedStrings: options.fixedStrings,
              ...(path !== undefined ? { path } : {}),
            }, {
              workspaceId,
              actor: ctx.actor,
              inputContext,
              candidateBudget: options.candidateBudget ?? DEFAULT_CANDIDATE_BUDGET,
              hitsPerFile: options.hitsPerFile ?? DEFAULT_HITS_PER_FILE,
              ...(ctx.actor.workspaceScope !== undefined ? { workspaceScope: ctx.actor.workspaceScope } : {}),
              signal: ctx.signal,
            });
            ctx.signal.throwIfAborted();
            if (search.status === "unavailable") {
              const dirtyIssues = await collectDirtySourceIssues(params, ctx, inputContext, host, readFile);
              if (dirtyIssues.length > 0) {
                throw new HarnessServiceError(
                  "unavailable",
                  `No current excerpts could be read: ${dirtyIssues.map((issue) => `${issue.path} (${issue.status})`).join(", ")}. Search again.`,
                );
              }
              throw new HarnessServiceError("unavailable", "Search service is unavailable. Retry or inspect workspace availability.");
            }
            const callPartial = search.partial || (search.filesDropped ?? 0) > 0;
            return {
              hits: search.files.flatMap((file) => file.hits.map((hit) => ({ path: file.path, line: hit.line, text: hit.text }))),
              partial: callPartial,
              filesDropped: search.filesDropped ?? 0,
              fileCoverage: search.fileCoverage
                ?? ((search.filesDropped ?? 0) > 0 ? "lower-bound" as const : callPartial ? "unknown" as const : "complete" as const),
            };
          }));
          const callPartial = batches.some((batch) => batch.partial);
          // Search roots may overlap (`src` and `src/lib`), so summing would double-count files.
          const callFilesDropped = batches.reduce((most, batch) => Math.max(most, batch.filesDropped), 0);
          const callCoverage = batches.some((batch) => batch.fileCoverage === "lower-bound")
            ? "lower-bound" as const
            : batches.some((batch) => batch.fileCoverage === "unknown")
              ? "unknown" as const
              : "complete" as const;
          searchPartial ||= callPartial;
          return {
            hits: batches.flatMap((batch) => batch.hits),
            partial: callPartial,
            filesDropped: callFilesDropped,
            fileCoverage: callCoverage,
          };
        },
        readFile: (path) => readFile(ctx.actor, path, ctx.signal, inputContext),
        ...(host.structureSource ? {
          structure: {
            outline: (request) => host.structureSource!.outline({
              ...request,
              workspaceId,
              sessionId: ctx.sessionId,
              inputContext,
            }),
            classifyHits: (request) => host.structureSource!.classifyHits({
              ...request,
              workspaceId,
              sessionId: ctx.sessionId,
              inputContext,
            }),
            literalCalls: (request) => host.structureSource!.literalCalls({
              ...request,
              workspaceId,
              sessionId: ctx.sessionId,
              inputContext,
            }),
          },
        } : {}),
        ...(host.graphRecall ? { graph: bindExploreGraphRecall(host.graphRecall, workspaceId) } : {}),
      }, ctx.signal);
      if (result.snippets.length === 0 && result.issues.length > 0) {
        throw new HarnessServiceError("unavailable", `No current excerpts could be read: ${result.issues.map((issue) => `${issue.path} (${issue.status})`).join(", ")}. Search again.`);
      }
      const incomplete = searchPartial || result.searched.incomplete;
      const relations = await loadSnippetRelations(host, workspaceId, result.snippets, ctx.signal);
      const formatted = {
        snippets: result.snippets,
        issues: result.issues,
        notRequested: result.notRequested,
        omitted: result.omitted,
        partial: searchPartial || result.partial,
        searchIncomplete: searchPartial || result.searchIncomplete,
        searched: {
          patterns: result.searched.patterns,
          files: result.searched.files,
          ms: result.searched.ms,
          incomplete,
          ...(result.searched.filesDropped !== undefined ? { filesDropped: result.searched.filesDropped } : {}),
        },
        ...(relations ? { relations } : {}),
        ...(result.details.graph ? { graph: result.details.graph } : {}),
        ...(result.details.skippedQueries ? { skippedQueries: result.details.skippedQueries } : {}),
      };
      const preview = formatExploreOutput(formatted, { byteBudget: DEFAULT_BYTE_BUDGET });
      const stored = host.outputStore.store(ctx.sessionId, preview.storedBody, "explore");
      const packed = formatExploreOutput(formatted, { byteBudget: DEFAULT_BYTE_BUDGET, handle: stored.ref.handle });
      return {
        text: packed.visibleText,
        snippets: result.snippets,
        issues: result.issues,
        notRequested: result.notRequested,
        omitted: packed.omitted,
        partial: searchPartial || result.partial,
        searched: formatted.searched,
        handle: stored.ref.handle,
        details: {
          provenance: result.details.provenance,
          anchors: result.details.anchors,
          byteBudget: DEFAULT_BYTE_BUDGET,
          ...(result.details.structure ? { structure: result.details.structure } : {}),
          ...(relations ? { relations } : {}),
          ...(result.details.graph ? { graph: result.details.graph } : {}),
          ...(result.details.query ? { query: result.details.query } : {}),
          ...(result.details.skippedQueries ? { skippedQueries: result.details.skippedQueries } : {}),
          ...(result.details.distinctiveness ? { distinctiveness: result.details.distinctiveness } : {}),
          ...(options?.traceWindows && result.details.windows ? { windows: result.details.windows } : {}),
        },
      };
    },
  };
}

function bindExploreGraphRecall(
  getStore: NonNullable<HarnessServiceHost["graphRecall"]>,
  workspaceId: string,
): ExploreGraphRecall {
  const requireStore = (): NonNullable<ReturnType<typeof getStore>> => {
    const store = getStore(workspaceId);
    if (!store) throw Object.assign(new Error("knowledge store is not open"), { code: "unavailable" });
    return store;
  };
  return {
    catalogStats: async () => requireStore().catalogStats(),
    searchDefinitions: (query, k) => requireStore().searchSymbols(query, k),
    findLinks: (value) => requireStore().findLinks(value),
    fileRelations: async (path) => {
      const relations = await requireStore().getFileRelations(path);
      if (!relations) return null;
      return {
        connections: relations.connections.map(({ callee, literal }) => ({ callee, literal })),
        linksIncomplete: relations.linksIncomplete,
      };
    },
    findImporters: (path) => requireStore().findImporters(path),
  };
}

async function collectDirtySourceIssues(
  params: ExploreParams,
  ctx: { actor: HarnessActorContext; sessionId: string; signal: AbortSignal; authorizedPaths: ReadonlyArray<{ resourceId: string }> },
  inputContext: AgentInputContext,
  host: Pick<HarnessServiceHost, "agentInputDraftPaths">,
  readFile: NonNullable<HarnessServiceHost["readExploreFile"]>,
): Promise<ExploreIssue[]> {
  const dirtyPaths = ownedDirtyPathsFor(inputContext, ctx.actor, params, ctx.authorizedPaths, host.agentInputDraftPaths);
  const issues: ExploreIssue[] = [];
  for (const path of dirtyPaths) {
    ctx.signal.throwIfAborted();
    const snapshot = await readFile(ctx.actor, path, ctx.signal, inputContext);
    if (snapshot.status !== "ready" && snapshot.status !== "forbidden") {
      issues.push({ path, status: snapshot.status, message: snapshot.message });
    }
  }
  return issues;
}
