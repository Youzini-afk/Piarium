/**
 * Follow-up registrations: durable wait intent + continuation contract (D-307).
 *
 * A follow-up binds a *source* (what to wait for) to a continuation *instruction*
 * (what the agent should do when it fires) on the originating session/thread.
 * The host owns observation and delivery — agents register intent; programs watch
 * the source; the original thread is resumed through the normal Thread/Run
 * lifecycle when the condition holds.
 */
import type { JsonValue } from "./types.js";

/** What the program watches. Field sets are per-kind; no arbitrary script conditions. */
export type FollowUpSource =
  | {
      kind: "time";
      /** Absolute due time (epoch ms), resolved at registration. */
      at: number;
      /** Original timezone intent for display (IANA name); `at` stays authoritative. */
      timezone?: string;
    }
  | {
      kind: "experiment";
      /** Durable attempt identity returned by experiment.submit. */
      attemptId: string;
      /** Terminal-ish states that satisfy the wait; default = any terminal. */
      states?: string[];
      /**
       * Optional deadline backstop: fires a "deadline" occurrence while the
       * attempt is still running without cancelling the terminal wait.
       */
      fallbackAt?: number;
    }
  | {
      /** Fires only through an explicit followup.check or host-side event. */
      kind: "manual";
      /** Free-form source description kept for the audit trail. */
      note?: string;
    };

export type FollowUpStatus =
  /** Registered and observing the source. */
  | "waiting"
  /** An occurrence fired; delivery to the target is in progress. */
  | "triggered"
  /** The latest occurrence reached the target (or the source is a one-shot). */
  | "delivered"
  | "cancelled"
  /** Replaced by a newer definition revision (update creates a successor). */
  | "superseded"
  /** The source can no longer be observed (lost shell, missing attempt). */
  | "unavailable";

export interface FollowUpDefinitionView {
  id: string;
  workspaceId: string;
  /** Present when the target is a thread; absent targets the session itself. */
  threadId?: string;
  sessionId: string;
  instruction: string;
  source: FollowUpSource;
  status: FollowUpStatus;
  /** Content revision for CAS updates/cancel. */
  revision: string;
  /** Registering run when known. */
  runId?: string;
  /** The agent explicitly paused the goal/run for this wait. */
  pausedGoal: boolean;
  createdAt: number;
  updatedAt: number;
  /** Latest occurrence summary, when any. */
  lastOccurrence?: {
    id: string;
    reason: string;
    at: number;
    delivered: boolean;
  };
  /** Human-facing summary of what is being awaited (i18n-free text). */
  waitingSummary: string;
}

export type FollowUpOccurrenceDelivery =
  /** Injected into the active run's next request (inform). */
  | "active-inform"
  /** Resumed the settled thread through normal admission (new run). */
  | "continued"
  /** Parked behind the execution budget; will continue on dequeue. */
  | "parked"
  /** Recorded but not delivered — target gone/cancelled. */
  | "dropped";

export interface FollowUpOccurrenceView {
  id: string;
  followUpId: string;
  reason: string;
  facts: Record<string, JsonValue>;
  delivery: FollowUpOccurrenceDelivery;
  runId?: string;
  at: number;
}

export interface FollowUpRegisterParams {
  source: FollowUpSource;
  /** What the agent should do when the source fires — natural language. */
  instruction: string;
  /**
   * Explicit pause: end the current turn and yield the model slot until the
   * source fires. Suppresses goal auto-continue. Without pause the agent keeps
   * working and the trigger lands as an inform while it runs.
   */
  pause?: boolean;
}

export interface FollowUpRegisterResult {
  followUp: FollowUpDefinitionView;
  /** True when the source was already satisfied at registration — an occurrence was fired synchronously. */
  firedImmediately: boolean;
}

export interface FollowUpListParams {
  /** Default false — include cancelled/superseded/delivered history. */
  includeInactive?: boolean;
}

export interface FollowUpListResult {
  followUps: FollowUpDefinitionView[];
}

export interface FollowUpGetParams {
  id: string;
}

export interface FollowUpGetResult {
  followUp: FollowUpDefinitionView;
  occurrences: FollowUpOccurrenceView[];
}

export interface FollowUpUpdateParams {
  id: string;
  expectedRevision?: string;
  instruction?: string;
  /** Replace the source (e.g. move a deadline); takes effect at this revision. */
  source?: FollowUpSource;
}

export interface FollowUpCancelParams {
  id: string;
  expectedRevision?: string;
}

export interface FollowUpCheckParams {
  id: string;
}

export interface FollowUpCheckResult {
  followUp: FollowUpDefinitionView;
  /** True when the check observed a satisfied condition and fired. */
  fired: boolean;
  /** What the program observed during this check (compact facts). */
  observed?: Record<string, JsonValue>;
}

/** Explicit "invoke the agent now" — separate from a program check (D-307 §8). */
export interface FollowUpFireParams {
  id: string;
  expectedRevision?: string;
  /** Reason recorded on the forced occurrence. */
  reason?: string;
}

export interface FollowUpUpdateResult {
  followUp: FollowUpDefinitionView;
}
