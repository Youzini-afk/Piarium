import { languageIdForPath } from "@piarium/protocol";
import { outlineCoversHitLines } from "./slice.js";
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
 * Fan-out across structure providers.
 *
 * The first `ready` outline that covers every supplied hit line wins. `empty`
 * and a `ready` outline that misses a hit do not hide a later provider, but
 * that later call is `warmOnly` so a cold language server is not started
 * (D-097 / D-099). `unavailable` from an earlier provider still allows a
 * cold start on the next one.
 */
export function createStructureSource(providers: readonly StructureProvider[]): StructureSource {
  return {
    async outline(request: StructureOutlineRequest): Promise<StructureOutlineResult> {
      const languageId = request.languageId ?? languageIdForPath(request.path);
      const nextRequest = { ...request, languageId };
      const hitLines = (request.hitLines ?? []).filter((line) => Number.isSafeInteger(line) && line >= 1);
      let fallback: StructureOutlineResult | undefined;
      let firstReady: StructureOutlineResult | undefined;
      let priorAnswered = false;
      for (const provider of providers) {
        if (!provider.capabilities(languageId).outline) continue;
        const result = await provider.outline({ ...nextRequest, warmOnly: priorAnswered });
        if (result.status === "cancelled") return result;
        if (result.status === "ready") {
          const covered = hitLines.length === 0 || outlineCoversHitLines(result.symbols, hitLines);
          if (covered) return result;
          firstReady = result;
          priorAnswered = true;
          fallback = better(fallback, result);
          continue;
        }
        if (result.status === "empty") {
          priorAnswered = true;
          fallback = better(fallback, result);
          continue;
        }
        fallback = better(fallback, result);
      }
      return firstReady ?? fallback ?? {
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
      let priorAnswered = false;
      for (const provider of providers) {
        if (!provider.capabilities(languageId).classifyHits) continue;
        const result = await provider.classifyHits({ ...nextRequest, warmOnly: priorAnswered });
        if (result.status === "ready") return result;
        if (result.status === "cancelled") return result;
        if (result.status === "empty") priorAnswered = true;
        fallback = better(fallback, result);
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
