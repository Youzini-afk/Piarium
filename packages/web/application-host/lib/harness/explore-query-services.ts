import type {
  AgentInputContext,
  ExploreModelParticipation,
  ExploreQueryCancelParams,
  ExploreQueryFinishParams,
  ExploreQueryFollowupParams,
  ExploreQueryPlanParams,
  ExploreQueryReleaseParams,
  ExploreQuerySelectParams,
  ExploreQueryStartParams,
  ExploreQueryViewsParams,
  ExploreSearchResult,
  HarnessServiceMap,
} from "@piarium/protocol";
import {
  documentsFromViews,
  exploreShouldRerank,
  rerankFailureDetails,
  rerankSettingsFromSnapshot,
  scoresFromRerankResult,
} from "./explore-rerank.js";
import { HARNESS_MAX_REQUEST_TIMEOUT_MS } from "@piarium/protocol";
import type { HarnessService, HarnessServiceContext } from "./router.js";
import type { HarnessServiceHost } from "./service-host.js";
import { HarnessServiceError } from "./service-error.js";
import {
  DEFAULT_BYTE_BUDGET,
  DEFAULT_CANDIDATE_BUDGET,
  DEFAULT_EXPLORE_QUERY_BUDGET_MS,
  DEFAULT_HITS_PER_FILE,
  DEFAULT_JUDGE_RESERVE_MS,
  DEFAULT_SEMANTIC_RECALL,
  formatExploreOutput,
  type ExploreDeps,
  type ExploreIssue,
} from "./explore.js";
import { pathInRoots, type ExploreGraphRecall } from "./explore-graph.js";
import type { StoredExploreQuery } from "./explore-query-store.js";
import { actorFromHarness, exploreQueryActorsMatch } from "./explore-query-identity.js";
import { loadSnippetRelations } from "./explore-service.js";

type ExploreParams = HarnessServiceMap["explore.search"]["params"];

export function bindExploreGraphRecall(
  getStore: NonNullable<HarnessServiceHost["graphRecall"]>,
  workspaceId: string,
  roots?: readonly string[],
): ExploreGraphRecall {
  const requireStore = (): NonNullable<ReturnType<typeof getStore>> => {
    const store = getStore(workspaceId);
    if (!store) throw Object.assign(new Error("knowledge store is not open"), { code: "unavailable" });
    return store;
  };
  return {
    catalogStats: async () => requireStore().catalogStats(),
    searchDefinitions: (query, k) => requireStore().searchSymbols(query, k, roots),
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

export function createExploreDeps(
  host: Pick<HarnessServiceHost, "searchService" | "readExploreFile" | "structureSource" | "graphRecall" | "semanticRecall" | "agentInputDraftPaths">,
  ctx: HarnessServiceContext,
  inputContext: AgentInputContext,
  signal: AbortSignal = ctx.signal,
  roots?: readonly string[],
): ExploreDeps {
  const workspaceId = ctx.actor.workspaceId;
  const readFile = host.readExploreFile;
  if (!workspaceId || !readFile) throw new HarnessServiceError("unavailable", "Workspace document reading is unavailable.");
  const deps: ExploreDeps = {
    rgSearch: async (pattern, options) => {
      const searchRoots: Array<string | undefined> = options.paths?.length ? [...new Set(options.paths)] : [undefined];
      const batches = await Promise.all(searchRoots.map(async (path) => {
        signal.throwIfAborted();
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
          signal,
        });
        signal.throwIfAborted();
        if (search.status === "unavailable") {
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
      return {
        hits: batches.flatMap((batch) => batch.hits),
        partial: batches.some((batch) => batch.partial),
        filesDropped: batches.reduce((most, batch) => Math.max(most, batch.filesDropped), 0),
        fileCoverage: batches.some((batch) => batch.fileCoverage === "lower-bound")
          ? "lower-bound" as const
          : batches.some((batch) => batch.fileCoverage === "unknown")
            ? "unknown" as const
            : "complete" as const,
      };
    },
    readFile: (path) => readFile(ctx.actor, path, signal, inputContext),
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
    ...(host.graphRecall ? { graph: bindExploreGraphRecall(host.graphRecall, workspaceId, roots) } : {}),
    ...(host.semanticRecall ? {
      semantic: {
        search: async (question: string, limit?: number, searchSignal?: AbortSignal) => {
          const active = searchSignal ?? signal;
          active.throwIfAborted();
          return host.semanticRecall!(workspaceId, question, limit ?? DEFAULT_SEMANTIC_RECALL, {
            signal: active,
            sessionId: ctx.sessionId,
            inputContext,
            ...(roots ? { roots } : {}),
          });
        },
      },
    } : {}),
  };
  return deps;
}

function requireQuery(
  host: Pick<HarnessServiceHost, "exploreQueryStore">,
  ctx: HarnessServiceContext,
  queryId: unknown,
  access: "mutate" | "finish" | "read" | "control",
): StoredExploreQuery {
  if (typeof queryId !== "string" || !queryId.trim()) {
    throw new HarnessServiceError("invalid-params", "Provide the explore query id.");
  }
  const stored = host.exploreQueryStore.get(ctx.sessionId, queryId);
  if (!stored) throw new HarnessServiceError("expired", "Explore query is not active in this session.");
  if (!exploreQueryActorsMatch(stored.actor, ctx.actor)) {
    throw new HarnessServiceError("forbidden", "Explore query does not belong to this actor.");
  }
  const terminal = stored.run.terminal();
  if (access === "mutate" && terminal !== "active") {
    throw new HarnessServiceError("expired", "Explore query is no longer active.");
  }
  if ((access === "finish" || access === "read") && terminal === "cancelled") {
    throw new HarnessServiceError("expired", "Explore query was cancelled.");
  }
  if (access === "mutate" || access === "read") {
    const onAbort = (): void => {
      stored.run.cancel();
    };
    if (ctx.signal.aborted) onAbort();
    else ctx.signal.addEventListener("abort", onAbort, { once: true });
  }
  return stored;
}

export async function packExploreSearchResult(
  host: Pick<HarnessServiceHost, "outputStore" | "fileRelations">,
  ctx: HarnessServiceContext,
  result: Awaited<ReturnType<StoredExploreQuery["run"]["finish"]>>,
  options?: { traceWindows?: boolean; searchPartial?: boolean },
): Promise<ExploreSearchResult> {
  const incomplete = (options?.searchPartial ?? false) || result.searched.incomplete;
  const relations = ctx.workspaceId && host.fileRelations
    ? await loadSnippetRelations(host, ctx.workspaceId, result.snippets, ctx.signal)
    : undefined;
  const formatted = {
    snippets: result.snippets,
    issues: result.issues,
    notRequested: result.notRequested,
    omitted: result.omitted,
    partial: (options?.searchPartial ?? false) || result.partial,
    searchIncomplete: (options?.searchPartial ?? false) || result.searchIncomplete,
    searched: {
      patterns: result.searched.patterns,
      files: result.searched.files,
      ms: result.searched.ms,
      incomplete,
      ...(result.searched.filesDropped !== undefined ? { filesDropped: result.searched.filesDropped } : {}),
    },
    ...(result.details.graph ? { graph: result.details.graph } : {}),
    ...(result.details.skippedQueries ? { skippedQueries: result.details.skippedQueries } : {}),
    ...(result.details.model ? { model: result.details.model } : {}),
    ...(result.details.rerank ? { rerank: result.details.rerank } : {}),
    ...(relations ? { relations } : {}),
    ...(result.details.sources ? { sources: result.details.sources } : {}),
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
    partial: formatted.partial,
    searched: formatted.searched,
    handle: stored.ref.handle,
    details: {
      provenance: result.details.provenance,
      anchors: result.details.anchors,
      byteBudget: DEFAULT_BYTE_BUDGET,
      ...(result.details.structure ? { structure: result.details.structure } : {}),
      ...(result.details.graph ? { graph: result.details.graph } : {}),
      ...(result.details.query ? { query: result.details.query } : {}),
      ...(result.details.skippedQueries ? { skippedQueries: result.details.skippedQueries } : {}),
      ...(result.details.distinctiveness ? { distinctiveness: result.details.distinctiveness } : {}),
      ...(options?.traceWindows && result.details.windows ? { windows: result.details.windows } : {}),
      ...(result.details.semantic ? { semantic: result.details.semantic } : {}),
      ...(result.details.model ? { model: result.details.model } : {}),
      ...(result.details.rerank ? { rerank: result.details.rerank } : {}),
      ...(relations ? { relations } : {}),
      ...(result.details.sources ? { sources: result.details.sources } : {}),
    },
  };
}

export function createExploreQueryStartService(
  host: Pick<HarnessServiceHost, "searchService" | "readExploreFile" | "structureSource" | "graphRecall" | "semanticRecall" | "agentInputDraftPaths" | "exploreQueryStore">,
): HarnessService<"explore.query.start"> {
  return {
    handle: async (params: ExploreQueryStartParams, ctx) => {
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
      if (params.budgetMs !== undefined && (
        !Number.isFinite(params.budgetMs)
        || params.budgetMs <= 0
        || params.budgetMs > HARNESS_MAX_REQUEST_TIMEOUT_MS
      )) {
        throw new HarnessServiceError(
          "invalid-params",
          `The explore query budget must be between 1 and ${HARNESS_MAX_REQUEST_TIMEOUT_MS}ms.`,
        );
      }
      if (params.reserveForJudge !== undefined && typeof params.reserveForJudge !== "boolean") {
        throw new HarnessServiceError("invalid-params", "reserveForJudge must be a boolean.");
      }
      ctx.signal.throwIfAborted();
      const inputContext = ctx.inputContext ?? { source: "disk" as const };
      const budgetMs = typeof params.budgetMs === "number"
        ? params.budgetMs
        : DEFAULT_EXPLORE_QUERY_BUDGET_MS;
      const queryController = new AbortController();
      let stored: StoredExploreQuery | undefined;
      const onStartAbort = (): void => {
        if (!queryController.signal.aborted) queryController.abort();
        stored?.run.cancel();
      };
      if (ctx.signal.aborted) onStartAbort();
      else ctx.signal.addEventListener("abort", onStartAbort, { once: true });
      try {
        if (params.paths?.length && ctx.authorizedPaths.length !== params.paths.length) {
          throw new HarnessServiceError("forbidden", "Search paths were not authorized.");
        }
        const effectivePaths = params.paths?.length
          ? ctx.authorizedPaths.map(({ resourceId }) => resourceId || ".")
          : ctx.actor.workspaceScope?.length
            ? [...ctx.actor.workspaceScope]
            : undefined;
        stored = host.exploreQueryStore.start({
          actor: actorFromHarness(ctx.actor),
          inputContext,
          input: {
            question: params.question,
            ...(params.anchors ? { anchors: params.anchors } : {}),
            ...(effectivePaths ? { paths: effectivePaths } : {}),
            ...(params.limit ? { limit: params.limit } : {}),
          },
          deps: createExploreDeps(host, ctx, inputContext, queryController.signal, effectivePaths),
          deadlineAt: Date.now() + budgetMs,
          reserveForJudgeMs: params.reserveForJudge ? DEFAULT_JUDGE_RESERVE_MS : 0,
          controller: queryController,
        });
        await stored.run.refreshVocab();
        ctx.signal.throwIfAborted();
        ctx.deferResponseDelivery?.(
          () => undefined,
          () => { if (stored) host.exploreQueryStore.release(ctx.actor, stored.id); },
        );
        return {
          queryId: stored.id,
          question: stored.run.question,
          deadlineAt: stored.deadlineAt,
          parsed: {
            objects: stored.run.parsed.objects,
            relation: stored.run.parsed.relation,
            domain: stored.run.parsed.domain,
          },
          vocab: stored.run.vocab(),
          sources: stored.run.sourceStates(),
          inputSource: stored.inputContext.source,
        };
      } catch (error) {
        if (stored) host.exploreQueryStore.release(ctx.actor, stored.id);
        else if (!queryController.signal.aborted) queryController.abort();
        throw error;
      } finally {
        ctx.signal.removeEventListener("abort", onStartAbort);
      }
    },
  };
}

export function createExploreQueryPlanService(
  host: Pick<HarnessServiceHost, "exploreQueryStore">,
): HarnessService<"explore.query.plan"> {
  return {
    handle: async (params: ExploreQueryPlanParams, ctx) => {
      const stored = requireQuery(host, ctx, params.queryId, "mutate");
      const submitted = await stored.run.submitPlan(params.plan);
      return {
        queryId: stored.id,
        launched: submitted.launched,
        reused: submitted.reused,
        sources: stored.run.sourceStates(),
      };
    },
  };
}

export function createExploreQueryViewsService(
  host: Pick<HarnessServiceHost, "exploreQueryStore">,
): HarnessService<"explore.query.views"> {
  return {
    handle: async (params: ExploreQueryViewsParams, ctx) => {
      const stored = requireQuery(host, ctx, params.queryId, "read");
      await stored.run.waitForViews();
      const views = stored.run.viewsForModel();
      return {
        queryId: stored.id,
        question: stored.run.question,
        ...(views.hypotheses ? { hypotheses: views.hypotheses } : {}),
        views: views.views,
        unevaluated: views.unevaluated,
        sources: stored.run.sourceStates(),
        deadlineAt: stored.deadlineAt,
      };
    },
  };
}

export function createExploreQuerySelectService(
  host: Pick<HarnessServiceHost, "exploreQueryStore">,
): HarnessService<"explore.query.select"> {
  return {
    handle: async (params: ExploreQuerySelectParams, ctx) => {
      const stored = requireQuery(host, ctx, params.queryId, "mutate");
      const selected = stored.run.applySelection(params.groups, { merge: params.merge === true });
      return { ...selected, queryId: stored.id };
    },
  };
}

export function createExploreQueryFollowupService(
  host: Pick<HarnessServiceHost, "exploreQueryStore">,
): HarnessService<"explore.query.followup"> {
  return {
    handle: async (params: ExploreQueryFollowupParams, ctx) => {
      const stored = requireQuery(host, ctx, params.queryId, "mutate");
      const result = await stored.run.followup(params);
      return {
        queryId: stored.id,
        launched: result.launched,
        reused: result.reused,
        newViews: result.newViews,
        sources: stored.run.sourceStates(),
      };
    },
  };
}

export function createExploreQueryFinishService(
  host: Pick<HarnessServiceHost, "exploreQueryStore" | "outputStore" | "fileRelations" | "rerankExploreViews" | "harnessSettings">,
  options?: { traceWindows?: boolean },
): HarnessService<"explore.query.finish"> {
  return {
    handle: async (params: ExploreQueryFinishParams & { model?: ExploreModelParticipation }, ctx) => {
      const stored = requireQuery(host, ctx, params.queryId, "finish");
      const model = params.model;
      if (exploreShouldRerank(model) && host.rerankExploreViews) {
        const settings = rerankSettingsFromSnapshot(host.harnessSettings?.() ?? null);
        if (settings) {
          try {
            const views = stored.run.viewsForModel().views;
            const { documents, evaluated } = documentsFromViews(
              views,
              settings.maxDocumentTokens,
              (text) => Math.max(1, Math.ceil(text.length / 4)),
            );
            if (documents.length > 0) {
              const ranked = await host.rerankExploreViews({
                query: stored.run.question,
                documents,
                settings,
                signal: ctx.signal,
              });
              stored.run.applyRerank(scoresFromRerankResult(ranked, documents), {
                status: "used",
                providerId: settings.providerId,
                modelId: settings.modelId,
                batchId: ranked.batchId,
                evaluated: evaluated.length,
              });
              if (model) model.rerank = "used";
            } else if (model) {
              model.rerank = "skipped";
            }
          } catch (error) {
            const cancelled = ctx.signal.aborted || (error instanceof Error && error.name === "AbortError");
            const settings = rerankSettingsFromSnapshot(host.harnessSettings?.() ?? null);
            if (settings) {
              stored.run.applyRerank([], rerankFailureDetails(
                settings,
                cancelled ? "cancelled" : "failed",
                cancelled ? "Rerank was cancelled; source ranking was kept." : "Rerank failed; source ranking was kept.",
              ));
            }
            if (model) model.rerank = cancelled ? "cancelled" : "failed";
          }
        } else if (model) {
          model.rerank = "unconfigured";
        }
      } else if (model && model.rerank === undefined) {
        model.rerank = exploreShouldRerank(model) ? "unconfigured" : "skipped";
      }
      const result = stored.run.finish(model);
      if (!stored.controller.signal.aborted) stored.controller.abort();
      if (result.snippets.length === 0 && result.issues.length > 0) {
        throw new HarnessServiceError("unavailable", `No current excerpts could be read: ${result.issues.map((issue: ExploreIssue) => `${issue.path} (${issue.status})`).join(", ")}. Search again.`);
      }
      return packExploreSearchResult(host, ctx, result, options);
    },
  };
}

export function createExploreQueryCancelService(
  host: Pick<HarnessServiceHost, "exploreQueryStore">,
): HarnessService<"explore.query.cancel"> {
  return {
    handle: async (params: ExploreQueryCancelParams, ctx) => ({
      cancelled: host.exploreQueryStore.cancel(ctx.actor, params.queryId),
    }),
  };
}

export function createExploreQueryReleaseService(
  host: Pick<HarnessServiceHost, "exploreQueryStore">,
): HarnessService<"explore.query.release"> {
  return {
    handle: async (params: ExploreQueryReleaseParams, ctx) => ({
      released: host.exploreQueryStore.release(ctx.actor, params.queryId),
    }),
  };
}

export function ownedDirtyPathsFor(
  inputContext: AgentInputContext,
  actor: HarnessServiceContext["actor"],
  params: ExploreParams,
  authorizedPaths: ReadonlyArray<{ resourceId: string }>,
  draftPaths?: (sessionId: string, context: AgentInputContext) => readonly string[],
): string[] {
  if (inputContext.source !== "surface") return [];
  const owned = draftPaths ? draftPaths(actor.sessionId, inputContext) : inputContext.dirtyPaths;
  return owned.filter((dirtyPath) => (
    params.paths === undefined
    || authorizedPaths.some((authorized) => pathInRoots(dirtyPath, [authorized.resourceId]))
  ));
}
