import { languageIdForPath } from "@piarium/protocol";
import type {
  StructureClassifyRequest,
  StructureClassifyResult,
  StructureOutlineRequest,
  StructureOutlineResult,
  StructureProvider,
  StructureSource,
  StructureStatus,
} from "./types.js";

const STATUS_PRIORITY: Record<StructureStatus, number> = {
  ready: 0,
  empty: 1,
  stale: 2,
  cancelled: 3,
  unsupported: 4,
  failed: 5,
  unavailable: 6,
};

const better = <Result extends { status: StructureStatus }>(current: Result | undefined, next: Result): Result => (
  !current || STATUS_PRIORITY[next.status] < STATUS_PRIORITY[current.status] ? next : current
);

/**
 * Fan-out across structure providers. Callers try providers in order; the first
 * ready/empty outline wins. A later provider may still succeed when an earlier
 * one is cold or failed — that is the tree-sitter / LSP pairing.
 */
export function createStructureSource(providers: readonly StructureProvider[]): StructureSource {
  return {
    async outline(request: StructureOutlineRequest): Promise<StructureOutlineResult> {
      const languageId = request.languageId ?? languageIdForPath(request.path);
      const nextRequest = { ...request, languageId };
      let fallback: StructureOutlineResult | undefined;
      for (const provider of providers) {
        if (!provider.capabilities(languageId).outline) continue;
        const result = await provider.outline(nextRequest);
        if (result.status === "ready" || result.status === "empty") return result;
        fallback = better(fallback, result);
        if (result.status === "cancelled") return result;
      }
      return fallback ?? {
        status: languageId ? "unavailable" : "unsupported",
        provider: null,
        revision: request.revision,
        symbols: [],
        message: languageId ? "No structure provider produced an outline." : "No language identity for this path.",
      };
    },
    async classifyHits(request: StructureClassifyRequest): Promise<StructureClassifyResult> {
      const languageId = request.languageId ?? languageIdForPath(request.path);
      const nextRequest = { ...request, languageId };
      let fallback: StructureClassifyResult | undefined;
      for (const provider of providers) {
        if (!provider.capabilities(languageId).classifyHits) continue;
        const result = await provider.classifyHits(nextRequest);
        if (result.status === "ready" || result.status === "empty") return result;
        fallback = better(fallback, result);
        if (result.status === "cancelled") return result;
      }
      return fallback ?? {
        status: "unsupported",
        provider: null,
        revision: request.revision,
        hits: [],
        message: "Hit classification is not available from the configured structure providers.",
      };
    },
  };
}
