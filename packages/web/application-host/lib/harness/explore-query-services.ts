import type {
  AgentInputContext,
  ExploreModelParticipation,
  ExploreQueryCancelParams,
  ExploreQueryFinishDetails,
  ExploreQueryFinishParams,
  ExploreQueryFinishResult,
  ExploreQueryFollowupParams,
  ExploreQueryPlanParams,
  ExploreQueryReleaseParams,
  ExploreQuerySelectParams,
  ExploreQueryStartParams,
  ExploreQueryViewsParams,
  ExploreSourceStatus,
  ExploreQueryTaskFamily,
  ExploreQueryTaskStatus,
  HarnessServiceMap,
} from "@varin/protocol";
import {
  documentsFromViews,
  exploreShouldRerank,
  rerankFailureDetails,
  rerankSettingsFromSnapshot,
  scoresFromRerankResult,
} from "./explore-rerank.js";
import {
  fastDecisionStageStatus,
  resolveExploreFastDecision,
  runExploreFastDecisionLoop,
} from "./explore-fast-decision.js";
import { HARNESS_MAX_REQUEST_TIMEOUT_MS } from "@varin/protocol";
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
import { loadSnippetRelations, resolveExploreScopeAndAnchors } from "./explore-service.js";
import {
  exploreFileFromSnapshot,
  type WorkingBranchQuerySnapshot,
} from "./working-state/working-branch-lookups.js";

type ExploreParams = HarnessServiceMap["explore.search"]["params"];

export function bindExploreGraphRecall(
  store: import("../knowledge/store.js").KnowledgeStore,
  roots?: readonly string[],
): ExploreGraphRecall {
  const toSite = (record: import("../knowledge/store.js").SymbolGraphRelationRecord) => ({
    path: record.path,
    line: record.line,
    ...(record.caller !== undefined ? { caller: record.caller } : {}),
    ...(record.targetPath !== undefined && pathInRoots(record.targetPath, roots) ? { targetPath: record.targetPath } : {}),
    ...(record.targetName !== undefined ? { targetName: record.targetName } : {}),
    pinned: record.pinned,
    ...(record.staleTarget ? { staleTarget: true } : {}),
    resolvedBy: record.resolvedBy,
  });
  return {
    catalogStats: async () => store.catalogStats(),
    searchDefinitions: (query, k) => store.searchSymbols(query, k, roots),
    findLinks: (value) => store.findLinks(value),
    fileRelations: async (path) => {
      const relations = await store.getFileRelations(path);
      if (!relations) return null;
      return {
        connections: relations.connections.map(({ callee, literal }) => ({ callee, literal })),
        linksIncomplete: relations.linksIncomplete,
        references: relations.references.map((record) => ({
          path: record.path,
          line: record.line,
          ...(record.caller !== undefined ? { caller: record.caller } : {}),
          ...(record.targetPath !== undefined && pathInRoots(record.targetPath, roots) ? { targetPath: record.targetPath } : {}),
          ...(record.targetName !== undefined ? { targetName: record.targetName } : {}),
          pinned: record.pinned,
          ...(record.staleTarget ? { staleTarget: true } : {}),
          resolvedBy: record.resolvedBy,
        })),
        calls: relations.calls.map((record) => ({
          path: record.path,
          line: record.line,
          ...(record.caller !== undefined ? { caller: record.caller } : {}),
          callee: record.targetName ?? record.value,
          ...(record.targetPath !== undefined && pathInRoots(record.targetPath, roots) ? { targetPath: record.targetPath } : {}),
          ...(record.targetName !== undefined ? { targetName: record.targetName } : {}),
          pinned: record.pinned,
          ...(record.staleTarget ? { staleTarget: true } : {}),
          resolvedBy: record.resolvedBy,
        })),
      };
    },
    findImporters: (path) => store.findImporters(path),
    // Wire resolved reference/call edges into the public explore.query chain,
    // not only the low-level explore() unit tests (D-240 rework).
    findReferences: async (name) => (await store.findReferences(name, roots)).map(toSite),
    findCallers: async (name) => (await store.findCallers(name, roots)).map(toSite),
    findCalls: async (caller) => (await store.findCalls(caller, roots)).map(toSite),
  };
}

export function createExploreDeps(
  host: Pick<HarnessServiceHost, "searchService" | "readExploreFile" | "structureSource" | "graphRecall" | "semanticRecall" | "agentInputDraftPaths">,
  ctx: HarnessServiceContext,
  inputContext: AgentInputContext,
  signal: AbortSignal = ctx.signal,
  roots?: readonly string[],
  snapshot: WorkingBranchQuerySnapshot | null = null,
  graphStore: import("../knowledge/store.js").KnowledgeStore | null = null,
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
          ...(snapshot ? { pinnedBranchQuery: snapshot } : {}),
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
    readFile: async (resourceId) => {
      if (snapshot) return exploreFileFromSnapshot(snapshot, resourceId);
      return readFile(ctx.actor, resourceId, signal, inputContext);
    },
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
    ...(graphStore ? { graph: bindExploreGraphRecall(graphStore, roots) } : {}),
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
            ...(snapshot ? { threadQuery: snapshot } : {}),
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
  host: Pick<HarnessServiceHost, "outputStore"> & Partial<Pick<HarnessServiceHost, "fileRelations">>,
  ctx: HarnessServiceContext,
  result: Awaited<ReturnType<StoredExploreQuery["run"]["finish"]>>,
  options?: { traceWindows?: boolean; searchPartial?: boolean },
): Promise<ExploreQueryFinishResult> {
  const incomplete = (options?.searchPartial ?? false) || result.searched.incomplete;
  const relations = ctx.workspaceId && host.fileRelations
    ? await loadSnippetRelations({ fileRelations: host.fileRelations }, ctx.workspaceId, result.snippets, ctx.signal)
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
    ...(result.details.fastDecision ? { fastDecision: result.details.fastDecision } : {}),
    ...(relations ? { relations } : {}),
    ...(result.details.sources ? { sources: result.details.sources } : {}),
  };
  const preview = formatExploreOutput(formatted, { byteBudget: DEFAULT_BYTE_BUDGET });
  const fullDetails = {
    notRequested: result.notRequested,
    omitted: result.omitted,
    packedOmitted: preview.omitted,
    details: result.details,
    ...(relations ? { relations } : {}),
  };
  const storedBody = `${preview.storedBody}\n\nExplore structured details (JSON):\n${JSON.stringify(fullDetails)}`;
  const stored = host.outputStore.store(ctx.sessionId, storedBody, "explore");
  const summaryFormatted = {
    ...formatted,
    notRequested: { count: result.notRequested.count, paths: [] },
    omitted: [],
    omittedCount: result.omitted.length,
    summaryOnly: true,
  };
  const packed = formatExploreOutput(summaryFormatted, { byteBudget: DEFAULT_BYTE_BUDGET, handle: stored.ref.handle });
  const provenanceCounts: Partial<Record<ExploreSourceStatus, number>> = {};
  for (const entry of result.details.provenance) {
    provenanceCounts[entry.status] = (provenanceCounts[entry.status] ?? 0) + 1;
  }
  const details: ExploreQueryFinishDetails = {
    provenance: { statusCounts: provenanceCounts },
    anchors: result.details.anchors,
    byteBudget: DEFAULT_BYTE_BUDGET,
    ...(result.details.structure ? { structure: summarizeStructure(result.details.structure.files) } : {}),
    ...(result.details.graph ? { graph: result.details.graph } : {}),
    ...(result.details.query ? {
      query: {
        objectCount: result.details.query.objects.length,
        relation: result.details.query.relation,
        domain: result.details.query.domain,
      },
    } : {}),
    ...(result.details.skippedQueries ? {
      skippedQueries: { reason: result.details.skippedQueries.reason, patternCount: result.details.skippedQueries.patterns.length },
    } : {}),
    ...(result.details.distinctiveness ? {
      distinctiveness: {
        scope: result.details.distinctiveness.scope,
        poolFiles: result.details.distinctiveness.poolFiles,
        termCount: result.details.distinctiveness.terms.length,
      },
    } : {}),
    ...(relations ? { relations: summarizeRelations(relations) } : {}),
    ...(result.details.semantic ? { semantic: summarizeSemantic(result.details.semantic) } : {}),
    ...(result.details.rerank ? { rerank: result.details.rerank } : {}),
    ...(result.details.fastDecision ? { fastDecision: summarizeFastDecision(result.details.fastDecision) } : {}),
    ...(result.details.model ? { model: result.details.model } : {}),
    ...(result.details.sources ? { sources: summarizeSources(result.details.sources) } : {}),
  };
  return {
    text: packed.visibleText,
    snippets: result.snippets,
    issueCount: result.issues.length,
    notRequestedCount: result.notRequested.count,
    omittedCount: result.omitted.length + packed.omitted.length,
    partial: formatted.partial,
    searched: formatted.searched,
    handle: stored.ref.handle,
    details,
  };
}

function summarizeStructure(files: NonNullable<Awaited<ReturnType<StoredExploreQuery["run"]["finish"]>>["details"]["structure"]>["files"]): NonNullable<ExploreQueryFinishDetails["structure"]> {
  const providers: NonNullable<ExploreQueryFinishDetails["structure"]>["providers"] = {};
  const statuses: NonNullable<ExploreQueryFinishDetails["structure"]>["statuses"] = {};
  for (const file of files) {
    const provider = file.provider ?? "none";
    providers[provider] = (providers[provider] ?? 0) + 1;
    statuses[file.status] = (statuses[file.status] ?? 0) + 1;
  }
  return { fileCount: files.length, providers, statuses };
}

function summarizeRelations(
  relations: NonNullable<Awaited<ReturnType<StoredExploreQuery["run"]["finish"]>>["details"]["relations"]>,
): NonNullable<ExploreQueryFinishDetails["relations"]> {
  const summary: NonNullable<ExploreQueryFinishDetails["relations"]> = {
    status: relations.status,
    fileCount: relations.files.length,
    staleFiles: relations.files.filter((file) => file.stale).length,
    incompleteFiles: relations.files.filter((file) => file.incomplete).length,
    edgeCounts: { imports: 0, connections: 0, associations: 0, references: 0, calls: 0 },
  };
  for (const file of relations.files) {
    summary.edgeCounts.imports += file.imports.length;
    summary.edgeCounts.connections += file.connections.length;
    summary.edgeCounts.associations += file.associations.length;
    summary.edgeCounts.references += file.references?.length ?? 0;
    summary.edgeCounts.calls += file.calls?.length ?? 0;
  }
  return summary;
}

function summarizeSemantic(
  semantic: NonNullable<Awaited<ReturnType<StoredExploreQuery["run"]["finish"]>>["details"]["semantic"]>,
): NonNullable<ExploreQueryFinishDetails["semantic"]> {
  return {
    status: semantic.status,
    coverage: semantic.coverage,
    ...(semantic.generation ? { generation: semantic.generation } : {}),
    ...(semantic.spaceId ? { spaceId: semantic.spaceId } : {}),
    ...(semantic.scope ? { scope: semantic.scope } : {}),
    index: semantic.index,
    ...(semantic.blocks !== undefined ? { blocks: semantic.blocks } : {}),
    ...(semantic.units !== undefined ? { units: semantic.units } : {}),
    ...(semantic.primary !== undefined ? { primary: semantic.primary } : {}),
    ...(semantic.gaps?.length ? { gapCount: semantic.gaps.length } : {}),
  };
}

function summarizeFastDecision(
  details: NonNullable<Awaited<ReturnType<StoredExploreQuery["run"]["finish"]>>["details"]["fastDecision"]>,
): NonNullable<ExploreQueryFinishDetails["fastDecision"]> {
  return {
    status: details.status,
    ...(details.providerId ? { providerId: details.providerId } : {}),
    ...(details.modelId ? { modelId: details.modelId } : {}),
    ...(details.servedModelId ? { servedModelId: details.servedModelId } : {}),
    batches: details.batches,
    rounds: details.rounds,
    viewsJudged: details.viewsJudged,
    actionsOffered: details.actionsOffered,
    actionsExecuted: details.actionsExecuted,
    missing: details.missing,
    unevaluatedMaterials: details.unevaluatedMaterials,
    ...(details.usage ? { usage: details.usage } : {}),
    ...(details.note ? { note: details.note } : {}),
  };
}

function summarizeSources(
  sources: Awaited<ReturnType<StoredExploreQuery["run"]["finish"]>>["details"]["sources"],
): NonNullable<ExploreQueryFinishDetails["sources"]> {
  const families: Partial<Record<ExploreQueryTaskFamily, number>> = {};
  const statuses: Partial<Record<ExploreQueryTaskStatus, number>> = {};
  for (const source of sources ?? []) {
    families[source.family] = (families[source.family] ?? 0) + 1;
    statuses[source.status] = (statuses[source.status] ?? 0) + 1;
  }
  return { count: sources?.length ?? 0, families, statuses };
}

export function createExploreQueryStartService(
  host: Pick<HarnessServiceHost, "searchService" | "readExploreFile" | "structureSource" | "graphRecall" | "semanticRecall" | "agentInputDraftPaths" | "exploreQueryStore" | "harnessSettings" | "pinWorkingBranchQuery" | "fastDecision" | "fastDecisionStatus">,
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
      const deadlineAt = Date.now() + budgetMs;
      const queryController = new AbortController();
      let stored: StoredExploreQuery | undefined;
      const onStartAbort = (): void => {
        if (!queryController.signal.aborted) queryController.abort();
        stored?.run.cancel();
      };
      if (ctx.signal.aborted) onStartAbort();
      else ctx.signal.addEventListener("abort", onStartAbort, { once: true });
      try {
        const resolvedRequest = resolveExploreScopeAndAnchors(params, ctx);
        const effectivePaths = resolvedRequest.paths;
        const effectiveAnchors = resolvedRequest.anchors;
        let rerankConfigured = false;
        let fastDecision: StoredExploreQuery["fastDecision"];
        if (ctx.workspaceId) {
          const snapshotSettings = await Promise.resolve(
            host.harnessSettings?.(ctx.workspaceId) ?? null,
          ).catch(() => null);
          try {
            rerankConfigured = rerankSettingsFromSnapshot(snapshotSettings) !== undefined;
          } catch {
            rerankConfigured = false;
          }
          // Fast Decision (D-312): freeze the resolved binding — including its
          // credential-free configurationId — at query start. A settings edit
          // applies to the next query, never this one.
          if (host.fastDecision && host.fastDecisionStatus) {
            const status = await host.fastDecisionStatus(ctx.workspaceId, "explore").catch(() => undefined);
            fastDecision = resolveExploreFastDecision(status);
          } else {
            fastDecision = { status: "unavailable" };
          }
        }
        const [snapshot, graph] = await Promise.all([
          host.pinWorkingBranchQuery
            ? host.pinWorkingBranchQuery(ctx.sessionId, {
              ...(effectivePaths ? { roots: effectivePaths } : {}),
              signal: queryController.signal,
              deadlineAt,
            })
            : Promise.resolve(null),
          host.graphRecall && ctx.actor.workspaceId
            ? host.graphRecall(ctx.sessionId, ctx.actor.workspaceId).catch(() => null)
            : Promise.resolve(null),
        ]);
        stored = host.exploreQueryStore.start({
          actor: actorFromHarness(ctx.actor),
          inputContext,
          input: {
            question: params.question,
            ...(effectiveAnchors ? { anchors: effectiveAnchors } : {}),
            ...(effectivePaths ? { paths: effectivePaths } : {}),
            ...(params.limit ? { limit: params.limit } : {}),
          },
          deps: createExploreDeps(
            host,
            ctx,
            inputContext,
            queryController.signal,
            effectivePaths,
            snapshot,
            graph?.store ?? null,
          ),
          deadlineAt,
          reserveForJudgeMs: params.reserveForJudge || rerankConfigured || fastDecision?.status === "ready"
            ? DEFAULT_JUDGE_RESERVE_MS
            : 0,
          controller: queryController,
        });
        if (fastDecision) {
          stored.fastDecision = fastDecision;
          if (fastDecision.status === "ready" && fastDecision.binding && host.fastDecision) {
            const binding = fastDecision.binding;
            // The loop shares the query's lifetime: cancelController covers
            // cancel/release/total deadline; `abort` is the finish-time stop.
            const loopAbort = new AbortController();
            const loopSignal = AbortSignal.any([stored.cancelController.signal, loopAbort.signal]);
            let settleRequested = false;
            let settle!: () => void;
            const settlePromise = new Promise<void>((resolve) => { settle = resolve; });
            fastDecision.requestSettle = () => {
              settleRequested = true;
              settle();
            };
            fastDecision.abort = () => {
              if (!loopAbort.signal.aborted) loopAbort.abort();
            };
            fastDecision.done = runExploreFastDecisionLoop({
              run: stored.run,
              binding,
              call: (batch) => host.fastDecision!({
                workspaceId: ctx.workspaceId!,
                purpose: "explore",
                settings: binding,
                goal: batch.goal,
                materials: batch.materials,
                questions: batch.questions,
                signal: batch.signal,
              }),
              signal: loopSignal,
              deadlineAt: stored.deadlineAt,
              waitForLaterProgress: true,
              closing: { promise: settlePromise, requested: () => settleRequested },
            }).then((details) => {
              stored!.run.applyFastDecision(details);
              fastDecision.details = details;
            }).catch(() => undefined);
          }
        }
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
          ...(fastDecision ? { fastDecision: { status: fastDecision.status } } : {}),
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
        ...(result.actionsExecuted.length > 0 ? { actionsExecuted: result.actionsExecuted } : {}),
        ...(result.actionsRejected.length > 0 ? { actionsRejected: result.actionsRejected } : {}),
        sources: stored.run.sourceStates(),
      };
    },
  };
}

export function createExploreQueryFinishService(
  host: Pick<HarnessServiceHost, "exploreQueryStore" | "outputStore" | "rerankExploreViews" | "harnessSettings">
    & Partial<Pick<HarnessServiceHost, "fileRelations">>,
  options?: { traceWindows?: boolean },
): HarnessService<"explore.query.finish"> {
  return {
    handle: async (params: ExploreQueryFinishParams & { model?: ExploreModelParticipation }, ctx) => {
      const stored = requireQuery(host, ctx, params.queryId, "finish");
      const model = params.model;
      const workspaceId = ctx.workspaceId;
      if (stored.run.terminal() === "finished") {
        return packExploreSearchResult(host, ctx, stored.run.finish(model), options);
      }
      stored.finishing ??= (async () => {
        // Fast Decision (D-312): the progressive loop owns material relevance
        // and action choice while it is configured for this query — the same
        // judgment is not re-run through rerank or another paid model (§4.4).
        const fastDecision = stored.fastDecision;
        const fastDecisionActive = fastDecision?.status === "ready";
        if (fastDecisionActive) {
          fastDecision.requestSettle?.();
          const remaining = Math.max(0, stored.deadlineAt - Date.now());
          await Promise.race([
            fastDecision.done,
            new Promise<void>((resolve) => {
              setTimeout(resolve, Math.min(remaining, DEFAULT_JUDGE_RESERVE_MS));
            }),
          ]);
          if (fastDecision.done) {
            fastDecision.abort?.();
            await fastDecision.done;
          }
        }
        if (model && fastDecisionActive) {
          model.fastDecision = fastDecisionStageStatus(fastDecision.details);
          if (model.rerank === undefined) model.rerank = "skipped";
        } else if (model && fastDecision && fastDecision.status !== "ready") {
          model.fastDecision = fastDecision.status === "disabled"
            ? "disabled"
            : fastDecision.status === "unconfigured"
              ? "unconfigured"
              : "failed";
          if (fastDecision.status === "invalid" || fastDecision.status === "unavailable") {
            model.note = `${model.note ? `${model.note} ` : ""}Fast decision is ${fastDecision.status}; source ranking was kept.`;
          }
        }
        if (workspaceId && exploreShouldRerank(model) && host.rerankExploreViews && !fastDecisionActive) {
          let settings: ReturnType<typeof rerankSettingsFromSnapshot>;
          let settingsInvalid = false;
          try {
            settings = rerankSettingsFromSnapshot(await host.harnessSettings?.(workspaceId) ?? null);
          } catch {
            settingsInvalid = true;
            stored.run.applyRerank([], {
              status: "failed",
              note: "Rerank settings are malformed; source ranking was kept.",
            });
            if (model) model.rerank = "failed";
          }
          if (settings) {
            try {
              const views = stored.run.viewsForModel().views;
              const { documents } = documentsFromViews(
                views,
                settings.maxDocumentTokens,
                // Character count is an estimate; the remote tokenizer may differ.
                // Over-budget views keep their source rank without being sent.
                (text) => Math.max(1, text.length),
              );
              if (documents.length > 0) {
                const ranked = await host.rerankExploreViews({
                  workspaceId,
                  query: stored.run.question,
                  documents,
                  settings,
                  signal: AbortSignal.any([ctx.signal, stored.cancelController.signal]),
                });
                const scores = scoresFromRerankResult(ranked, documents);
                if (scores.length === 0) throw new Error("Rerank returned no valid scores");
                stored.run.applyRerank(scores, {
                  status: "used",
                  providerId: settings.providerId,
                  modelId: settings.modelId,
                  batchId: ranked.batchId,
                  evaluated: scores.length,
                });
                if (model) model.rerank = "used";
              } else if (model) {
                model.rerank = "skipped";
              }
            } catch (error) {
              const cancelled = ctx.signal.aborted || (error instanceof Error && error.name === "AbortError");
              stored.run.applyRerank([], rerankFailureDetails(
                settings,
                cancelled ? "cancelled" : "failed",
                cancelled ? "Rerank was cancelled; source ranking was kept." : "Rerank failed; source ranking was kept.",
              ));
              if (model) model.rerank = cancelled ? "cancelled" : "failed";
            }
          } else if (model && !settingsInvalid) {
            model.rerank = "unconfigured";
          }
        } else if (model && model.rerank === undefined) {
          model.rerank = exploreShouldRerank(model) ? "unconfigured" : "skipped";
        }
        const result = stored.run.finish(model);
        if (!stored.controller.signal.aborted) stored.controller.abort();
        if (!stored.cancelController.signal.aborted) stored.cancelController.abort();
        return result;
      })();
      const result = await stored.finishing;
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
