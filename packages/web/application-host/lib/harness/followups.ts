/**
 * Follow-up service (D-307): durable wait intent + trigger + continuation.
 *
 * Authority model:
 * - `followup.definition` / `followup.occurrence` kernel records are the durable
 *   intent. In-memory state is only timers and the attempt subscription — both
 *   rebuild from records on reconcile().
 * - Delivery reuses the Thread/Run lifecycle: an active target gets a passive
 *   inform (lands in the next request); a settled target resumes through
 *   continueRun (requestId = occurrence id — restart/retry cannot duplicate);
 *   a queued target parks via enqueueContinuation.
 * - `pause` pauses the session goal (goal.update paused, statusReason waiting)
 *   so automation stops auditing; cancel/fire resumes it only if we paused it.
 */
import { randomUUID } from "node:crypto";
import type {
  FollowUpCancelParams,
  FollowUpCheckParams,
  FollowUpCheckResult,
  FollowUpDefinitionView,
  FollowUpFireParams,
  FollowUpGetParams,
  FollowUpGetResult,
  FollowUpListParams,
  FollowUpListResult,
  FollowUpOccurrenceDelivery,
  FollowUpOccurrenceView,
  FollowUpRegisterParams,
  FollowUpRegisterResult,
  FollowUpSource,
  FollowUpStatus,
  FollowUpUpdateParams,
  FollowUpUpdateResult,
  JsonValue,
  ThreadParent,
} from "@piarium/protocol";
import type { KernelClient, KernelScopedClient } from "../kernel/kernel-client.js";
import type { KernelRecordResult } from "../kernel/protocol.generated.js";
import type { ExperimentAttemptView } from "@piarium/protocol";
import { HarnessServiceError } from "./service-error.js";

const DEFINITION_PREFIX = "followup.definition:";
const OCCURRENCE_PREFIX = "followup.occurrence:";
const TERMINAL_ATTEMPT_STATES: ReadonlySet<string> = new Set(["completed", "failed", "cancelled", "lost"]);
const ACTIVE_STATUSES: ReadonlySet<FollowUpStatus> = new Set(["waiting", "triggered"]);
const MAX_TIMER_DELAY_MS = 2_147_483_647;

const SERVICE_CAPABILITIES = ["storage.read", "storage.write", "storage.maintenance"];

export interface FollowUpCaller {
  workspaceId: string;
  executionWorkspaceId: string;
  sessionId: string;
  /** Present when the caller's session is bound to a thread; absent on the root session. */
  threadId?: string;
  runId?: string;
  rootSessionId: string;
  workspaceScope?: readonly string[];
  allowedThreadIds: readonly string[];
}

interface PersistedExperimentCaller {
  workspaceId: string;
  executionWorkspaceId: string;
  sessionId: string;
  threadId?: string;
  runId?: string;
  rootSessionId: string;
  workspaceScope?: string[];
  allowedThreadIds: string[];
}

interface DefinitionPayload {
  id: string;
  workspaceId: string;
  sessionId: string;
  /** Thread target when the caller is thread-bound; absent targets the session itself. */
  threadId?: string;
  parent?: ThreadParent;
  runId?: string;
  instruction: string;
  source: FollowUpSource;
  /** Original research authority used for every attempt read, including restart recovery. */
  experimentCaller: PersistedExperimentCaller;
  pauseRequested: boolean;
  pausedGoal: boolean;
  /** Goal id captured when pause was applied — resume only touches that goal. */
  pausedGoalId?: string;
  waitingSummary: string;
  createdAt: number;
  updatedAt: number;
  lastOccurrence?: { id: string; reason: string; at: number; delivered: boolean };
}

interface OccurrencePayload {
  id: string;
  followUpId: string;
  reason: string;
  facts: Record<string, JsonValue>;
  /** Set after the delivery attempt resolves. */
  delivery?: FollowUpOccurrenceDelivery;
  runId?: string;
  at: number;
}

export interface FollowUpServiceDeps {
  client: KernelClient;
  /** Look up a thread + parent for delivery decisions. */
  getThread(workspaceId: string, threadId: string): Promise<{
    id: string;
    lifecycle: string;
    parent: ThreadParent;
    activeRunId: string | null;
  } | null>;
  /** Active run worker state for delivery routing. */
  getActiveRun(workspaceId: string, threadId: string): Promise<{ id: string; workerState: string; sessionId?: string | null } | null>;
  /** Resume a settled thread through the normal admission path. */
  continueRun(input: {
    workspaceId: string;
    parent: ThreadParent;
    threadId: string;
    mode: "continue";
    task: string;
    requestId: string;
    from: { kind: "thread"; id: string };
  }): Promise<{ runId?: string }>;
  /** Park a continuation behind the budget for a queued thread. */
  enqueueContinuation(workspaceId: string, threadId: string, continuation: {
    mode: "continue";
    task: string;
    requestId: string;
    from: { kind: "thread"; id: string };
    at: string;
  }): Promise<unknown>;
  /** Passive inform into a live session (lands in the next model request). */
  notifySession(sessionId: string, text: string, messageId: string): Promise<void>;
  /** Session-level idempotent execution request (native receipt dedupes). */
  sessionRequest(sessionId: string, text: string, messageId: string): Promise<void>;
  /** Whether the session is mid-run — an inform lands in the current turn. */
  sessionBusy(sessionId: string): Promise<boolean>;
  /** Record the inform on the thread ledger for observers/dedupe. */
  recordDirectedMessage(workspaceId: string, message: {
    id: string;
    from: { kind: "thread"; id: string };
    to: { kind: "thread"; id: string };
    kind: "inform";
    text: string;
    status: "delivered" | "held" | "failed";
    runId?: string;
    at: string;
  }): Promise<unknown>;
  /**
   * Presentation wait marker on the thread. `null` clears only a follow-up
   * attention — never a user/permission wait that arrived meanwhile.
   */
  setFollowUpAttention(workspaceId: string, threadId: string, waitingFor: { kind: "followup"; text: string } | null): Promise<unknown>;
  /** Goal feature channel — pause/resume on explicit waits only. */
  requestForSession(sessionId: string, method: "session.features.get" | "session.features.mutate", params: Record<string, unknown>): Promise<unknown>;
  /** Experiment source subscription (durable attempt facts). */
  subscribeAttempts?(listener: (workspaceId: string, attemptId: string, view: ExperimentAttemptView | null) => void): () => void;
  /** Read the current attempt view for registration-time/check evaluation. */
  getAttempt?(caller: PersistedExperimentCaller, attemptId: string): Promise<ExperimentAttemptView | null>;
  onChange?(workspaceId: string): void;
  now?(): number;
  onError?(error: Error): void;
}

const payloadOf = (record: KernelRecordResult): Record<string, unknown> => {
  try {
    const parsed = JSON.parse(record.payloadJson) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const definitionIdFor = (id: string) => `${DEFINITION_PREFIX}${id}`;
const occurrenceIdFor = (id: string) => `${OCCURRENCE_PREFIX}${id}`;

interface FireGuard {
  recordRevision: number;
  sourceIdentity: string;
}

const sourceIdentityFor = (source: FollowUpSource, reason: string): string => {
  if (source.kind === "experiment" && reason === "experiment-terminal") {
    return JSON.stringify({ kind: source.kind, attemptId: source.attemptId, states: source.states ?? null });
  }
  return JSON.stringify(source);
};

const assertOnlyKeys = (value: Record<string, unknown>, allowed: ReadonlySet<string>, label: string) => {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new HarnessServiceError("invalid-params", `${label} has unknown field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`);
  }
};

/** Validate and normalize the untrusted wire value at the service boundary. */
const validateSource = (value: unknown): FollowUpSource => {
  if (!isRecord(value) || typeof value.kind !== "string") {
    throw new HarnessServiceError("invalid-params", "source.kind is required (time | experiment | manual)");
  }
  if (value.kind === "time") {
    assertOnlyKeys(value, new Set(["kind", "at", "timezone"]), "time source");
    if (typeof value.at !== "number" || !Number.isFinite(value.at)) {
      throw new HarnessServiceError("invalid-params", "time source requires a finite `at` (epoch ms)");
    }
    if (value.timezone !== undefined) {
      if (typeof value.timezone !== "string" || value.timezone.trim().length === 0) {
        throw new HarnessServiceError("invalid-params", "time source timezone must be a non-empty IANA name");
      }
      try {
        new Intl.DateTimeFormat("en", { timeZone: value.timezone }).format(0);
      } catch {
        throw new HarnessServiceError("invalid-params", `invalid IANA timezone "${value.timezone}"`);
      }
    }
    return {
      kind: "time",
      at: value.at,
      ...(value.timezone !== undefined ? { timezone: value.timezone.trim() } : {}),
    };
  }
  if (value.kind === "experiment") {
    assertOnlyKeys(value, new Set(["kind", "attemptId", "states", "fallbackAt"]), "experiment source");
    if (typeof value.attemptId !== "string" || value.attemptId.trim().length === 0) {
      throw new HarnessServiceError("invalid-params", "experiment source requires a non-empty attemptId");
    }
    if (value.states !== undefined
      && (!Array.isArray(value.states)
        || value.states.some((state) => typeof state !== "string" || state.trim().length === 0))) {
      throw new HarnessServiceError("invalid-params", "experiment source states must be an array of non-empty strings");
    }
    if (value.fallbackAt !== undefined
      && (typeof value.fallbackAt !== "number" || !Number.isFinite(value.fallbackAt))) {
      throw new HarnessServiceError("invalid-params", "experiment source fallbackAt must be a finite epoch time");
    }
    return {
      kind: "experiment",
      attemptId: value.attemptId.trim(),
      ...(value.states !== undefined ? { states: value.states.map((state) => state.trim()) } : {}),
      ...(value.fallbackAt !== undefined ? { fallbackAt: value.fallbackAt } : {}),
    };
  }
  if (value.kind === "manual") {
    assertOnlyKeys(value, new Set(["kind", "note"]), "manual source");
    if (value.note !== undefined && typeof value.note !== "string") {
      throw new HarnessServiceError("invalid-params", "manual source note must be a string");
    }
    return { kind: "manual", ...(value.note !== undefined ? { note: value.note } : {}) };
  }
  throw new HarnessServiceError("invalid-params", `unknown source kind "${value.kind}"`);
};

const summarizeSource = (source: FollowUpSource): string => {
  switch (source.kind) {
    case "time":
      return `at ${new Date(source.at).toISOString()}${source.timezone ? ` (${source.timezone})` : ""}`;
    case "experiment":
      return `experiment attempt ${source.attemptId} to reach ${(source.states ?? [...TERMINAL_ATTEMPT_STATES]).join("/")}`
        + (source.fallbackAt ? `; fallback check at ${new Date(source.fallbackAt).toISOString()}` : "");
    case "manual":
      return source.note ?? "explicit trigger only";
  }
};

export function createFollowUpService(deps: FollowUpServiceDeps) {
  const now = () => deps.now?.() ?? Date.now();
  const reportError = (error: unknown) => {
    try {
      deps.onError?.(error instanceof Error ? error : new Error(String(error)));
    } catch {
      // Observer failures must not break the service.
    }
  };

  /** Serializes per-definition mutations (CAS chains) within this host. */
  const operations = new Map<string, Promise<unknown>>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** attemptId -> Set<followUpId> for experiment-source waits. */
  const attemptWaits = new Map<string, Set<string>>();
  const recordScopeByWorkspace = new Map<string, Promise<{ scoped: KernelScopedClient }>>();

  const recordScope = (workspaceId: string) => {
    let pending = recordScopeByWorkspace.get(workspaceId);
    if (!pending) {
      pending = (async () => {
        const grant = await deps.client.issueGrant({
          grantId: `followup:${randomUUID()}`,
          capabilities: [...SERVICE_CAPABILITIES],
          owningWorkspace: workspaceId,
          executionWorkspace: workspaceId,
          pathScopes: [""],
        });
        return { scoped: deps.client.scoped(grant) };
      })();
      pending.catch(() => recordScopeByWorkspace.delete(workspaceId));
      recordScopeByWorkspace.set(workspaceId, pending);
    }
    return pending;
  };

  const withDefinition = <T>(id: string, task: () => Promise<T>): Promise<T> => {
    const prior = operations.get(id) ?? Promise.resolve();
    const next = prior.then(task, task);
    operations.set(id, next.catch(() => {}));
    const cleanup = () => {
      if (operations.get(id) === next) operations.delete(id);
    };
    void next.then(cleanup, cleanup);
    return next;
  };

  const getDefinitionRecord = async (workspaceId: string, id: string): Promise<KernelRecordResult | null> => {
    const { scoped } = await recordScope(workspaceId);
    return scoped.getRecord(workspaceId, definitionIdFor(id)).catch(() => null);
  };

  const putDefinition = async (
    workspaceId: string,
    payload: DefinitionPayload,
    state: FollowUpStatus,
    expectedRecordRevision?: number,
  ): Promise<KernelRecordResult> => {
    const { scoped } = await recordScope(workspaceId);
    return scoped.putRecord({
      operationId: `followup.definition:${randomUUID()}`,
      recordId: definitionIdFor(payload.id),
      recordType: "followup.definition",
      workspaceId,
      state,
      sessionId: payload.sessionId,
      ...(payload.threadId ? { threadId: payload.threadId } : {}),
      ...(payload.runId ? { runId: payload.runId } : {}),
      ...(expectedRecordRevision !== undefined ? { expectedRecordRevision } : {}),
      payloadJson: JSON.stringify(payload),
      ownerIds: [],
      references: [],
    });
  };

  const putOccurrence = async (
    workspaceId: string,
    payload: OccurrencePayload,
    state: "recorded" | "delivering" | "delivered" | "held" | "dropped",
    expectedRecordRevision?: number,
  ): Promise<KernelRecordResult> => {
    const { scoped } = await recordScope(workspaceId);
    return scoped.putRecord({
      operationId: `followup.occurrence:${randomUUID()}`,
      recordId: occurrenceIdFor(payload.id),
      recordType: "followup.occurrence",
      workspaceId,
      state,
      payloadJson: JSON.stringify(payload),
      ownerIds: [],
      references: [],
      ...(expectedRecordRevision !== undefined ? { expectedRecordRevision } : {}),
    });
  };

  const toView = (record: KernelRecordResult): FollowUpDefinitionView => {
    const payload = payloadOf(record) as unknown as DefinitionPayload;
    return {
      id: payload.id,
      workspaceId: payload.workspaceId,
      ...(payload.threadId ? { threadId: payload.threadId } : {}),
      sessionId: payload.sessionId,
      instruction: payload.instruction,
      source: payload.source,
      status: record.state as FollowUpStatus,
      revision: String(record.recordRevision),
      ...(payload.runId ? { runId: payload.runId } : {}),
      pausedGoal: payload.pausedGoal === true,
      createdAt: payload.createdAt,
      updatedAt: payload.updatedAt,
      ...(payload.lastOccurrence ? { lastOccurrence: payload.lastOccurrence } : {}),
      waitingSummary: payload.waitingSummary,
    };
  };

  const occurrenceView = (record: KernelRecordResult): FollowUpOccurrenceView => {
    const payload = payloadOf(record) as unknown as OccurrencePayload;
    return {
      id: payload.id,
      followUpId: payload.followUpId,
      reason: payload.reason,
      facts: payload.facts,
      delivery: payload.delivery ?? "dropped",
      ...(payload.runId ? { runId: payload.runId } : {}),
      at: payload.at,
    };
  };

  const clearTimer = (id: string) => {
    const timer = timers.get(id);
    if (timer) clearTimeout(timer);
    timers.delete(id);
  };

  /** Node clamps larger delays; chain chunks until the authoritative due time. */
  const scheduleAt = (id: string, dueAt: number, callback: () => Promise<unknown>) => {
    const scheduleNext = () => {
      const delay = Math.max(0, Math.min(dueAt - now(), MAX_TIMER_DELAY_MS));
      const timer = setTimeout(() => {
        if (timers.get(id) !== timer) return;
        timers.delete(id);
        if (dueAt > now()) {
          scheduleNext();
          return;
        }
        void callback().catch(reportError);
      }, delay);
      timers.set(id, timer);
    };
    scheduleNext();
  };

  const unwatchAttempt = (attemptId: string, followUpId: string) => {
    const set = attemptWaits.get(attemptId);
    if (!set) return;
    set.delete(followUpId);
    if (set.size === 0) attemptWaits.delete(attemptId);
  };

  /** Arm in-memory observers for a waiting definition (idempotent). */
  const arm = (record: KernelRecordResult) => {
    const payload = payloadOf(record) as unknown as DefinitionPayload;
    const id = payload.id;
    clearTimer(id);
    if (payload.source.kind === "time") {
      const dueAt = payload.source.at;
      scheduleAt(id, dueAt, () => fire(
        payload.workspaceId,
        id,
        "time-due",
        { dueAt },
        `time-${dueAt}`,
        { recordRevision: record.recordRevision, sourceIdentity: sourceIdentityFor(payload.source, "time-due") },
      ));
      return;
    }
    if (payload.source.kind === "experiment") {
      const attemptId = payload.source.attemptId;
      let set = attemptWaits.get(attemptId);
      if (!set) {
        set = new Set();
        attemptWaits.set(attemptId, set);
      }
      set.add(id);
      const fallbackAt = payload.source.fallbackAt;
      if (typeof fallbackAt === "number") {
        scheduleAt(id, fallbackAt, () => fire(
          payload.workspaceId,
          id,
          "deadline",
          { fallbackAt, stillWaiting: true },
          `deadline-${fallbackAt}`,
          { recordRevision: record.recordRevision, sourceIdentity: sourceIdentityFor(payload.source, "deadline") },
        ));
      }
    }
  };

  const disarm = (payload: DefinitionPayload) => {
    clearTimer(payload.id);
    if (payload.source.kind === "experiment") unwatchAttempt(payload.source.attemptId, payload.id);
  };

  const changed = (workspaceId: string) => {
    try {
      deps.onChange?.(workspaceId);
    } catch {
      // SSE fan-out must not break the service.
    }
  };

  const goalPause = async (sessionId: string): Promise<string | undefined> => {
    try {
      const features = await deps.requestForSession(sessionId, "session.features.get", {}) as {
        goal?: { id?: string; status?: string; statusReason?: string };
      };
      const goal = features?.goal;
      const goalId = goal?.id;
      if (!goalId) return undefined;
      if (goal.status === "paused" && goal.statusReason === "waiting") {
        return goalId;
      }
      if (goal.status !== "active") return undefined;
      await deps.requestForSession(sessionId, "session.features.mutate", {
        mutation: { type: "goal.update", goalId, status: "paused", statusReason: "waiting" },
      });
      return goalId;
    } catch (error) {
      reportError(error);
      return undefined;
    }
  };

  const goalResume = async (
    workspaceId: string,
    sessionId: string,
    goalId: string | undefined,
    completedFollowUpId: string,
  ): Promise<boolean> => {
    if (!goalId) return true;
    try {
      const definitions = await listDefinitions(workspaceId);
      const stillWaiting = definitions.some((record) => {
        if (!ACTIVE_STATUSES.has(record.state as FollowUpStatus)) return false;
        const candidate = payloadOf(record) as unknown as DefinitionPayload;
        return candidate.id !== completedFollowUpId
          && candidate.sessionId === sessionId
          && (candidate.pausedGoalId === goalId
            || (candidate.pauseRequested === true && !candidate.pausedGoalId));
      });
      if (stillWaiting) return true;
      const features = await deps.requestForSession(sessionId, "session.features.get", {}) as {
        goal?: { id?: string; status?: string; statusReason?: string };
      };
      // Only resume a goal this registration paused (waiting reason) — never
      // resurrect a goal the user paused or that settled meanwhile.
      if (features?.goal?.id !== goalId || features.goal.status !== "paused"
        || features.goal.statusReason !== "waiting") {
        return true;
      }
      await deps.requestForSession(sessionId, "session.features.mutate", {
        mutation: { type: "goal.update", goalId, status: "active", statusReason: "resumed" },
      });
      return true;
    } catch (error) {
      reportError(error);
      return false;
    }
  };

  /**
   * Deliver one recorded occurrence through the real lifecycle:
   * active run → passive inform; settled → continueRun; queued → parked
   * continuation; gone → dropped. Never starts a parallel run on an active
   * thread — the admission layer is the arbiter.
   */
  const deliver = async (
    workspaceId: string,
    definition: DefinitionPayload,
    occurrence: OccurrencePayload,
  ): Promise<{ delivery: FollowUpOccurrenceDelivery; runId?: string }> => {
    const factsText = Object.entries(occurrence.facts)
      .map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`)
      .join("; ");
    const task = [
      `[follow-up ${occurrence.reason}] ${definition.instruction}`,
      factsText ? `Observed: ${factsText}` : "",
      "Logs and artifacts stay on demand — read them via the experiment/thread tools if needed.",
    ].filter(Boolean).join("\n");
    if (!definition.threadId) {
      // Root-session target: no thread lifecycle — the session itself is the
      // continuation. Busy gets a passive inform; idle gets the idempotent
      // execution request (its native receipt dedupes restart replays).
      if (await deps.sessionBusy(definition.sessionId).catch(() => false)) {
        try {
          await deps.notifySession(definition.sessionId, task, occurrence.id);
        } catch (error) {
          if (await deps.sessionBusy(definition.sessionId).catch(() => true)) throw error;
          await deps.sessionRequest(definition.sessionId, task, occurrence.id);
          return { delivery: "continued" as const };
        }
        // The run can settle between the busy snapshot and notification. The
        // shared message identity makes the idle request a safe handoff when it
        // no longer has a live request to receive the inform.
        if (await deps.sessionBusy(definition.sessionId).catch(() => true)) {
          return { delivery: "active-inform" as const };
        }
        await deps.sessionRequest(definition.sessionId, task, occurrence.id);
        return { delivery: "continued" as const };
      }
      await deps.sessionRequest(definition.sessionId, task, occurrence.id);
      return { delivery: "continued" as const };
    }
    const isLive = (run: { id: string; workerState: string; sessionId?: string | null } | null): run is { id: string; workerState: string; sessionId?: string | null } =>
      run !== null && (run.workerState === "starting" || run.workerState === "running");
    // Snapshot/notify races are resolved against live admission. Repeated
    // notifications use one message id, while continueRun uses one request id;
    // both downstream paths are idempotent for this occurrence.
    while (true) {
      const thread = await deps.getThread(workspaceId, definition.threadId).catch(() => null);
      if (!thread || thread.lifecycle === "archived") {
        return { delivery: "dropped" as const };
      }
      if (thread.lifecycle === "queued") {
        await deps.enqueueContinuation(workspaceId, definition.threadId, {
          mode: "continue",
          task,
          requestId: occurrenceIdFor(occurrence.id),
          from: { kind: "thread", id: definition.threadId },
          at: new Date(now()).toISOString(),
        });
        return { delivery: "parked" };
      }
      const activeRun = await deps.getActiveRun(workspaceId, definition.threadId).catch(() => null);
      if (isLive(activeRun)) {
        const activeSessionId = activeRun.sessionId || definition.sessionId;
        try {
          await deps.notifySession(activeSessionId, task, occurrence.id);
        } catch (error) {
          const afterFailure = await deps.getActiveRun(workspaceId, definition.threadId).catch(() => null);
          if (isLive(afterFailure) && afterFailure.id === activeRun.id) throw error;
          continue;
        }
        const afterNotify = await deps.getActiveRun(workspaceId, definition.threadId).catch(() => null);
        if (!isLive(afterNotify) || afterNotify.id !== activeRun.id) {
          continue;
        }
        await deps.recordDirectedMessage(workspaceId, {
          id: occurrence.id,
          from: { kind: "thread", id: definition.threadId },
          to: { kind: "thread", id: definition.threadId },
          kind: "inform",
          text: task,
          status: "delivered",
          runId: activeRun.id,
          at: new Date(now()).toISOString(),
        });
        return { delivery: "active-inform" };
      }
      try {
        const result = await deps.continueRun({
          workspaceId,
          parent: definition.parent ?? { kind: "session", id: definition.sessionId },
          threadId: definition.threadId,
          mode: "continue",
          task,
          requestId: occurrenceIdFor(occurrence.id),
          from: { kind: "thread", id: definition.threadId },
        });
        return result.runId
          ? { delivery: "continued", runId: result.runId }
          : { delivery: "parked" };
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code === "conflict") {
          continue;
        }
        throw error;
      }
    }
  };

  const syncFollowUpAttention = async (workspaceId: string, threadId: string): Promise<void> => {
    const definitions = await listDefinitions(workspaceId);
    const remaining = definitions
      .filter((record) => ACTIVE_STATUSES.has(record.state as FollowUpStatus))
      .map((record) => payloadOf(record) as unknown as DefinitionPayload)
      .find((candidate) => candidate.threadId === threadId && candidate.pauseRequested === true);
    await deps.setFollowUpAttention(
      workspaceId,
      threadId,
      remaining ? { kind: "followup", text: remaining.waitingSummary } : null,
    );
  };

  /** Deliver an already-recorded occurrence and settle both records with CAS. */
  const deliverRecordedOccurrence = async (
    workspaceId: string,
    followUpId: string,
    occurrenceRecord: KernelRecordResult,
  ): Promise<boolean> => {
    const occurrence = payloadOf(occurrenceRecord) as unknown as OccurrencePayload;
    let outcome: { delivery: FollowUpOccurrenceDelivery; runId?: string } | null = null;
    if (occurrenceRecord.state === "delivered" || occurrenceRecord.state === "dropped") {
      outcome = { delivery: occurrence.delivery ?? "dropped", ...(occurrence.runId ? { runId: occurrence.runId } : {}) };
    } else {
      const definitionRecord = await getDefinitionRecord(workspaceId, followUpId);
      if (!definitionRecord) return false;
      const definition = payloadOf(definitionRecord) as unknown as DefinitionPayload;
      try {
        outcome = await deliver(workspaceId, definition, occurrence);
      } catch (error) {
        reportError(error);
        return false;
      }
      try {
        occurrenceRecord = await putOccurrence(
          workspaceId,
          { ...occurrence, delivery: outcome.delivery, ...(outcome.runId ? { runId: outcome.runId } : {}) },
          outcome.delivery === "dropped" ? "dropped" : "delivered",
          occurrenceRecord.recordRevision,
        );
      } catch (error) {
        const { scoped } = await recordScope(workspaceId);
        const current = await scoped.getRecord(workspaceId, occurrenceIdFor(occurrence.id)).catch(() => null);
        if (!current || (current.state !== "delivered" && current.state !== "dropped")) throw error;
        occurrenceRecord = current;
        const currentPayload = payloadOf(current) as unknown as OccurrencePayload;
        outcome = {
          delivery: currentPayload.delivery ?? "dropped",
          ...(currentPayload.runId ? { runId: currentPayload.runId } : {}),
        };
      }
    }

    const latest = await getDefinitionRecord(workspaceId, followUpId);
    if (!latest) return true;
    const latestPayload = payloadOf(latest) as unknown as DefinitionPayload;
    // A later mutation owns the definition; never overwrite its occurrence.
    if (latestPayload.lastOccurrence?.id !== occurrence.id) return true;
    const delivered = outcome.delivery !== "dropped";
    const nextState: FollowUpStatus = outcome.delivery === "dropped"
      ? "unavailable"
      : occurrence.reason === "deadline" ? "waiting" : "delivered";
    const nextPayload: DefinitionPayload = {
      ...latestPayload,
      updatedAt: now(),
      lastOccurrence: {
        id: occurrence.id,
        reason: occurrence.reason,
        at: occurrence.at,
        delivered,
      },
    };
    await putDefinition(workspaceId, nextPayload, nextState, latest.recordRevision);
    if (nextState !== "waiting") {
      disarm(latestPayload);
      if (latestPayload.threadId) {
        await syncFollowUpAttention(workspaceId, latestPayload.threadId).catch(reportError);
      }
      await goalResume(workspaceId, latestPayload.sessionId, latestPayload.pausedGoalId, followUpId);
    }
    changed(workspaceId);
    return true;
  };

  /**
   * Fire an occurrence for a definition: record durably first (idempotent by
   * occurrence id), advance the definition, then deliver. Replays after a lost
   * response or restart observe the durable records instead of duplicating.
   */
  const fire = async (
    workspaceId: string,
    followUpId: string,
    reason: string,
    facts: Record<string, JsonValue>,
    dedupeKey?: string,
    guard?: FireGuard,
  ): Promise<boolean> => withDefinition(followUpId, async () => {
      const record = await getDefinitionRecord(workspaceId, followUpId);
      if (!record) return false;
      const payload = payloadOf(record) as unknown as DefinitionPayload;
      const status = record.state as FollowUpStatus;
      if (status !== "waiting") return false; // cancelled/superseded/delivered — late callbacks cannot revive
      if (guard) {
        const sameRevision = record.recordRevision === guard.recordRevision;
        const sameSource = sourceIdentityFor(payload.source, reason) === guard.sourceIdentity;
        const consumedDeadlineOnly = reason === "experiment-terminal"
          && payload.lastOccurrence?.reason === "deadline"
          && sameSource;
        if (!sameSource || (!sameRevision && !consumedDeadlineOnly)) return false;
      }
      const occurrenceId = `occ-${followUpId}-${reason}-${dedupeKey ?? now()}`;
      const occurrence: OccurrencePayload = {
        id: occurrenceId,
        followUpId,
        reason,
        facts,
        at: now(),
      };
      let occurrenceRecord: KernelRecordResult;
      try {
        occurrenceRecord = await putOccurrence(workspaceId, occurrence, "recorded");
      } catch (error) {
        const code = (error as { code?: string }).code ?? "";
        if (code.includes("conflict") || code.includes("idempotent") || code.includes("revision")) {
          // Same occurrence already recorded — recover it and continue delivery.
          const { scoped } = await recordScope(workspaceId);
          const existing = await scoped.getRecord(workspaceId, occurrenceIdFor(occurrenceId)).catch(() => null);
          if (!existing) throw error;
          occurrenceRecord = existing;
        } else {
          throw error;
        }
      }
      if (reason === "deadline" && payload.source.kind === "experiment") {
        // Backstop fires once; the terminal wait survives — clear fallbackAt so
        // a reconcile does not re-arm the consumed deadline.
        const next = { ...payload, source: { ...payload.source }, updatedAt: now() };
        delete (next.source as { fallbackAt?: number }).fallbackAt;
        const nextPayload: DefinitionPayload = { ...next, lastOccurrence: { id: occurrenceId, reason, at: now(), delivered: false } };
        await putDefinition(workspaceId, nextPayload, "waiting", record.recordRevision);
        clearTimer(followUpId);
      } else {
        const nextPayload: DefinitionPayload = {
          ...payload,
          updatedAt: now(),
          lastOccurrence: { id: occurrenceId, reason, at: now(), delivered: false },
        };
        await putDefinition(workspaceId, nextPayload, "triggered", record.recordRevision);
        disarm(payload);
      }
      changed(workspaceId);
      await deliverRecordedOccurrence(workspaceId, followUpId, occurrenceRecord);
      return true;
    });

  async function listDefinitions(workspaceId: string): Promise<KernelRecordResult[]> {
    const { scoped } = await recordScope(workspaceId);
    const records: KernelRecordResult[] = [];
    let cursor: number | undefined;
    do {
      const page = await scoped.listRecords({
        workspaceId, recordType: "followup.definition", pageSize: 128,
        ...(cursor === undefined ? {} : { cursor }),
      });
      records.push(...page.records);
      cursor = page.nextCursor === null ? undefined : page.nextCursor;
    } while (cursor !== undefined);
    return records;
  }

  const persistedExperimentCaller = (caller: FollowUpCaller): PersistedExperimentCaller => ({
    workspaceId: caller.workspaceId,
    executionWorkspaceId: caller.executionWorkspaceId,
    sessionId: caller.sessionId,
    ...(caller.threadId ? { threadId: caller.threadId } : {}),
    ...(caller.runId ? { runId: caller.runId } : {}),
    rootSessionId: caller.rootSessionId,
    ...(caller.workspaceScope ? { workspaceScope: [...caller.workspaceScope] } : {}),
    allowedThreadIds: [...caller.allowedThreadIds],
  });

  const markUnavailable = async (workspaceId: string, followUpId: string): Promise<void> => {
    await withDefinition(followUpId, async () => {
      const record = await getDefinitionRecord(workspaceId, followUpId);
      if (!record || !ACTIVE_STATUSES.has(record.state as FollowUpStatus)) return;
      const payload = payloadOf(record) as unknown as DefinitionPayload;
      disarm(payload);
      await putDefinition(workspaceId, { ...payload, updatedAt: now() }, "unavailable", record.recordRevision);
      if (payload.threadId) await syncFollowUpAttention(workspaceId, payload.threadId).catch(reportError);
      await goalResume(workspaceId, payload.sessionId, payload.pausedGoalId, followUpId);
      changed(workspaceId);
    });
  };

  const claimRequestedPause = async (
    workspaceId: string,
    followUpId: string,
  ): Promise<KernelRecordResult | null> => withDefinition(followUpId, async () => {
    const record = await getDefinitionRecord(workspaceId, followUpId);
    if (!record || !ACTIVE_STATUSES.has(record.state as FollowUpStatus)) return record;
    const payload = payloadOf(record) as unknown as DefinitionPayload;
    if (payload.pauseRequested !== true || payload.pausedGoalId) return record;
    const pausedGoalId = await goalPause(payload.sessionId);
    if (!pausedGoalId) return record;
    return putDefinition(workspaceId, {
      ...payload,
      pausedGoal: true,
      pausedGoalId,
      updatedAt: now(),
    }, record.state as FollowUpStatus, record.recordRevision);
  });

  const assertLatestOccurrenceSettled = async (workspaceId: string, followUpId: string): Promise<void> => {
    const current = await getDefinitionRecord(workspaceId, followUpId);
    if (!current) return;
    const payload = payloadOf(current) as unknown as DefinitionPayload;
    if (ACTIVE_STATUSES.has(current.state as FollowUpStatus) && payload.lastOccurrence?.delivered === false) {
      throw new Error(`follow-up occurrence delivery remains pending: ${payload.lastOccurrence.id}`);
    }
  };

  const register = async (
    caller: FollowUpCaller,
    params: FollowUpRegisterParams,
  ): Promise<FollowUpRegisterResult> => {
    const instruction = params.instruction?.trim();
    if (!instruction) {
      throw new HarnessServiceError("invalid-params", "instruction is required — what should happen when the source fires");
    }
    const source = validateSource(params.source);
    const thread = caller.threadId
      ? await deps.getThread(caller.workspaceId, caller.threadId).catch(() => null)
      : null;
    const parent: ThreadParent | undefined = caller.threadId
      ? (thread?.parent ?? { kind: "session", id: caller.sessionId })
      : undefined;
    const id = `fu-${randomUUID()}`;
    let payload: DefinitionPayload = {
      id,
      workspaceId: caller.workspaceId,
      sessionId: caller.sessionId,
      ...(caller.threadId ? { threadId: caller.threadId } : {}),
      ...(parent ? { parent } : {}),
      ...(caller.runId ? { runId: caller.runId } : {}),
      instruction,
      source,
      experimentCaller: persistedExperimentCaller(caller),
      pauseRequested: params.pause === true,
      pausedGoal: false,
      waitingSummary: `Waiting for ${summarizeSource(source)}`,
      createdAt: now(),
      updatedAt: now(),
    };
    // Persist pause intent before mutating the session goal. If the Host dies in
    // the next window, reconcile can safely complete and claim the pause.
    let record = await putDefinition(caller.workspaceId, payload, "waiting");
    if (params.pause === true) {
      const pausedGoalId = await goalPause(caller.sessionId);
      if (pausedGoalId) {
        payload = { ...payload, pausedGoal: true, pausedGoalId, updatedAt: now() };
        record = await putDefinition(caller.workspaceId, payload, "waiting", record.recordRevision);
      }
    }
    if (params.pause === true && caller.threadId) {
      await syncFollowUpAttention(caller.workspaceId, caller.threadId).catch(reportError);
    }

    // Install the durable observer before reading the attempt snapshot. An event
    // in the registration interval queues the same per-definition operation and
    // is drained below before the result is returned.
    let firedImmediately = false;
    if (source.kind === "time") {
      if (source.at <= now()) {
        firedImmediately = await fire(caller.workspaceId, id, "time-due", { dueAt: source.at, atRegistration: true }, `time-${source.at}`, {
          recordRevision: record.recordRevision,
          sourceIdentity: sourceIdentityFor(source, "time-due"),
        });
      } else {
        arm(record);
      }
    } else if (source.kind === "experiment") {
      arm(record);
      if (!deps.getAttempt) {
        await markUnavailable(caller.workspaceId, id);
      } else {
        let attempt: ExperimentAttemptView | null | undefined;
        try {
          attempt = await deps.getAttempt(payload.experimentCaller, source.attemptId);
        } catch (error) {
          // A transient read failure leaves the durable observer armed.
          reportError(error);
        }
        if (attempt === null) {
          await markUnavailable(caller.workspaceId, id);
        } else if (attempt !== undefined) {
          const states = new Set(source.states ?? [...TERMINAL_ATTEMPT_STATES]);
          if (states.has(attempt.state)) {
            firedImmediately = await fire(caller.workspaceId, id, "experiment-terminal", {
              attemptId: source.attemptId,
              state: attempt.state,
              ...(attempt.exitCode !== undefined ? { exitCode: attempt.exitCode } : {}),
              atRegistration: true,
            } as Record<string, JsonValue>, `terminal-${source.attemptId}-${attempt.state}`, {
              recordRevision: record.recordRevision,
              sourceIdentity: sourceIdentityFor(source, "experiment-terminal"),
            });
          } else if (source.fallbackAt !== undefined && source.fallbackAt <= now()) {
            firedImmediately = await fire(caller.workspaceId, id, "deadline", {
              fallbackAt: source.fallbackAt,
              stillWaiting: true,
              atRegistration: true,
            }, `deadline-${source.fallbackAt}`, {
              recordRevision: record.recordRevision,
              sourceIdentity: sourceIdentityFor(source, "deadline"),
            });
          }
        }
      }
      await withDefinition(id, async () => {});
    } else {
      arm(record);
    }
    changed(caller.workspaceId);
    const finalRecord = await getDefinitionRecord(caller.workspaceId, id);
    if (finalRecord && (payloadOf(finalRecord) as unknown as DefinitionPayload).lastOccurrence) {
      firedImmediately = true;
    }
    return {
      followUp: toView(finalRecord ?? record),
      firedImmediately,
    };
  };

  const requireDefinition = async (caller: FollowUpCaller, id: string) => {
    const record = await getDefinitionRecord(caller.workspaceId, id);
    if (!record) {
      throw new HarnessServiceError("not-found", `unknown follow-up "${id}"`);
    }
    const payload = payloadOf(record) as unknown as DefinitionPayload;
    const ownsTarget = payload.threadId !== undefined
      ? caller.threadId === payload.threadId
      : caller.sessionId === payload.sessionId;
    if (payload.workspaceId !== caller.workspaceId || !ownsTarget) {
      throw new HarnessServiceError("not-found", `unknown follow-up "${id}"`);
    }
    return { record, payload };
  };

  const list = async (caller: FollowUpCaller, params: FollowUpListParams): Promise<FollowUpListResult> => {
    // Also covers an ad-hoc root workspace that was not present in the Thread
    // catalog or saved project list during Host startup.
    await reconcile(caller.workspaceId);
    const records = await listDefinitions(caller.workspaceId);
    const views = records
      .map(toView)
      .filter((view) => params.includeInactive === true || ACTIVE_STATUSES.has(view.status))
      .filter((view) => view.threadId !== undefined
        ? caller.threadId === view.threadId
        : caller.sessionId === view.sessionId);
    return { followUps: views.sort((a, b) => a.createdAt - b.createdAt) };
  };

  const get = async (caller: FollowUpCaller, params: FollowUpGetParams): Promise<FollowUpGetResult> => {
    await reconcile(caller.workspaceId);
    const { record } = await requireDefinition(caller, params.id);
    const { scoped } = await recordScope(caller.workspaceId);
    const occurrences: FollowUpOccurrenceView[] = [];
    let cursor: number | undefined;
    do {
      const page = await scoped.listRecords({
        workspaceId: caller.workspaceId, recordType: "followup.occurrence", pageSize: 128,
        ...(cursor === undefined ? {} : { cursor }),
      });
      for (const entry of page.records) {
        const view = occurrenceView(entry);
        if (view.followUpId === params.id) occurrences.push(view);
      }
      cursor = page.nextCursor === null ? undefined : page.nextCursor;
    } while (cursor !== undefined);
    return { followUp: toView(record), occurrences };
  };

  const update = async (caller: FollowUpCaller, params: FollowUpUpdateParams): Promise<FollowUpUpdateResult> => {
    let instruction: string | undefined;
    if (params.instruction !== undefined) {
      if (typeof params.instruction !== "string" || params.instruction.trim().length === 0) {
        throw new HarnessServiceError("invalid-params", "instruction must be a non-empty string");
      }
      instruction = params.instruction.trim();
    }
    const source = params.source !== undefined ? validateSource(params.source) : undefined;
    const result = await withDefinition(params.id, async () => {
      const { record, payload } = await requireDefinition(caller, params.id);
      const status = record.state as FollowUpStatus;
      if (!ACTIVE_STATUSES.has(status)) {
        throw new HarnessServiceError("failed", `follow-up "${params.id}" is ${status} and cannot be updated`);
      }
      if (params.expectedRevision !== undefined && params.expectedRevision !== String(record.recordRevision)) {
        throw new HarnessServiceError(
          "failed",
          `revision conflict — re-read and retry (current ${record.recordRevision})`,
        );
      }
      const next: DefinitionPayload = {
        ...payload,
        ...(instruction !== undefined ? { instruction } : {}),
        ...(source !== undefined ? {
          source,
          experimentCaller: persistedExperimentCaller(caller),
        } : {}),
        updatedAt: now(),
        waitingSummary: source !== undefined
          ? `Waiting for ${summarizeSource(source)}`
          : payload.waitingSummary,
      };
      const updated = await putDefinition(caller.workspaceId, next, "waiting", record.recordRevision);
      disarm(payload);
      changed(caller.workspaceId);
      return { updated, next };
    });
    const { updated, next } = result;
    if (next.source.kind === "time" && next.source.at <= now()) {
      await fire(caller.workspaceId, params.id, "time-due", { dueAt: next.source.at, via: "update" }, `time-${next.source.at}`, {
        recordRevision: updated.recordRevision,
        sourceIdentity: sourceIdentityFor(next.source, "time-due"),
      });
    } else if (next.source.kind === "experiment") {
      arm(updated);
      if (!deps.getAttempt) {
        await markUnavailable(caller.workspaceId, params.id);
      } else {
        let attempt: ExperimentAttemptView | null;
        try {
          attempt = await deps.getAttempt(next.experimentCaller, next.source.attemptId);
        } catch (error) {
          reportError(error);
          const current = await getDefinitionRecord(caller.workspaceId, params.id);
          return { followUp: toView(current ?? updated) };
        }
        if (attempt === null) {
          await markUnavailable(caller.workspaceId, params.id);
        } else {
          const states = new Set(next.source.states ?? [...TERMINAL_ATTEMPT_STATES]);
          if (states.has(attempt.state)) {
            await fire(caller.workspaceId, params.id, "experiment-terminal", {
              attemptId: next.source.attemptId,
              state: attempt.state,
              ...(attempt.exitCode !== undefined ? { exitCode: attempt.exitCode } : {}),
              via: "update",
            }, `terminal-${next.source.attemptId}-${attempt.state}`, {
              recordRevision: updated.recordRevision,
              sourceIdentity: sourceIdentityFor(next.source, "experiment-terminal"),
            });
          } else if (next.source.fallbackAt !== undefined && next.source.fallbackAt <= now()) {
            await fire(caller.workspaceId, params.id, "deadline", {
              fallbackAt: next.source.fallbackAt,
              stillWaiting: true,
              via: "update",
            }, `deadline-${next.source.fallbackAt}`, {
              recordRevision: updated.recordRevision,
              sourceIdentity: sourceIdentityFor(next.source, "deadline"),
            });
          }
        }
      }
    } else {
      arm(updated);
    }
    const current = await getDefinitionRecord(caller.workspaceId, params.id);
    return { followUp: toView(current ?? updated) };
  };

  const cancel = async (caller: FollowUpCaller, params: FollowUpCancelParams): Promise<FollowUpGetResult> => {
    await withDefinition(params.id, async () => {
      const { record, payload } = await requireDefinition(caller, params.id);
      const status = record.state as FollowUpStatus;
      if (!ACTIVE_STATUSES.has(status)) {
        if (payload.threadId) await syncFollowUpAttention(caller.workspaceId, payload.threadId).catch(reportError);
        await goalResume(caller.workspaceId, payload.sessionId, payload.pausedGoalId, params.id);
        return;
      }
      if (params.expectedRevision !== undefined && params.expectedRevision !== String(record.recordRevision)) {
        throw new HarnessServiceError(
          "failed",
          `revision conflict — re-read and retry (current ${record.recordRevision})`,
        );
      }
      disarm(payload);
      await putDefinition(caller.workspaceId, { ...payload, updatedAt: now() }, "cancelled", record.recordRevision);
      if (payload.threadId) {
        await syncFollowUpAttention(caller.workspaceId, payload.threadId).catch(reportError);
      }
      await goalResume(caller.workspaceId, payload.sessionId, payload.pausedGoalId, params.id);
      changed(caller.workspaceId);
    });
    return get(caller, { id: params.id });
  };

  /** Program-side evaluation of the source — "check now", never a model call. */
  const evaluate = async (
    caller: FollowUpCaller,
    id: string,
  ): Promise<{ satisfied: boolean; unavailable?: boolean; reason?: string; facts: Record<string, JsonValue>; guard?: FireGuard }> => {
    const { record } = await requireDefinition(caller, id);
    const payload = payloadOf(record) as unknown as DefinitionPayload;
    if (record.state !== "waiting") {
      return { satisfied: false, facts: { status: record.state } };
    }
    const source = payload.source;
    if (source.kind === "time") {
      const due = source.at <= now();
      return {
        satisfied: due,
        reason: "time-due",
        facts: { dueAt: source.at, now: now(), due },
        guard: { recordRevision: record.recordRevision, sourceIdentity: sourceIdentityFor(source, "time-due") },
      };
    }
    if (source.kind === "experiment") {
      const attempt = deps.getAttempt
        ? await deps.getAttempt(payload.experimentCaller, source.attemptId)
        : null;
      if (attempt === null) {
        return { satisfied: false, unavailable: true, facts: { attemptId: source.attemptId, observed: "unavailable" } };
      }
      const states = new Set(source.states ?? [...TERMINAL_ATTEMPT_STATES]);
      const satisfied = states.has(attempt.state);
      return {
        satisfied,
        reason: "experiment-terminal",
        guard: { recordRevision: record.recordRevision, sourceIdentity: sourceIdentityFor(source, "experiment-terminal") },
        facts: {
          attemptId: source.attemptId,
          state: attempt.state,
          ...(attempt.exitCode !== undefined ? { exitCode: attempt.exitCode } : {}),
        },
      };
    }
    return { satisfied: false, facts: { kind: source.kind, note: "no program-evaluable condition" } };
  };

  const check = async (caller: FollowUpCaller, params: FollowUpCheckParams): Promise<FollowUpCheckResult> => {
    const outcome = await evaluate(caller, params.id);
    let fired = false;
    if (outcome.unavailable) {
      await markUnavailable(caller.workspaceId, params.id);
    } else if (outcome.satisfied && outcome.reason) {
      const dedupeKey = outcome.reason === "time-due"
        ? `time-${String(outcome.facts.dueAt)}`
        : undefined;
      fired = await fire(
        caller.workspaceId,
        params.id,
        outcome.reason,
        { ...outcome.facts, via: "check" },
        dedupeKey,
        outcome.guard,
      );
    }
    const { record } = await requireDefinition(caller, params.id);
    return {
      followUp: toView(record),
      fired,
      observed: outcome.facts,
    };
  };

  /** Explicit invoke — "let the agent take over now", not a program check. */
  const fireNow = async (caller: FollowUpCaller, params: FollowUpFireParams): Promise<FollowUpGetResult> => {
    const { record } = await requireDefinition(caller, params.id);
    if (params.expectedRevision !== undefined && params.expectedRevision !== String(record.recordRevision)) {
      throw new HarnessServiceError(
        "failed",
        `revision conflict — re-read and retry (current ${record.recordRevision})`,
      );
    }
    const reason = params.reason ?? "invoked-now";
    await fire(caller.workspaceId, params.id, reason, { via: "manual" }, `manual-${now()}`, {
      recordRevision: record.recordRevision,
      sourceIdentity: sourceIdentityFor((payloadOf(record) as unknown as DefinitionPayload).source, reason),
    });
    return get(caller, { id: params.id });
  };

  // Experiment attempt changes drive experiment-source waits. A terminal
  // attempt fires its waiters once; the occurrence identity dedupes replays.
  const unsubscribeAttempts = deps.subscribeAttempts?.((workspaceId, attemptId, _view) => {
    const waiting = attemptWaits.get(attemptId);
    if (!waiting) return;
    for (const followUpId of [...waiting]) {
      void (async () => {
        const record = await getDefinitionRecord(workspaceId, followUpId);
        if (!record || record.state !== "waiting") return;
        const payload = payloadOf(record) as unknown as DefinitionPayload;
        if (payload.source.kind !== "experiment" || payload.source.attemptId !== attemptId) return;
        if (!deps.getAttempt) {
          await markUnavailable(workspaceId, followUpId);
          return;
        }
        // Subscription payloads are only wakeups. Re-read through the
        // definition's persisted ExperimentCaller so a Host observer never
        // becomes a maintenance-authority bypass.
        const observed = await deps.getAttempt(payload.experimentCaller, attemptId);
        if (observed === null) {
          await markUnavailable(workspaceId, followUpId);
          return;
        }
        const states = new Set(payload.source.states ?? [...TERMINAL_ATTEMPT_STATES]);
        if (!states.has(observed.state)) return;
        await fire(workspaceId, followUpId, "experiment-terminal", {
          attemptId,
          state: observed.state,
          ...(observed.exitCode !== undefined ? { exitCode: observed.exitCode } : {}),
          ...(observed.endedAt !== undefined && observed.endedAt !== null ? { endedAt: observed.endedAt } : {}),
        } as Record<string, JsonValue>, `terminal-${attemptId}-${observed.state}`, {
          recordRevision: record.recordRevision,
          sourceIdentity: sourceIdentityFor(payload.source, "experiment-terminal"),
        });
      })().catch(reportError);
    }
  });

  const reconciledWorkspaces = new Set<string>();
  const reconcileOperations = new Map<string, Promise<void>>();

  /**
   * Rebuild observers from durable records after a host restart. Overdue time
   * waits fire once (with a delayed-delivery fact); experiment waits re-check
   * the durable attempt view rather than re-subscribing blind. Once per
   * workspace per host lifetime.
   */
  const reconcile = async (workspaceId: string): Promise<void> => {
    if (reconciledWorkspaces.has(workspaceId)) return;
    const existing = reconcileOperations.get(workspaceId);
    if (existing) return existing;
    const operation = (async () => {
      // Do not mark the workspace reconciled until the authoritative list read
      // and every recovery mutation succeeds; callers may retry a failed pass.
      const records = await listDefinitions(workspaceId);
      let sideEffectFailed = false;
      for (const initialRecord of records) {
        let record = initialRecord;
        let payload = payloadOf(record) as unknown as DefinitionPayload;
        let status = record.state as FollowUpStatus;

        if (!ACTIVE_STATUSES.has(status)) {
          disarm(payload);
          if (payload.threadId && payload.pauseRequested === true) {
            try {
              await syncFollowUpAttention(workspaceId, payload.threadId);
            } catch (error) {
              reportError(error);
              sideEffectFailed = true;
            }
          }
          if (!await goalResume(workspaceId, payload.sessionId, payload.pausedGoalId, payload.id)) {
            sideEffectFailed = true;
          }
          continue;
        }

        if (payload.pauseRequested === true && !payload.pausedGoalId) {
          const claimed = await claimRequestedPause(workspaceId, payload.id);
          if (!claimed) continue;
          record = claimed;
          payload = payloadOf(record) as unknown as DefinitionPayload;
          status = record.state as FollowUpStatus;
          if (payload.threadId) await syncFollowUpAttention(workspaceId, payload.threadId);
        }

        if (payload.lastOccurrence && payload.lastOccurrence.delivered === false) {
          // Deadline occurrences keep observing the terminal attempt while their
          // own delivery is recovered.
          if (status === "waiting" && payload.lastOccurrence.reason === "deadline") arm(record);
          const { scoped } = await recordScope(workspaceId);
          const occurrenceRecord = await scoped.getRecord(
            workspaceId,
            occurrenceIdFor(payload.lastOccurrence.id),
          );
          if (!occurrenceRecord) {
            await markUnavailable(workspaceId, payload.id);
            continue;
          }
          const recovered = await withDefinition(payload.id, () => (
            deliverRecordedOccurrence(workspaceId, payload.id, occurrenceRecord)
          ));
          if (!recovered) throw new Error(`follow-up occurrence delivery remains pending: ${payload.lastOccurrence.id}`);
          const refreshed = await getDefinitionRecord(workspaceId, payload.id);
          if (!refreshed) continue;
          record = refreshed;
          payload = payloadOf(record) as unknown as DefinitionPayload;
          status = record.state as FollowUpStatus;
          if (!ACTIVE_STATUSES.has(status)) continue;
          if (payload.lastOccurrence?.delivered === false) {
            throw new Error(`follow-up occurrence did not settle: ${payload.lastOccurrence.id}`);
          }
        }

        if (status === "triggered") {
          // Triggered without an exact pending occurrence cannot be recovered by
          // guessing from workspace history.
          await markUnavailable(workspaceId, payload.id);
          continue;
        }
        if (payload.source.kind === "time") {
          if (payload.source.at <= now()) {
            const fired = await fire(workspaceId, payload.id, "time-due", {
              dueAt: payload.source.at,
              delayedByMs: now() - payload.source.at,
              recoveredAfterRestart: true,
            }, `time-${payload.source.at}`, {
              recordRevision: record.recordRevision,
              sourceIdentity: sourceIdentityFor(payload.source, "time-due"),
            });
            if (fired) await assertLatestOccurrenceSettled(workspaceId, payload.id);
          } else {
            arm(record);
          }
          continue;
        }
        if (payload.source.kind === "experiment") {
          arm(record);
          if (!deps.getAttempt) {
            await markUnavailable(workspaceId, payload.id);
            continue;
          }
          const attempt = await deps.getAttempt(payload.experimentCaller, payload.source.attemptId);
          if (attempt === null) {
            await markUnavailable(workspaceId, payload.id);
            continue;
          }
          const states = new Set(payload.source.states ?? [...TERMINAL_ATTEMPT_STATES]);
          if (states.has(attempt.state)) {
            const fired = await fire(workspaceId, payload.id, "experiment-terminal", {
              attemptId: payload.source.attemptId,
              state: attempt.state,
              recoveredAfterRestart: true,
            }, `terminal-${payload.source.attemptId}-${attempt.state}`, {
              recordRevision: record.recordRevision,
              sourceIdentity: sourceIdentityFor(payload.source, "experiment-terminal"),
            });
            if (fired) await assertLatestOccurrenceSettled(workspaceId, payload.id);
          } else if (payload.source.fallbackAt !== undefined && payload.source.fallbackAt <= now()) {
            const fired = await fire(workspaceId, payload.id, "deadline", {
              fallbackAt: payload.source.fallbackAt,
              stillWaiting: true,
              recoveredAfterRestart: true,
            }, `deadline-${payload.source.fallbackAt}`, {
              recordRevision: record.recordRevision,
              sourceIdentity: sourceIdentityFor(payload.source, "deadline"),
            });
            if (fired) await assertLatestOccurrenceSettled(workspaceId, payload.id);
          }
          continue;
        }
        arm(record);
      }
      if (sideEffectFailed) throw new Error(`follow-up side-effect reconciliation failed for workspace ${workspaceId}`);
      reconciledWorkspaces.add(workspaceId);
    })();
    reconcileOperations.set(workspaceId, operation);
    try {
      await operation;
    } finally {
      if (reconcileOperations.get(workspaceId) === operation) reconcileOperations.delete(workspaceId);
    }
  };

  return {
    register,
    list,
    get,
    update,
    cancel,
    check,
    fire: fireNow,
    reconcile,
    dispose: () => {
      unsubscribeAttempts?.();
      for (const id of [...timers.keys()]) clearTimer(id);
    },
  };
}

export type FollowUpService = ReturnType<typeof createFollowUpService>;
