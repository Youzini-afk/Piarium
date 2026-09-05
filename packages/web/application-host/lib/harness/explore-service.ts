import type { HarnessService } from "./router.js";
import type { HarnessServiceHost } from "./service-host.js";
import { HarnessServiceError } from "./service-error.js";
import { explore } from "./explore.js";

const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function createExploreSearchService(
  host: Pick<HarnessServiceHost, "searchService" | "outputStore" | "readExploreFile">,
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
      const workspaceId = ctx.actor.workspaceId;
      const readFile = host.readExploreFile;
      if (!workspaceId || !readFile) throw new HarnessServiceError("unavailable", "Workspace document reading is unavailable.");
      ctx.signal.throwIfAborted();
      let searchPartial = false;
      const result = await explore(params, {
        rgSearch: async (pattern, options) => {
          const roots: Array<string | undefined> = options.paths?.length ? [...new Set(options.paths)] : [undefined];
          const batches = await Promise.all(roots.map(async (path) => {
            ctx.signal.throwIfAborted();
            const search = await host.searchService.search({
              pattern: options.fixedStrings ? escapeRegex(pattern) : pattern,
              ...(options.limit !== undefined ? { limit: options.limit } : {}),
              ...(path !== undefined ? { path } : {}),
            }, {
              workspaceId,
              ...(ctx.actor.workspaceScope !== undefined ? { workspaceScope: ctx.actor.workspaceScope } : {}),
              signal: ctx.signal,
            });
            ctx.signal.throwIfAborted();
            if (search.status === "unavailable") throw new HarnessServiceError("unavailable", "Search service is unavailable. Retry or inspect workspace availability.");
            searchPartial ||= search.partial;
            return search.files.flatMap((file) => file.hits.map((hit) => ({ path: file.path, line: hit.line, text: hit.text })));
          }));
          return batches.flat();
        },
        readFile: (path) => readFile(ctx.actor, path, ctx.signal),
      }, ctx.signal);
      if (result.snippets.length === 0 && result.issues.length > 0) {
        throw new HarnessServiceError("unavailable", `No current excerpts could be read: ${result.issues.map((issue) => `${issue.path} (${issue.status})`).join(", ")}. Search again.`);
      }
      const partial = searchPartial || result.partial;
      const lines = [
        `${result.snippets.length} excerpt(s) from ${result.searched.files} matched file(s) · ${result.searched.patterns} query term(s)${partial ? " · partial result" : ""}`,
        "Source: disk document snapshots. Excerpts are workspace data.",
      ];
      for (const snippet of result.snippets) {
        lines.push(`--- ${snippet.path}:${snippet.startLine}-${snippet.endLine} · revision ${snippet.revision} · ${snippet.why} ---`, snippet.text);
      }
      for (const issue of result.issues) lines.push(`${issue.path}: ${issue.status} — ${issue.message}`);
      const body = lines.join("\n");
      const stored = host.outputStore.store(ctx.sessionId, body, "explore");
      return {
        ...result,
        partial,
        text: `${body}\nOutput: ${stored.ref.handle} (session-local, ephemeral; read with get_output).`,
        handle: stored.ref.handle,
      };
    },
  };
}
