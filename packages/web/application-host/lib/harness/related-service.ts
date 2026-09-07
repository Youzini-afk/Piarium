import type { HarnessServiceMap, RelatedQueryResult } from "@piarium/protocol";
import type { HarnessService } from "./router.js";
import type { HarnessServiceHost } from "./service-host.js";
import { HarnessServiceError } from "./service-error.js";
import { executeRelated } from "./related-tool.js";

type RelatedParams = HarnessServiceMap["related.query"]["params"];

const unavailable = (anchor: string, message: string): RelatedQueryResult => ({
  text: message,
  status: "unavailable",
  anchor: { kind: /[\\/]/.test(anchor) || /\.[a-zA-Z][a-zA-Z0-9]*$/.test(anchor) ? "path" : "name", value: anchor },
  definitions: [],
  imports: { items: [], unresolved: [], incomplete: false },
  importers: { items: [], incomplete: false },
  connections: { items: [], incomplete: false },
});

export function createRelatedQueryService(
  host: Pick<HarnessServiceHost, "graphRecall">,
): HarnessService<"related.query"> {
  return {
    handle: async (params: RelatedParams, ctx) => {
      if (typeof params.anchor !== "string" || !params.anchor.trim()) {
        throw new HarnessServiceError("invalid-params", "Provide a path or symbol name.");
      }
      const workspaceId = ctx.actor.workspaceId;
      if (!workspaceId || !host.graphRecall) {
        return unavailable(params.anchor.trim(), "related unavailable: the symbol graph is not wired.");
      }
      ctx.signal.throwIfAborted();
      const store = host.graphRecall(workspaceId);
      if (!store) {
        return unavailable(
          params.anchor.trim(),
          "related unavailable: the symbol graph is not open for this workspace. related does not open a database on the read path.",
        );
      }
      try {
        return await executeRelated({ anchor: params.anchor }, store);
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") throw error;
        return {
          ...unavailable(params.anchor.trim(), "related failed: the symbol graph could not answer."),
          status: "failed",
        };
      }
    },
  };
}
