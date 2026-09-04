/**
 * Review sensor — auto-open a review thread after a settled turn with a diff.
 *
 * Design: agent-harness.md §9.1, §9.2.3
 * Plan: agent-harness-plan.md §3.7
 *
 * agent_settled → if journaled changes are non-empty → create a hidden
 * review thread whose brief is the diff. The thread is created through the
 * same registry the parent's `dispatch` uses, but with `hidden: true`, so it
 * never appears in the parent's `threads` list (§9.2.3: the harness's own
 * agents are invisible to the main agent). Its finding is injected as a
 * Zone 2 `<review>` section on the next turn and does not block.
 *
 * `harness.review.gate = true` makes the turn wait for the finding instead.
 */

import type { ResolvedRole } from "./roles.js";
import type { Thread, ThreadRegistry } from "./thread-registry.js";

// ── Types ──────────────────────────────────────────────────────────

export interface ReviewSensorSettings {
  gate: boolean; // default false (non-blocking)
}

export const DEFAULT_REVIEW_SENSOR_SETTINGS: ReviewSensorSettings = {
  gate: false,
};

export interface ReviewSensorDeps {
  registry: ThreadRegistry;
  workspaceId: string;
  reviewRole: ResolvedRole | null;
  settings: ReviewSensorSettings;
  /** Journaled paths changed during the turn that just settled. */
  getJournaledChanges: (sessionId: string) => Promise<string[]>;
  /** Diff text for those changes. */
  getDiff: (sessionId: string) => Promise<string>;
}

// ── Sensor ─────────────────────────────────────────────────────────

export interface ReviewResult {
  reviewDispatched: boolean;
  threadId?: string;
  reviewText?: string;
  blocking: boolean;
}

export async function onAgentSettled(
  sessionId: string,
  deps: ReviewSensorDeps,
): Promise<ReviewResult> {
  const { registry, reviewRole, settings, workspaceId, getJournaledChanges, getDiff } = deps;

  const changes = await getJournaledChanges(sessionId);
  if (changes.length === 0) {
    return { reviewDispatched: false, blocking: false };
  }

  // The review slot defaults to the main model, so an absent role means the
  // session has no model at all — skip rather than fall back (invariant 6).
  if (!reviewRole) {
    return { reviewDispatched: false, blocking: false };
  }

  const diff = await getDiff(sessionId);

  const thread: Thread = await registry.createThread({
    workspaceId,
    parent: { kind: "session", id: sessionId },
    brief: `Review this diff:\n${diff}`,
    role: reviewRole.id,
    kind: "implementation",
    createdBy: "agent",
    autoRun: true,
    // Review reads the diff; it never needs a worktree of its own.
    worktree: "none",
    // Clean context is why the review is worth anything (§9.2.3).
    carryBlocks: false,
    tools: reviewRole.definition.tools,
    permissions: {},
    systemPromptFragment: reviewRole.definition.systemPromptFragment,
    hidden: true,
  });

  return {
    reviewDispatched: true,
    threadId: thread.id,
    blocking: settings.gate,
  };
}

/**
 * Format review result for Zone 2 injection.
 */
export function formatReviewForZone2(reviewText: string): string {
  return `<review>\n${reviewText}\n</review>`;
}
