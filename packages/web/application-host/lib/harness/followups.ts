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
  sessionId: string;
  /** Present when the caller's session is bound to a thread; absent on the root session. */
  threadId?: string;
  runId?: string;
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
  getActiveRun(workspaceId: string, threadId: string): Promise<{ id: string; workerState: string } | null>;
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
  getAttempt?(workspaceId: string, attemptId: string): Promise<ExperimentAttemptView | null>;
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
      const delay = Math.max(0, Math.min(payload.source.at - now(), MAX_TIMER_DELAY_MS));
      timers.set(id, setTimeout(() => {
        void fire(payload.workspaceId, id, "time-due", { dueAt: payload.source.kind === "time" ? payload.source.at : 0 }).catch(reportError);
      }, delay));
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
        const delay = Math.max(0, Math.min(fallbackAt - now(), MAX_TIMER_DELAY_MS));
        timers.set(id, setTimeout(() => {
          void fire(payload.workspaceId, id, "deadline", { fallbackAt, stillWaiting: true }).catch(reportError);
        }, delay));
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
        goal?: { id?: string; status?: string };
      };
      const goalId = features?.goal?.id;
      if (!goalId || features?.goal?.status !== "active") return undefined;
      await deps.requestForSession(sessionId, "session.features.mutate", {
        mutation: { type: "goal.update", goalId, status: "paused", statusReason: "waiting" },
      });
      return goalId;
    } catch (error) {
      reportError(error);
      return undefined;
    }
  };

  const goalResume = async (sessionId: string, goalId: string | undefined): Promise<void> => {
    if (!goalId) return;
    try {
      const features = await deps.requestForSession(sessionId, "session.features.get", {}) as {
        goal?: { id?: string; status?: string; statusReason?: string };
      };
      // Only resume a goal this registration paused (waiting reason) — never
      // resurrect a goal the user paused or that settled meanwhile.
      if (features?.goal?.id !== goalId || features.goal.status !== "paused"
        || features.goal.statusReason !== "waiting") {
        return;
      }
      await deps.requestForSession(sessionId, "session.features.mutate", {
        mutation: { type: "goal.update", goalId, status: "active", statusReason: "resumed" },
      });
    } catch (error) {
      reportError(error);
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
        await deps.notifySession(definition.sessionId, task, occurrence.id);
        return { delivery: "active-inform" as const };
      }
      await deps.sessionRequest(definition.sessionId, task, occurrence.id);
      return { delivery: "continued" as const };
    }
    const thread = await deps.getThread(workspaceId, definition.threadId).catch(() => null);
    if (!thread || thread.lifecycle === "archived") {
      return { delivery: "dropped" as const };
    }
    const activeRun = await deps.getActiveRun(workspaceId, definition.threadId).catch(() => null);
    const runActive = activeRun && (activeRun.workerState === "starting" || activeRun.workerState === "running");
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
    if (runActive) {
      // Same occurrence delivered once to the live session AND the ledger —
      // the message id is the occurrence id so retries dedupe.
      await deps.notifySession(definition.sessionId, task, occurrence.id);
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
    if (thread.lifecycle === "settled" || activeRun?.workerState === "lost") {
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
        // A user message or natural continuation may have won admission between
        // the snapshot and now — merge into the live run instead of forcing a
        // second one.
        const code = (error as { code?: string }).code;
        if (code === "conflict") {
          await deps.notifySession(definition.sessionId, task, occurrence.id);
          await deps.recordDirectedMessage(workspaceId, {
            id: occurrence.id,
            from: { kind: "thread", id: definition.threadId },
            to: { kind: "thread", id: definition.threadId },
            kind: "inform",
            text: task,
            status: "delivered",
            at: new Date(now()).toISOString(),
          });
          return { delivery: "active-inform" };
        }
        throw error;
      }
    }
    return { delivery: "dropped" as const };
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
  ): Promise<void> => {
    await withDefinition(followUpId, async () => {
      const record = await getDefinitionRecord(workspaceId, followUpId);
      if (!record) return;
      const payload = payloadOf(record) as unknown as DefinitionPayload;
      const status = record.state as FollowUpStatus;
      if (status !== "waiting") return; // cancelled/superseded/delivered — late callbacks cannot revive
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
      const occPayload = payloadOf(occurrenceRecord) as unknown as OccurrencePayload;
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
      const outcome: { delivery: FollowUpOccurrenceDelivery; runId?: string } = await deliver(
        workspaceId, payload, occPayload,
      ).catch((error) => {
        reportError(error);
        return { delivery: "dropped" as const };
      });
      const delivered = outcome.delivery !== "dropped";
      await putOccurrence(
        workspaceId,
        { ...occPayload, delivery: outcome.delivery, ...(outcome.runId ? { runId: outcome.runId } : {}) },
        delivered ? "delivered" : "dropped",
        occurrenceRecord.recordRevision,
      ).catch(reportError);
      const refreshed = await getDefinitionRecord(workspaceId, followUpId);
      if (refreshed) {
        const refreshedPayload = payloadOf(refreshed) as unknown as DefinitionPayload;
        const nextPayload: DefinitionPayload = {
          ...refreshedPayload,
          updatedAt: now(),
          lastOccurrence: { id: occurrenceId, reason, at: occPayload.at, delivered },
        };
        const nextState: FollowUpStatus = reason === "deadline"
          ? "waiting"
          : delivered ? "delivered" : "triggered";
        await putDefinition(workspaceId, nextPayload, nextState, refreshed.recordRevision).catch(reportError);
        if (nextState !== "waiting" && refreshedPayload.threadId) {
          await deps.setFollowUpAttention(workspaceId, refreshedPayload.threadId, null).catch(() => {});
        }
        if (nextState !== "waiting") {
          await goalResume(refreshedPayload.sessionId, refreshedPayload.pausedGoalId);
        }
      }
      changed(workspaceId);
    });
  };

  const listDefinitions = async (workspaceId: string): Promise<KernelRecordResult[]> => {
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
  };

  const register = async (
    caller: FollowUpCaller,
    params: FollowUpRegisterParams,
  ): Promise<FollowUpRegisterResult> => {
    const instruction = params.instruction?.trim();
    if (!instruction) {
      throw new HarnessServiceError("invalid-params", "instruction is required — what should happen when the source fires");
    }
    const source = params.source;
    if (!source || !isRecord(source) || typeof source.kind !== "string") {
      throw new HarnessServiceError("invalid-params", "source.kind is required (time | experiment | manual)");
    }
    const thread = caller.threadId
      ? await deps.getThread(caller.workspaceId, caller.threadId).catch(() => null)
      : null;
    const parent: ThreadParent | undefined = caller.threadId
      ? (thread?.parent ?? { kind: "session", id: caller.sessionId })
      : undefined;
    if (source.kind === "time" && (typeof source.at !== "number" || !Number.isFinite(source.at))) {
      throw new HarnessServiceError("invalid-params", "time source requires a finite `at` (epoch ms)");
    }
    if (source.kind === "experiment" && typeof source.attemptId !== "string") {
      throw new HarnessServiceError("invalid-params", "experiment source requires attemptId");
    }
    const id = `fu-${randomUUID()}`;
    let pausedGoalId: string | undefined;
    if (params.pause === true) {
      pausedGoalId = await goalPause(caller.sessionId);
    }
    const payload: DefinitionPayload = {
      id,
      workspaceId: caller.workspaceId,
      sessionId: caller.sessionId,
      ...(caller.threadId ? { threadId: caller.threadId } : {}),
      ...(parent ? { parent } : {}),
      ...(caller.runId ? { runId: caller.runId } : {}),
      instruction,
      source,
      pausedGoal: pausedGoalId !== undefined,
      ...(pausedGoalId ? { pausedGoalId } : {}),
      waitingSummary: `Waiting for ${summarizeSource(source)}`,
      createdAt: now(),
      updatedAt: now(),
    };
    const record = await putDefinition(caller.workspaceId, payload, "waiting");
    // Registration observes the source *before* subscribing so a condition that
    // already held during registration still produces an occurrence (no lost
    // edge between check and subscribe).
    let firedImmediately = false;
    if (source.kind === "experiment" && deps.getAttempt) {
      const attempt = await deps.getAttempt(caller.workspaceId, source.attemptId).catch(() => null);
      if (attempt === null) {
        await putDefinition(caller.workspaceId, { ...payload, updatedAt: now() }, "unavailable", record.recordRevision)
          .catch(reportError);
      } else {
        const states = new Set(source.states ?? [...TERMINAL_ATTEMPT_STATES]);
        if (states.has(attempt.state)) {
          firedImmediately = true;
          void fire(caller.workspaceId, id, "experiment-terminal", {
            attemptId: source.attemptId,
            state: attempt.state,
            ...(attempt.exitCode !== undefined ? { exitCode: attempt.exitCode } : {}),
            atRegistration: true,
          } as Record<string, JsonValue>, `reg-${record.recordRevision}`).catch(reportError);
        }
      }
    }
    if (!firedImmediately) {
      const refreshed = await getDefinitionRecord(caller.workspaceId, id);
      if (refreshed) arm(refreshed);
      if (params.pause === true && caller.threadId) {
        await deps.setFollowUpAttention(caller.workspaceId, caller.threadId, {
          kind: "followup",
          text: payload.waitingSummary,
        }).catch(reportError);
      }
    }
    changed(caller.workspaceId);
    const finalRecord = await getDefinitionRecord(caller.workspaceId, id);
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
    if (payload.workspaceId !== caller.workspaceId) {
      throw new HarnessServiceError("not-found", `unknown follow-up "${id}"`);
    }
    return { record, payload };
  };

  const list = async (caller: FollowUpCaller, params: FollowUpListParams): Promise<FollowUpListResult> => {
    const records = await listDefinitions(caller.workspaceId);
    const views = records
      .map(toView)
      .filter((view) => params.includeInactive === true || ACTIVE_STATUSES.has(view.status))
      .filter((view) => view.sessionId === caller.sessionId
        || (caller.threadId !== undefined && view.threadId === caller.threadId));
    return { followUps: views.sort((a, b) => a.createdAt - b.createdAt) };
  };

  const get = async (caller: FollowUpCaller, params: FollowUpGetParams): Promise<FollowUpGetResult> => {
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
    return withDefinition(params.id, async () => {
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
        ...(params.instruction !== undefined ? { instruction: params.instruction } : {}),
        ...(params.source !== undefined ? { source: params.source } : {}),
        updatedAt: now(),
        waitingSummary: params.source !== undefined
          ? `Waiting for ${summarizeSource(params.source)}`
          : payload.waitingSummary,
      };
      const updated = await putDefinition(caller.workspaceId, next, "waiting", record.recordRevision);
      disarm(payload);
      arm(updated);
      changed(caller.workspaceId);
      return { followUp: toView(updated) };
    });
  };

  const cancel = async (caller: FollowUpCaller, params: FollowUpCancelParams): Promise<FollowUpGetResult> => {
    await withDefinition(params.id, async () => {
      const { record, payload } = await requireDefinition(caller, params.id);
      const status = record.state as FollowUpStatus;
      if (!ACTIVE_STATUSES.has(status)) return;
      if (params.expectedRevision !== undefined && params.expectedRevision !== String(record.recordRevision)) {
        throw new HarnessServiceError(
          "failed",
          `revision conflict — re-read and retry (current ${record.recordRevision})`,
        );
      }
      disarm(payload);
      await putDefinition(caller.workspaceId, { ...payload, updatedAt: now() }, "cancelled", record.recordRevision);
      if (payload.threadId) {
        await deps.setFollowUpAttention(caller.workspaceId, payload.threadId, null).catch(() => {});
      }
      await goalResume(payload.sessionId, payload.pausedGoalId);
      changed(caller.workspaceId);
    });
    return get(caller, { id: params.id });
  };

  /** Program-side evaluation of the source — "check now", never a model call. */
  const evaluate = async (
    caller: FollowUpCaller,
    id: string,
  ): Promise<{ satisfied: boolean; reason?: string; facts: Record<string, JsonValue> }> => {
    const { record } = await requireDefinition(caller, id);
    const payload = payloadOf(record) as unknown as DefinitionPayload;
    if (record.state !== "waiting") {
      return { satisfied: false, facts: { status: record.state } };
    }
    const source = payload.source;
    if (source.kind === "time") {
      const due = source.at <= now();
      return { satisfied: due, reason: "time-due", facts: { dueAt: source.at, now: now(), due } };
    }
    if (source.kind === "experiment") {
      const attempt = deps.getAttempt
        ? await deps.getAttempt(caller.workspaceId, source.attemptId).catch(() => null)
        : null;
      if (attempt === null) {
        return { satisfied: false, facts: { attemptId: source.attemptId, observed: "unavailable" } };
      }
      const states = new Set(source.states ?? [...TERMINAL_ATTEMPT_STATES]);
      const satisfied = states.has(attempt.state);
      return {
        satisfied,
        reason: "experiment-terminal",
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
    if (outcome.satisfied && outcome.reason) {
      await fire(caller.workspaceId, params.id, outcome.reason, { ...outcome.facts, via: "check" });
    }
    const { record } = await requireDefinition(caller, params.id);
    return {
      followUp: toView(record),
      fired: outcome.satisfied,
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
    await fire(caller.workspaceId, params.id, params.reason ?? "invoked-now", { via: "manual" }, `manual-${now()}`);
    return get(caller, { id: params.id });
  };

  // Experiment attempt changes drive experiment-source waits. A terminal
  // attempt fires its waiters once; the occurrence identity dedupes replays.
  const unsubscribeAttempts = deps.subscribeAttempts?.((workspaceId, attemptId, view) => {
    const waiting = attemptWaits.get(attemptId);
    if (!waiting) return;
    if (!view) {
      // The watched attempt record is gone — report honestly instead of
      // waiting forever.
      for (const followUpId of [...waiting]) {
        void withDefinition(followUpId, async () => {
          const record = await getDefinitionRecord(workspaceId, followUpId);
          if (!record || record.state !== "waiting") return;
          const payload = payloadOf(record) as unknown as DefinitionPayload;
          if (payload.source.kind !== "experiment" || payload.source.attemptId !== attemptId) return;
          disarm(payload);
          await putDefinition(workspaceId, { ...payload, updatedAt: now() }, "unavailable", record.recordRevision);
          changed(workspaceId);
        }).catch(reportError);
      }
      return;
    }
    for (const followUpId of [...waiting]) {
      // Not withDefinition here — fire() takes that lock itself and re-reads
      // the durable record, so a stale view can only produce a replayed
      // occurrence id, never a double delivery.
      void (async () => {
        const record = await getDefinitionRecord(workspaceId, followUpId);
        if (!record || record.state !== "waiting") return;
        const payload = payloadOf(record) as unknown as DefinitionPayload;
        if (payload.source.kind !== "experiment" || payload.source.attemptId !== attemptId) return;
        const states = new Set(payload.source.states ?? [...TERMINAL_ATTEMPT_STATES]);
        if (!states.has(view.state)) return;
        await fire(workspaceId, followUpId, "experiment-terminal", {
          attemptId,
          state: view.state,
          ...(view.exitCode !== undefined ? { exitCode: view.exitCode } : {}),
          ...(view.endedAt !== undefined && view.endedAt !== null ? { endedAt: view.endedAt } : {}),
        } as Record<string, JsonValue>, `attempt-${view.state}-${record.recordRevision}`);
      })().catch(reportError);
    }
  });

  const reconciledWorkspaces = new Set<string>();

  /**
   * Rebuild observers from durable records after a host restart. Overdue time
   * waits fire once (with a delayed-delivery fact); experiment waits re-check
   * the durable attempt view rather than re-subscribing blind. Once per
   * workspace per host lifetime.
   */
  const reconcile = async (workspaceId: string): Promise<void> => {
    if (reconciledWorkspaces.has(workspaceId)) return;
    reconciledWorkspaces.add(workspaceId);
    const records = await listDefinitions(workspaceId).catch(() => []);
    for (const record of records) {
      const payload = payloadOf(record) as unknown as DefinitionPayload;
      const status = record.state as FollowUpStatus;
      if (status === "waiting") {
        if (payload.source.kind === "time" && payload.source.at <= now()) {
          void fire(workspaceId, payload.id, "time-due", {
            dueAt: payload.source.at,
            delayedByMs: now() - payload.source.at,
            recoveredAfterRestart: true,
          }, `restart-${payload.source.at}`).catch(reportError);
          continue;
        }
        if (payload.source.kind === "experiment" && deps.getAttempt) {
          const attempt = await deps.getAttempt(workspaceId, payload.source.attemptId).catch(() => null);
          if (attempt === null) {
            await putDefinition(workspaceId, { ...payload, updatedAt: now() }, "unavailable", record.recordRevision)
              .catch(reportError);
            continue;
          }
          const states = new Set(payload.source.states ?? [...TERMINAL_ATTEMPT_STATES]);
          if (states.has(attempt.state)) {
            void fire(workspaceId, payload.id, "experiment-terminal", {
              attemptId: payload.source.attemptId,
              state: attempt.state,
              recoveredAfterRestart: true,
            }, `restart-terminal-${attempt.state}`).catch(reportError);
            continue;
          }
        }
        arm(record);
      } else if (status === "triggered") {
        // Occurrence was recorded but delivery did not complete — redeliver the
        // same occurrence identity (continueRun requestId dedupes downstream).
        const { scoped } = await recordScope(workspaceId);
        const occPage = await scoped.listRecords({
          workspaceId, recordType: "followup.occurrence", pageSize: 128,
        }).catch(() => ({ records: [] as KernelRecordResult[] }));
        const pending = occPage.records
          .map(occurrenceView)
          .filter((occ) => occ.followUpId === payload.id)
          .sort((a, b) => b.at - a.at)[0];
        if (pending) {
          const occPayload: OccurrencePayload = {
            id: pending.id,
            followUpId: pending.followUpId,
            reason: pending.reason,
            facts: pending.facts,
            delivery: pending.delivery,
            ...(pending.runId ? { runId: pending.runId } : {}),
            at: pending.at,
          };
          void deliver(workspaceId, payload, occPayload).then((outcome) => {
            void putOccurrence(workspaceId, { ...occPayload, delivery: outcome.delivery, ...(outcome.runId ? { runId: outcome.runId } : {}) },
              outcome.delivery === "dropped" ? "dropped" : "delivered").catch(reportError);
            return getDefinitionRecord(workspaceId, payload.id);
          }).then((latest) => {
            if (!latest) return;
            const latestPayload = payloadOf(latest) as unknown as DefinitionPayload;
            return putDefinition(workspaceId, { ...latestPayload, updatedAt: now() },
              "delivered", latest.recordRevision).catch(reportError);
          }).catch(reportError);
        }
      }
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
