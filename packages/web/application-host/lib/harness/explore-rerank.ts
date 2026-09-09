/**
 * Dedicated HTTP rerank consumer. It reorders already-built views and never
 * invents groups, required ranges, gaps, or zero scores.
 */

import {
  HarnessInferenceSettingsValidationError,
  parseHarnessRerankSettings,
  type ExploreQueryView,
  type ExploreRerankDetails,
  type ExploreRerankScore,
  type HarnessRerankResult,
  type HarnessRerankSettings,
  type PiSettingsSnapshot,
} from "@piarium/protocol";
import type { ExploreModelParticipation } from "@piarium/protocol";

export function rerankSettingsFromSnapshot(snapshot: PiSettingsSnapshot | null | undefined): HarnessRerankSettings | undefined {
  const harness = snapshot?.global?.harness;
  if (harness === undefined) return undefined;
  if (!harness || typeof harness !== "object" || Array.isArray(harness)) {
    throw new HarnessInferenceSettingsValidationError("harness must be an object");
  }
  return parseHarnessRerankSettings((harness as { rerank?: unknown }).rerank);
}

export function exploreShouldRerank(model?: ExploreModelParticipation): boolean {
  const select = model?.select ?? "unconfigured";
  return select === "skipped" || select === "unconfigured";
}

export function shrinkViewForRerank(
  view: ExploreQueryView,
  maxTokens: number,
  countTokens: (text: string) => number,
): ExploreQueryView {
  if (countTokens(view.text) <= maxTokens) return view;
  throw new RangeError("Rerank view exceeds the configured document budget");
}

export function documentsFromViews(
  views: readonly ExploreQueryView[],
  maxTokens: number | undefined,
  countTokens: (text: string) => number,
): { documents: Array<{ id: string; text: string; revision: string }>; evaluated: ExploreQueryView[] } {
  const documents: Array<{ id: string; text: string; revision: string }> = [];
  const evaluated: ExploreQueryView[] = [];
  for (const view of views) {
    if (view.unevaluated) continue;
    if (maxTokens !== undefined && countTokens(view.text) > maxTokens) continue;
    documents.push({ id: view.viewId, text: view.text, revision: view.revision });
    evaluated.push(view);
  }
  return { documents, evaluated };
}

export function scoresFromRerankResult(
  result: HarnessRerankResult,
  submitted: ReadonlyArray<{ id: string }>,
): ExploreRerankScore[] {
  const allowed = new Set(submitted.map((item) => item.id));
  const scores: ExploreRerankScore[] = [];
  for (const row of result.scores) {
    if (!allowed.has(row.id) || !Number.isFinite(row.score)) continue;
    scores.push({ viewId: row.id, score: row.score });
  }
  return scores;
}

export function rerankFailureDetails(
  settings: HarnessRerankSettings,
  status: ExploreRerankDetails["status"],
  note: string,
): ExploreRerankDetails {
  return {
    status,
    providerId: settings.providerId,
    modelId: settings.modelId,
    note,
  };
}
