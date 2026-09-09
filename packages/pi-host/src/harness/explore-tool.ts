import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentInputContext, ExploreModelParticipation, ExploreModelStageStatus } from "@piarium/protocol";
import type { HostServicesBridge } from "./host-services-bridge.js";
import {
  EXPLORE_PLAN_SYSTEM,
  EXPLORE_SELECT_SYSTEM,
  exploreShouldPlanWithModel,
  exploreShouldSelectWithModel,
  parseExplorePlan,
  parseExploreSelection,
  renderExplorePlanPrompt,
  renderExploreSelectPrompt,
} from "./explore-model.js";

const ExploreParams = Type.Object({
  question: Type.String({ description: "What you want to find or understand in the codebase" }),
  anchors: Type.Optional(Type.Array(Type.String(), {
    description: "Known symbols, method names, error text, or path fragments. Matched literally and prioritized; not a hard filter.",
  })),
  paths: Type.Optional(Type.Array(Type.String(), { description: "Optional subpaths or directories to restrict search to" })),
  limit: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum number of excerpts to return (default 20)" })),
});

/** Public remaining wait shared across stages. Not a calibrated SLO. */
export const EXPLORE_PUBLIC_BUDGET_MS = 120_000;

function boundByDeadline(signal: AbortSignal | undefined, deadlineAt: number): AbortSignal {
  const remaining = Math.max(1, deadlineAt - Date.now());
  const timeout = AbortSignal.timeout(remaining);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export type ExploreModelComplete = (input: {
  systemPrompt: string;
  user: string;
  signal?: AbortSignal;
}) => Promise<string>;

function stageFromError(error: unknown, signal?: AbortSignal): ExploreModelStageStatus {
  if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) return "cancelled";
  return "failed";
}

export function createExploreTool(
  bridge: HostServicesBridge,
  _sessionId: string,
  options?: { complete?: ExploreModelComplete },
): ToolDefinition {
  return defineTool({
    name: "explore",
    label: "Explore",
    description: "Locate relevant code and read the related context in the same call (definitions, registration sites, callers, and the excerpts needed to judge). Use grep when you only need an exact match. Put known symbols, method names, error text, and path fragments in anchors. Natural-language questions can be rewritten into repository search expressions when models.explore is configured; conceptual names do not have to match identifiers literally.",
    promptSnippet: "explore: locate and read related context in one call; put known symbols, method names, error text, and path fragments in anchors; conceptual questions can be mapped to repository names; use grep for exact match only",
    promptGuidelines: [
      "Use explore to locate code and read the related context (definitions, registration sites, callers, and excerpts needed to judge) in one call.",
      "Use grep when you only need exact matches.",
      "Put known symbols, method names, error text, and path fragments in anchors.",
      "Explore can bridge a conceptual question and repository identifiers when an explore model is configured. It still returns current source excerpts, not a substitute analysis.",
    ],
    parameters: ExploreParams,
    executionMode: "parallel",
    execute: async (_toolCallId, params, signal, _onUpdate, _ctx) => {
      const pinned: AgentInputContext = structuredClone(bridge.inputContext() ?? { source: "disk" });
      const startedAt = Date.now();
      const remaining = (): number => Math.max(1, EXPLORE_PUBLIC_BUDGET_MS - (Date.now() - startedAt));
      let queryId = "";
      const request = async <M extends "explore.query.start" | "explore.query.plan" | "explore.query.views" | "explore.query.select" | "explore.query.followup" | "explore.query.finish" | "explore.query.release" | "explore.query.cancel">(
        method: M,
        methodParams: Parameters<HostServicesBridge["request"]>[1],
        timeoutMs = remaining(),
      ) => bridge.request(method, methodParams as never, {
        ...(signal ? { signal } : {}),
        timeoutMs,
        inputContext: pinned,
      });

      const cancelQuery = (): void => {
        if (!queryId) return;
        try {
          bridge.cancel({ queryId });
        } catch {
          // Cancel is best-effort; the public tool is already stopping.
        }
      };
      if (signal) {
        if (signal.aborted) cancelQuery();
        else signal.addEventListener("abort", cancelQuery, { once: true });
      }

      try {
        const complete = options?.complete;
        const started = await request("explore.query.start", {
          question: params.question,
          ...(params.anchors ? { anchors: params.anchors } : {}),
          ...(params.paths ? { paths: params.paths } : {}),
          ...(params.limit ? { limit: params.limit } : {}),
          budgetMs: remaining(),
          reserveForJudge: Boolean(complete),
        });
        queryId = started.queryId;
        const deadlineAt = started.deadlineAt;
        const modelSignal = () => boundByDeadline(signal, deadlineAt);

        const participation: ExploreModelParticipation = {
          plan: complete ? "skipped" : "unconfigured",
          select: complete ? "skipped" : "unconfigured",
          followup: complete ? "skipped" : "unconfigured",
        };
        if (!complete) {
          participation.note = "Explore model is not configured; excerpts are from algorithm and vector sources.";
        }

        const shouldPlan = Boolean(complete) && exploreShouldPlanWithModel(params.question, started.parsed.objects);
        if (complete && shouldPlan) {
          try {
            const planText = await complete({
              systemPrompt: EXPLORE_PLAN_SYSTEM,
              user: renderExplorePlanPrompt(started),
              signal: modelSignal(),
            });
            const plan = parseExplorePlan(planText);
            if (plan) {
              const submitted = await request("explore.query.plan", { queryId, plan });
              participation.plan = submitted.launched.length > 0 ? "used" : "skipped";
            } else {
              participation.plan = "failed";
              participation.note = "Explore model plan was unused; excerpts are from algorithm and vector sources.";
            }
          } catch (error) {
            participation.plan = stageFromError(error, signal);
            if (participation.plan === "failed") {
              participation.note = "Explore model plan failed; excerpts are from algorithm and vector sources.";
            }
          }
        }

        const views = await request("explore.query.views", { queryId });
        const shouldSelect = Boolean(complete)
          && views.views.length > 0
          && exploreShouldSelectWithModel(params.question, started.parsed.objects, participation.plan === "used");
        if (complete && shouldSelect) {
          let activeStage: "select" | "followup" = "select";
          try {
            const selectText = await complete({
              systemPrompt: EXPLORE_SELECT_SYSTEM,
              user: renderExploreSelectPrompt(params.question, views, "full"),
              signal: modelSignal(),
            });
            const selected = parseExploreSelection(selectText);
            if (selected) {
              const applied = await request("explore.query.select", { queryId, groups: selected.groups });
              participation.select = applied.accepted.length > 0 ? "used" : "skipped";
              if (participation.select === "used" && (participation.plan === "failed" || participation.plan === "cancelled")) {
                participation.note = `Explore model plan ${participation.plan}; model selection used the candidates that were available.`;
              }
              if (applied.accepted.length === 0 && applied.rejected.length > 0) {
                participation.note = participation.note
                  ?? "Explore model selection was rejected; excerpts are from algorithm and vector sources.";
              }
              if (selected.followup && Date.now() < deadlineAt) {
                activeStage = "followup";
                const followup = await request("explore.query.followup", {
                  queryId,
                  ...(selected.followup.searches ? { searches: selected.followup.searches } : {}),
                  ...(selected.followup.locates ? { locates: selected.followup.locates } : {}),
                  ...(selected.groups.map((group) => group.gap).filter(Boolean).length
                    ? { gaps: selected.groups.flatMap((group) => group.gap ? [group.gap] : []) }
                    : {}),
                });
                participation.followup = followup.launched.length > 0 ? "used" : "skipped";
                if (followup.newViews.length > 0) {
                  const acceptedViewIds = new Set(applied.accepted.flatMap((group) => group.viewIds));
                  const selectedViews = views.views.filter((view) => (
                    acceptedViewIds.has(view.viewId)
                  ));
                  const incrementalText = await complete({
                    systemPrompt: EXPLORE_SELECT_SYSTEM,
                    user: renderExploreSelectPrompt(params.question, views, "incremental", {
                      selectedViews,
                      newViews: followup.newViews,
                    }),
                    signal: modelSignal(),
                  });
                  const incremental = parseExploreSelection(incrementalText);
                  if (incremental) {
                    const incrementallyApplied = await request("explore.query.select", { queryId, groups: incremental.groups, merge: true });
                    if (incrementallyApplied.accepted.length > 0) {
                      participation.select = "used";
                      if (participation.plan === "failed" || participation.plan === "cancelled") {
                        participation.note = `Explore model plan ${participation.plan}; model selection used the candidates that were available.`;
                      }
                    }
                  }
                }
              }
            } else {
              participation.select = "failed";
              participation.note = participation.note
                ?? "Explore model selection was unused; excerpts are from algorithm and vector sources.";
            }
          } catch (error) {
            const status = stageFromError(error, signal);
            if (activeStage === "select") {
              participation.select = status;
              if (status === "failed") {
                participation.note = participation.note
                  ?? "Explore model selection failed; excerpts are from algorithm and vector sources.";
              }
            } else {
              participation.followup = status;
              if (status === "failed") {
                participation.note = participation.note
                  ?? (participation.select === "used"
                    ? "Explore follow-up failed; the earlier accepted material was kept."
                    : "Explore follow-up failed; excerpts are from algorithm and vector sources.");
              }
            }
          }
        }

        const result = await request("explore.query.finish", { queryId, model: participation });
        return {
          content: [{ type: "text", text: result.text }],
          details: {
            snippets: result.snippets,
            searched: result.searched,
            handle: result.handle,
            issues: result.issues,
            partial: result.partial,
            notRequested: result.notRequested,
            omitted: result.omitted,
            provenance: result.details,
            model: result.details.model ?? participation,
          },
        };
      } catch (error) {
        signal?.throwIfAborted();
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `explore failed: ${message}` }],
          details: { error: message },
          isError: true,
        };
      } finally {
        if (queryId) {
          try {
            await bridge.request("explore.query.release", { queryId }, {
              timeoutMs: 5_000,
              inputContext: pinned,
            });
          } catch {
            // Release is cleanup; the tool result is already decided.
          }
        }
      }
    },
  });
}
