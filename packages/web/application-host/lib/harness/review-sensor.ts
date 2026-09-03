/**
 * Review sensor — auto-dispatch review agent after settled turns with diffs.
 *
 * Design: agent-harness.md §9.2.2
 * Plan: agent-harness-plan.md §3.7
 *
 * agent_settled → if journaled changes non-empty → spawnChild(review, diff)
 * Result injected as Zone 2 <review> section (non-blocking).
 * harness.review.gate = true → wait and inject at turn end.
 */

import type { WorkerRuntime } from "./worker-runtime.js";
import type { ResolvedRole } from "./roles.js";

// ── Types ──────────────────────────────────────────────────────────

export interface ReviewSensorSettings {
  gate: boolean; // default false (non-blocking)
}

export const DEFAULT_REVIEW_SENSOR_SETTINGS: ReviewSensorSettings = {
  gate: false,
};

export interface ReviewSensorDeps {
  runtime: WorkerRuntime;
  reviewRole: ResolvedRole | null;
  settings: ReviewSensorSettings;
  /** Get journaled changes for current turn */
  getJournaledChanges: (sessionId: string) => Promise<string[]>;
  /** Get diff text */
  getDiff: (sessionId: string) => Promise<string>;
}

// ── Sensor ─────────────────────────────────────────────────────────

export interface ReviewResult {
  reviewDispatched: boolean;
  childId?: string;
  reviewText?: string;
  blocking: boolean;
}

export async function onAgentSettled(
  sessionId: string,
  deps: ReviewSensorDeps,
): Promise<ReviewResult> {
  const { runtime, reviewRole, settings, getJournaledChanges, getDiff } = deps;

  // Check if there are journaled changes
  const changes = await getJournaledChanges(sessionId);
  if (changes.length === 0) {
    return { reviewDispatched: false, blocking: false };
  }

  // No review role configured → skip
  if (!reviewRole) {
    return { reviewDispatched: false, blocking: false };
  }

  // Get diff
  const diff = await getDiff(sessionId);

  // Dispatch review
  const dispatchResult = await runtime.dispatch("review", `Review this diff:\n${diff}`, {
    resolvedRole: reviewRole,
    parentSessionId: sessionId,
  });

  const childId = dispatchResult.match(/(?:dispatched|queued as) (\S+)/)?.[1];
  const blocking = settings.gate;

  return {
    reviewDispatched: true,
    ...(childId ? { childId } : {}),
    blocking,
  };
}

/**
 * Format review result for Zone 2 injection.
 */
export function formatReviewForZone2(reviewText: string): string {
  return `<review>\n${reviewText}\n</review>`;
}
