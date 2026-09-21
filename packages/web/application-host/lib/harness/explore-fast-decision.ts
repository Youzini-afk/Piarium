/**
 * Fast Decision loop for explore queries (D-312). The query owner keeps file,
 * graph, revision, and cancellation authority; this module only turns real
 * views and issued action candidates into typed questions, applies the
 * provider's judgments through `applySelection`/`followup`, and reports what
 * actually happened.
 *
 * Two axes stay separate on purpose: `m:` questions decide whether material
 * belongs in the returned answer, `a:` questions decide whether a concrete
 * next step is worth executing. A missing answer is never read as a no.
 */
import {
  type ExploreFastDecisionDetails,
  type ExploreModelStageStatus,
  type ExploreQueryAction,
  type ExploreQueryView,
  type FastDecisionAnswer,
  type FastDecisionMaterial,
  type FastDecisionQuestion,
  type HarnessFastDecisionPurposeStatus,
  type HarnessResolvedFastDecisionBinding,
} from "@varin/protocol";
import type { ExploreQueryRun } from "./explore.js";

/** What `explore.query.start` freezes onto the query and reports to callers. */
export type ExploreFastDecisionState =
  | { status: "ready"; binding: HarnessResolvedFastDecisionBinding }
  | { status: "disabled" | "unconfigured" | "invalid" | "unavailable" };

/**
 * Map the Pi-described purpose status onto the state a query freezes at
 * start. A missing entry means the runtime predates the capability.
 */
export function resolveExploreFastDecision(
  status: HarnessFastDecisionPurposeStatus | undefined,
): ExploreFastDecisionState {
  if (!status) return { status: "unavailable" };
  if (status.status === "ready") return { status: "ready", binding: status.binding };
  return { status: status.status };
}

export function fastDecisionStageStatus(details: ExploreFastDecisionDetails | undefined): ExploreModelStageStatus {
  return details?.status ?? "skipped";
}

/** Rough per-material text bound; the provider's own state limit still applies. */
const MATERIAL_TEXT_LIMIT = 8 * 1024;

const clipMaterial = (text: string): string => (
  text.length <= MATERIAL_TEXT_LIMIT ? text : `${text.slice(0, MATERIAL_TEXT_LIMIT)}\n…`
);

const MATERIAL_YES = "Carries evidence the answer should cite: the implementation, call path, contract, or failure the question is about.";
const MATERIAL_NO = "Does not carry that evidence — an unrelated match, a duplicated window, or noise.";
const ACTION_YES = "Executing this step is likely to produce material that improves the answer.";
const ACTION_NO = "This step is unlikely to add evidence beyond what is already read or selected.";

const isAbort = (error: unknown): boolean => (
  error instanceof Error && error.name === "AbortError"
);

const errorMessage = (error: unknown): string => (
  error instanceof Error ? error.message : String(error)
);

export interface ExploreFastDecisionLoopInput {
  run: ExploreQueryRun;
  /** Binding resolved when the query started; settings edits never reach it. */
  binding: HarnessResolvedFastDecisionBinding;
  /** One batch against the provider; throws on provider/transport failure. */
  call: (input: {
    goal: string;
    materials: FastDecisionMaterial[];
    questions: FastDecisionQuestion[];
    signal: AbortSignal;
  }) => Promise<HarnessFastDecisionResultWire>;
  /** Loop lifetime: cancel/release/finish-stop. Outlives the source deadline. */
  signal: AbortSignal;
  /** Wall clock the loop must not outrun. */
  deadlineAt: number;
  /**
   * Set by `explore.query.finish`: stop offering new actions, judge what is
   * already fresh once, and settle. `promise` wakes a parked round.
   */
  closing: { promise: Promise<void>; requested: () => boolean };
  now?: () => number;
}

export interface HarnessFastDecisionResultWire {
  answers: FastDecisionAnswer[];
  missing: string[];
  servedModelId?: string;
  usage?: { inputTokens?: number; outputTokens?: number };
}

/**
 * Progressive selection: judge fresh material for the answer, judge pending
 * actions for exploration value, execute chosen actions inside the same
 * query, and repeat while new material keeps arriving. Terminates on a
 * quiet round, a cancelled/finished query, the deadline, or a settle
 * request — never on a fixed round count.
 *
 * Provider and transport failures do not throw out of here: the loop returns
 * honest details so the query can finish on source-ranked material.
 */
export async function runExploreFastDecisionLoop(
  input: ExploreFastDecisionLoopInput,
): Promise<ExploreFastDecisionDetails> {
  const now = input.now ?? Date.now;
  const details: ExploreFastDecisionDetails = {
    status: "used",
    providerId: input.binding.providerId,
    modelId: input.binding.modelId,
    batches: 0,
    rounds: 0,
    viewsJudged: 0,
    actionsOffered: 0,
    actionsExecuted: 0,
    executed: [],
    missing: 0,
    unevaluatedMaterials: 0,
  };
  const judged = new Set<string>();
  let usage: { inputTokens?: number; outputTokens?: number } | undefined;

  try {
    while (input.run.terminal() === "active") {
      input.signal.throwIfAborted();
      if (now() >= input.deadlineAt) break;
      // Wait for the pipeline to produce or for finish to ask us to settle.
      await Promise.race([input.run.waitForViews(), input.closing.promise]);
      input.signal.throwIfAborted();
      if (input.run.terminal() !== "active") break;
      const closing = input.closing.requested();
      // Once the query's source signal closed (source deadline), launched
      // actions die instantly — judge what remains, offer nothing new.
      const canAct = !closing && !input.run.signal.aborted;
      const { views, unevaluated } = input.run.viewsForModel();
      const fresh = views.filter((view) => !view.unevaluated && !judged.has(view.viewId));
      const pending = canAct
        ? (await input.run.actionCandidates()).filter(
          (candidate) => !details.executed.includes(candidate.actionId),
        )
        : [];
      if (fresh.length === 0 && pending.length === 0) break;
      details.rounds += 1;
      details.unevaluatedMaterials += unevaluated;

      const materials: FastDecisionMaterial[] = fresh.map((view: ExploreQueryView) => ({
        id: view.viewId,
        label: `${view.path}:${view.startLine}-${view.endLine}`,
        revision: view.revision,
        text: clipMaterial(view.text),
      }));
      const questions: FastDecisionQuestion[] = [
        ...fresh.map((view): FastDecisionQuestion => ({
          id: `m:${view.viewId}`,
          kind: "judge",
          instructions: {
            question: "Should the material with this id be part of the answer to the goal?",
            material: view.viewId,
            location: `${view.path}:${view.startLine}-${view.endLine}`,
          },
          criteria: { yes: MATERIAL_YES, no: MATERIAL_NO },
        })),
        ...pending.map((action: ExploreQueryAction): FastDecisionQuestion => ({
          id: `a:${action.actionId}`,
          kind: "judge",
          instructions: {
            question: "Would executing this step likely produce material that improves the answer?",
            step: { id: action.actionId, kind: action.kind, target: action.target, reason: action.why },
          },
          criteria: { yes: ACTION_YES, no: ACTION_NO },
        })),
      ];

      const result = await input.call({
        goal: input.run.question,
        materials,
        questions,
        signal: input.signal,
      });
      details.batches += 1;
      details.viewsJudged += fresh.length;
      details.actionsOffered += pending.length;
      details.missing += result.missing.length;
      if (result.servedModelId) details.servedModelId = result.servedModelId;
      if (result.usage) {
        usage = {
          inputTokens: (usage?.inputTokens ?? 0) + (result.usage.inputTokens ?? 0),
          outputTokens: (usage?.outputTokens ?? 0) + (result.usage.outputTokens ?? 0),
        };
      }
      for (const view of fresh) judged.add(view.viewId);
      const answered = new Map(result.answers.map((answer) => [answer.id, answer]));

      const include = fresh
        .filter((view) => {
          const answer = answered.get(`m:${view.viewId}`);
          return answer?.kind === "judge" && answer.value >= 0.5;
        })
        .map((view) => view.viewId);
      if (include.length > 0) {
        input.run.applySelection([{
          id: `fast:${details.rounds}`,
          purpose: "fast-decision material",
          views: include.map((viewId) => ({ viewId })),
        }], { merge: true });
      }

      if (closing) break;
      const chosen = pending.filter((action) => {
        const answer = answered.get(`a:${action.actionId}`);
        return answer?.kind === "judge" && answer.value >= 0.5;
      });
      if (chosen.length === 0) break;
      const followup = await input.run.followup({ actions: chosen });
      details.executed.push(...followup.actionsExecuted);
      details.actionsExecuted += followup.actionsExecuted.length;
      // A round that produced no new views leaves nothing more to judge.
      if (followup.actionsExecuted.length === 0 || followup.newViews.length === 0) break;
    }
  } catch (error) {
    const aborted = isAbort(error) || input.signal.aborted || input.run.terminal() === "cancelled";
    details.status = aborted ? "cancelled" : "failed";
    if (!aborted) details.note = errorMessage(error);
  }
  if (usage) details.usage = usage;
  if (details.batches === 0 && details.status === "used") {
    details.note = "No evaluable material arrived before the loop settled.";
  }
  return details;
}
