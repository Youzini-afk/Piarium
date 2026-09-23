/**
 * D-315 / Stage L5: `research.decide` — batch fast-decision judgment over
 * real Web and scholarly candidates.
 *
 * Candidates come from material the caller already produced: URLs from
 * `web.search`, pinned snapshots from `web.fetch`, scholarly identities from
 * `research.search`, snapshot sections, or new query expressions. The Host
 * rejects references it cannot resolve under the caller's own authority
 * (unreadable snapshots, malformed papers), so the model only judges real
 * options and never invents ids.
 *
 * Binding follows the D-312 machinery: the caller's `purpose` slot resolves
 * through `fastDecisionStatus`, the ready binding freezes `configurationId`
 * for this call, and `fastDecision` executes the batch. When the purpose is
 * disabled, unconfigured, unavailable, or the call fails or is cancelled,
 * the result reports that status honestly and keeps the caller-supplied
 * order in `ranked` — direct search and the agent's own judgment continue.
 * Missing answers are listed, never scored as zero; no score is read as a
 * research-completeness proof.
 */
import type {
  FastDecisionMaterial,
  FastDecisionQuestion,
  HarnessFastDecisionPurpose,
  ResearchDecideKind,
  ResearchDecideParams,
  ResearchDecideRankedCandidate,
  ResearchDecideResult,
} from "@varin/protocol";
import type { HarnessService, HarnessServiceContext } from "./router.js";
import { HarnessServiceError } from "./service-error.js";
import type { HarnessServiceHost } from "./service-host.js";
import type { WebMaterialStore } from "./web-materials.js";

/** Per-candidate excerpt budget so sections stay inside the state budget. */
const MATERIAL_EXCERPT_LIMIT = 2000;

export interface ResearchDecideDeps {
  fastDecisionStatus?: HarnessServiceHost["fastDecisionStatus"];
  fastDecision?: HarnessServiceHost["fastDecision"];
  materials?: WebMaterialStore;
  resolveThreadId?: (sessionId: string) => Promise<string | undefined>;
}

const KIND_INSTRUCTIONS: Record<Exclude<ResearchDecideKind, "next">, string> = {
  "relevance": "How relevant is this candidate to the goal as stated, based on what is known about it?",
  "reading-value": "How valuable is opening or reading this candidate next for the goal? Judge exploration value, not only immediate relevance.",
  "complementary": "Does this candidate likely add information missing from the material already seen for this goal?",
  "duplicate": "Does this candidate likely duplicate material already available for this goal?",
  "continuation": "Is this candidate worth continuing to trace — following its relations, terms, or links — for this goal?",
};

const SCORE_LEVELS = ["none", "low", "moderate", "high"] as const;

const fallbackResult = (
  params: ResearchDecideParams,
  purpose: "web" | "scholarly",
  status: ResearchDecideResult["status"],
  rejected: ResearchDecideResult["rejected"],
  message?: string,
): ResearchDecideResult => ({
  status,
  purpose,
  kind: params.kind,
  ranked: params.candidates
    .filter((candidate) => !rejected.some((item) => item.id === candidate.id))
    .map((candidate) => ({ id: candidate.id })),
  rejected,
  missing: [],
  fallback: "order",
  ...(message !== undefined ? { message } : {}),
});

export function createResearchDecideService(deps: ResearchDecideDeps): HarnessService<"research.decide"> {
  return {
    async handle(params: ResearchDecideParams, ctx: HarnessServiceContext): Promise<ResearchDecideResult> {
      const goal = typeof params.goal === "string" ? params.goal.trim() : "";
      if (!goal) throw new HarnessServiceError("invalid-params", "goal must be a non-empty string");
      if (!Array.isArray(params.candidates) || params.candidates.length === 0) {
        throw new HarnessServiceError("invalid-params", "candidates must be a non-empty array");
      }
      const seen = new Set<string>();
      for (const candidate of params.candidates) {
        if (!candidate || typeof candidate.id !== "string" || !candidate.id.trim()) {
          throw new HarnessServiceError("invalid-params", "every candidate needs a non-empty id");
        }
        if (seen.has(candidate.id)) {
          throw new HarnessServiceError("invalid-params", `duplicate candidate id "${candidate.id}"`);
        }
        seen.add(candidate.id);
      }

      const workspaceId = ctx.workspaceId;
      if (!workspaceId) throw new HarnessServiceError("forbidden", "research.decide requires an owning workspace");

      const purpose: "web" | "scholarly" = params.purpose
        ?? (params.candidates.some((candidate) => candidate.kind === "paper") ? "scholarly" : "web");

      const resolvedThreadId = await deps.resolveThreadId?.(ctx.sessionId);
      const authority = {
        owningWorkspaceId: workspaceId,
        sessionId: ctx.sessionId,
        ...(resolvedThreadId ? { threadId: resolvedThreadId } : {}),
      };

      // Validate references under the caller's authority before judging. A
      // snapshot id that does not resolve to readable material is rejected —
      // it is never silently judged as if it were real content.
      const rejected: ResearchDecideResult["rejected"] = [];
      const excerpt = new Map<string, string>();
      for (const candidate of params.candidates) {
        const snapshotId = candidate.kind === "section"
          ? candidate.section?.snapshotId
          : candidate.kind === "snapshot" ? candidate.snapshotId : undefined;
        if (candidate.kind === "snapshot" || candidate.kind === "section") {
          if (!snapshotId) {
            rejected.push({ id: candidate.id, reason: "snapshot reference missing" });
            continue;
          }
          const content = deps.materials
            ? await deps.materials.read(workspaceId, snapshotId, authority).catch(() => null)
            : null;
          if (!content) {
            rejected.push({ id: candidate.id, reason: "snapshot not readable under caller authority" });
            continue;
          }
          const text = content.body.toString("utf8");
          const lines = text.split("\n");
          const start = candidate.section?.startLine ?? 1;
          const end = candidate.section?.endLine ?? Math.min(lines.length, start + 60);
          const slice = lines.slice(Math.max(0, start - 1), Math.max(0, end)).join("\n");
          excerpt.set(candidate.id, slice.slice(0, MATERIAL_EXCERPT_LIMIT));
        } else if (candidate.kind === "url") {
          const url = candidate.url?.trim();
          if (!url || !/^https?:\/\//u.test(url)) {
            rejected.push({ id: candidate.id, reason: "url candidate needs an http(s) url" });
          }
        } else if (candidate.kind === "paper") {
          if (!candidate.paper?.providerId?.trim() || !candidate.paper?.providerRecordId?.trim()) {
            rejected.push({ id: candidate.id, reason: "paper candidate needs providerId and providerRecordId" });
          }
        } else if (candidate.kind === "query") {
          if (!candidate.detail?.trim()) {
            rejected.push({ id: candidate.id, reason: "query candidate needs detail text" });
          }
        }
      }
      const candidates = params.candidates.filter((candidate) => !rejected.some((item) => item.id === candidate.id));

      const status = deps.fastDecisionStatus
        ? await deps.fastDecisionStatus(workspaceId, purpose).catch(() => undefined)
        : undefined;
      if (!deps.fastDecision || !status || status.status !== "ready") {
        const resolved = !deps.fastDecision || !status ? "unavailable"
          : status.status === "disabled" ? "disabled"
          : status.status === "unconfigured" ? "unconfigured"
          : "unavailable";
        return fallbackResult(
          { ...params, candidates },
          purpose,
          resolved,
          rejected,
          status?.status === "invalid" || status?.status === "unavailable" ? status.message : undefined,
        );
      }

      const materials: FastDecisionMaterial[] = candidates.map((candidate) => {
        const parts = [
          `[${candidate.kind}]`,
          candidate.title,
          candidate.detail,
          candidate.url,
          candidate.paper ? `${candidate.paper.providerId}:${candidate.paper.providerRecordId}${candidate.paper.doi ? ` doi:${candidate.paper.doi}` : ""}` : undefined,
          excerpt.get(candidate.id),
        ].filter((part): part is string => typeof part === "string" && part.trim().length > 0);
        const label = candidate.section?.label
          ?? (candidate.snapshotId ? `snapshot:${candidate.snapshotId}` : undefined)
          ?? (candidate.section?.snapshotId ? `snapshot:${candidate.section.snapshotId}` : undefined);
        return {
          id: candidate.id,
          text: parts.join("\n").slice(0, MATERIAL_EXCERPT_LIMIT),
          ...(label !== undefined ? { label } : {}),
        };
      });

      const questions: FastDecisionQuestion[] = params.kind === "next"
        ? [{
            id: "next",
            kind: "choose",
            instructions: `Choose the single best material to open next for this goal, or none if no candidate helps.\nGoal: ${goal}`,
            options: candidates.map((candidate) => ({
              id: candidate.id,
              ...(candidate.title ? { detail: candidate.title } : {}),
            })),
            allowNone: true,
          }]
        : candidates.map((candidate) => {
            const kind = params.kind === "next" ? "relevance" : params.kind;
            return {
              id: candidate.id,
              kind: "score" as const,
              instructions: `${KIND_INSTRUCTIONS[kind]}\nGoal: ${goal}`,
              levels: SCORE_LEVELS,
            };
          });

      let result;
      try {
        result = await deps.fastDecision({
          workspaceId,
          purpose: purpose as HarnessFastDecisionPurpose,
          settings: status.binding,
          goal,
          materials,
          questions,
          signal: ctx.signal,
        });
      } catch (error) {
        if (ctx.signal.aborted) {
          return fallbackResult({ ...params, candidates }, purpose, "cancelled", rejected);
        }
        return fallbackResult(
          { ...params, candidates },
          purpose,
          "failed",
          rejected,
          error instanceof Error ? error.message : String(error),
        );
      }

      const missing = new Set(result.missing);
      let ranked: ResearchDecideRankedCandidate[];
      if (params.kind === "next") {
        const answer = result.answers.find((item) => item.id === "next" && item.kind === "choose");
        const choice = answer && answer.kind === "choose" ? answer.choice : null;
        ranked = candidates.map((candidate) => ({
          id: candidate.id,
          ...(candidate.id === choice ? { selected: true } : {}),
        }));
      } else {
        const answers = new Map(
          result.answers
            .filter((item) => item.kind === "score")
            .map((item) => [item.id, item] as const),
        );
        ranked = candidates.map((candidate) => {
          const answer = answers.get(candidate.id);
          return answer && answer.kind === "score"
            ? {
                id: candidate.id,
                score: answer.score,
                ...(answer.probabilities !== undefined ? { probabilities: answer.probabilities } : {}),
              }
            : { id: candidate.id };
        });
        // Lower scores first affect ordering; missing/unscored candidates keep
        // their relative order at the end rather than being read as zero.
        const order = new Map(candidates.map((candidate, index) => [candidate.id, index]));
        ranked = [...ranked].sort((a, b) => (
          (b.score ?? -1) - (a.score ?? -1) || (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0)
        ));
      }

      return {
        status: result.answers.length === 0 ? "failed" : "ok",
        purpose,
        kind: params.kind,
        ranked,
        rejected,
        missing: [...missing].filter((id) => id !== "next" || params.kind === "next"),
        providerId: result.providerId,
        modelId: result.modelId,
        ...(result.servedModelId !== undefined ? { servedModelId: result.servedModelId } : {}),
        configurationId: status.binding.configurationId,
        ...(result.usage !== undefined ? { usage: result.usage } : {}),
        ...(result.answers.length === 0 ? { message: "provider returned no answers" } : {}),
      };
    },
  };
}
