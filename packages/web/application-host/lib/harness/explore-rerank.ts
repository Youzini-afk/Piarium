/**
 * Dedicated HTTP rerank consumer. It reorders already-built views and never
 * invents groups, required ranges, gaps, or zero scores.
 */

import {
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
  if (!harness || typeof harness !== "object" || Array.isArray(harness)) return undefined;
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
  const lines = view.text.split(/\r\n|\n|\r/);
  let end = lines.length;
  while (end > 1 && countTokens(lines.slice(0, end).join("\n")) > maxTokens) end -= 1;
  let text = lines.slice(0, end).join("\n");
  if (countTokens(text) > maxTokens) {
    let low = 1;
    let high = text.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (countTokens(text.slice(0, middle)) <= maxTokens) low = middle;
      else high = middle - 1;
    }
    text = text.slice(0, Math.max(1, low));
    end = 1;
  }
  return {
    ...view,
    endLine: view.startLine + end - 1,
    text,
  };
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
    const prepared = maxTokens ? shrinkViewForRerank(view, maxTokens, countTokens) : view;
    documents.push({ id: view.viewId, text: prepared.text, revision: prepared.revision });
    evaluated.push(prepared);
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
