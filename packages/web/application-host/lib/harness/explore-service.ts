import type { AgentInputContext, HarnessActorContext, HarnessServiceMap } from "@piarium/protocol";
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

export function createExploreSearchService(
  host: Pick<HarnessServiceHost, "searchService" | "outputStore" | "readExploreFile" | "agentInputDraftPaths">,
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
      if (params.anchors !== undefined && (!Array.isArray(params.anchors) || params.anchors.some((anchor) => typeof anchor !== "string" || !anchor.trim()))) {
        throw new HarnessServiceError("invalid-params", "Anchors must be non-empty strings.");
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
            searchPartial ||= search.partial || (search.filesDropped ?? 0) > 0;
            return {
              hits: search.files.flatMap((file) => file.hits.map((hit) => ({ path: file.path, line: hit.line, text: hit.text }))),
              filesDropped: search.filesDropped ?? 0,
            };
          }));
          return {
            hits: batches.flatMap((batch) => batch.hits),
            partial: searchPartial,
            filesDropped: batches.reduce((sum, batch) => sum + batch.filesDropped, 0),
          };
        },
        readFile: (path) => readFile(ctx.actor, path, ctx.signal, inputContext),
      }, ctx.signal);
      if (result.snippets.length === 0 && result.issues.length > 0) {
        throw new HarnessServiceError("unavailable", `No current excerpts could be read: ${result.issues.map((issue) => `${issue.path} (${issue.status})`).join(", ")}. Search again.`);
      }
      const packed = formatExploreOutput({
        ...result,
        partial: searchPartial || result.partial,
        searchIncomplete: searchPartial || result.searchIncomplete,
        searched: { ...result.searched, incomplete: searchPartial || result.searched.incomplete },
      }, { byteBudget: DEFAULT_BYTE_BUDGET });
      const stored = host.outputStore.store(ctx.sessionId, packed.storedBody, "explore");
      const handleHint = packed.showHandle
        ? `\nMore: get_output("${stored.ref.handle}") for the full pack and unread candidate list (session-local, ephemeral).`
        : "";
      return {
        ...result,
        omitted: packed.omitted,
        partial: searchPartial || result.partial,
        searched: { ...result.searched, incomplete: searchPartial || result.searched.incomplete },
        details: { ...result.details, byteBudget: DEFAULT_BYTE_BUDGET },
        text: `${packed.visibleText}${handleHint}`,
        handle: stored.ref.handle,
      };
    },
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
