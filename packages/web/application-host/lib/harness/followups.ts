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
import type { ExperimentArtifactView, ExperimentAttemptView } from "@piarium/protocol";
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
  /**
   * Durable per-source observation state: log byte cursor, metric holding
   * flag, fired artifact ids. Rebuilt-conservative on restart — occurrence
   * identities dedupe any overlap replay.
   */
  sourceState?: {
    logOffset?: number;
    holding?: boolean;
    firedArtifactIds?: string[];
  };
}

interface OccurrencePayload {
  id: string;
  followUpId: string;
  reason: string;
  facts: Record<string, JsonValue>;
  /** Re-arming source — the definition returns to `waiting` after delivery. */
  rearm?: boolean;
  /** Set after the delivery attempt resolves. */
  delivery?: FollowUpOccurrenceDelivery;
  runId?: string;
  at: number;
}

/** Committed `resource.sample` fact observed through the resource service. */
export interface FollowUpResourceSample {
  machineId: string;
  observedAt: number;
  usage: {
    cpuPercent?: number;
    memoryMb?: number;
    gpus?: Array<{ index?: number; utilizationPercent?: number; usedMemoryMb?: number; memoryMb?: number }>;
  };
}

/**
 * Typed, authorized external source. Adapters are registered host-side; the
 * wire only carries a provider id — never a URL, script, or model-authored
 * code. `intervalMs` is the adapter's own capability-based query spacing.
 */
export interface FollowUpExternalSource {
  intervalMs: number;
  query(input: {
    workspaceId: string;
    source: Extract<FollowUpSource, { kind: "external" }>;
  }): Promise<{
    matched: boolean;
    /** True when the provider itself cannot be queried (auth gone, dir gone). */
    unavailable?: boolean;
    /** Stable identity of the matched state — dedupes identical observations. */
    eventId?: string;
    /** Override the next query delay (e.g. rate-limit backoff). */
    retryAfterMs?: number;
    facts: Record<string, JsonValue>;
  }>;
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
  /** Attempt detail incl. collected artifact views (experiment service `get`). */
  getExperiment?(caller: PersistedExperimentCaller, attemptId: string): Promise<{
    attempt: ExperimentAttemptView;
    artifacts: ExperimentArtifactView[];
  } | null>;
  /** Incremental read of an attempt's durable log (experiment service `logs`). */
  readExperimentLog?(caller: PersistedExperimentCaller, params: {
    attemptId: string;
    stream?: "stdout" | "stderr";
    offset?: number;
    maxBytes?: number;
  }): Promise<{ text: string; nextOffset: number; eof: boolean }>;
  /**
   * Workspace watch through the document authority — invalidation events
   * (path, kind, sequence) only; content is re-read via stat, never watched.
   */
  watchWorkspace?(workspaceId: string, listener: (event: {
    kind: string;
    sequence: number;
    generation: number;
    path?: string;
  }) => void): { ready: Promise<boolean>; close(): void } | null;
  /** Stat a workspace-relative path; null → the workspace root is unknown here. */
  statWorkspaceFile?(workspaceId: string, path: string): Promise<{ exists: boolean; size?: number; mtimeMs?: number } | null>;
  /** True while the document authority reports an active writer/capture. */
  workspaceHasActiveWriters?(workspaceId: string): Promise<boolean>;
  /** `resource.sample` commits from the resource service. */
  subscribeResourceSamples?(listener: (sample: FollowUpResourceSample) => void): () => void;
  /** Latest committed usage sample for a machine. */
  getResourceSample?(machineId: string): Promise<FollowUpResourceSample | null>;
  /** Registered external-source adapters by provider id ("github-pr"). */
  externalSource?(provider: string): FollowUpExternalSource | null;
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
  /** Record revision observed when the callback was armed — optional: source identity is the authoritative guard for in-band drains. */
  recordRevision?: number;
  sourceIdentity: string;
}

const sourceIdentityFor = (source: FollowUpSource, reason: string): string => {
  if (source.kind === "experiment" && reason === "experiment-terminal") {
    return JSON.stringify({ kind: source.kind, attemptId: source.attemptId, states: source.states ?? null });
  }
  if (reason !== "deadline" && "fallbackAt" in source) {
    // fallbackAt is a backstop timer facet, not the observed condition — a
    // consumed deadline must not change the source identity and block the
    // real event.
    const { fallbackAt: _ignored, ...rest } = source as Record<string, unknown> & { fallbackAt?: number };
    return JSON.stringify(rest);
  }
  return JSON.stringify(source);
};

const assertOnlyKeys = (value: Record<string, unknown>, allowed: ReadonlySet<string>, label: string) => {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new HarnessServiceError("invalid-params", `${label} has unknown field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`);
  }
};

const optionalEpoch = (value: Record<string, unknown>, key: string, label: string): number | undefined => {
  if (value[key] === undefined) return undefined;
  if (typeof value[key] !== "number" || !Number.isFinite(value[key])) {
    throw new HarnessServiceError("invalid-params", `${label} ${key} must be a finite epoch time`);
  }
  return value[key] as number;
};

const optionalBoolean = (value: Record<string, unknown>, key: string, label: string): boolean | undefined => {
  if (value[key] === undefined) return undefined;
  if (typeof value[key] !== "boolean") {
    throw new HarnessServiceError("invalid-params", `${label} ${key} must be a boolean`);
  }
  return value[key] as boolean;
};

const optionalNonEmptyString = (value: Record<string, unknown>, key: string, label: string): string | undefined => {
  if (value[key] === undefined) return undefined;
  if (typeof value[key] !== "string" || value[key].trim().length === 0) {
    throw new HarnessServiceError("invalid-params", `${label} ${key} must be a non-empty string`);
  }
  return (value[key] as string).trim();
};

/** Workspace-relative watch paths: forward slashes, no escapes. */
const normalizeWatchPath = (raw: string): string => {
  const path = raw.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/^\/+/, "");
  const segments = path.split("/");
  if (path.length === 0 || path.includes("\0") || /^[a-zA-Z]:/.test(path)
    || segments.some((segment) => segment === ".." || segment.length === 0)) {
    throw new HarnessServiceError("invalid-params", `file source path "${raw}" is not a workspace-relative path`);
  }
  return path;
};

const METRIC_KEY = /^(cpuPercent|memoryMb|gpu:\d+\.(?:percent|memoryMb))$/;

/** Validate and normalize the untrusted wire value at the service boundary. */
const validateSource = (value: unknown): FollowUpSource => {
  if (!isRecord(value) || typeof value.kind !== "string") {
    throw new HarnessServiceError(
      "invalid-params",
      "source.kind is required (time | experiment | artifact | file | log | metric | external | manual)",
    );
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
  if (value.kind === "artifact") {
    assertOnlyKeys(value, new Set(["kind", "attemptId", "artifactId", "name", "every", "fallbackAt"]), "artifact source");
    const attemptId = optionalNonEmptyString(value, "attemptId", "artifact source");
    if (!attemptId) throw new HarnessServiceError("invalid-params", "artifact source requires a non-empty attemptId");
    const artifactId = optionalNonEmptyString(value, "artifactId", "artifact source");
    const name = optionalNonEmptyString(value, "name", "artifact source");
    if (artifactId !== undefined && name !== undefined) {
      throw new HarnessServiceError("invalid-params", "artifact source binds by artifactId OR name, not both");
    }
    return {
      kind: "artifact",
      attemptId,
      ...(artifactId !== undefined ? { artifactId } : {}),
      ...(name !== undefined ? { name } : {}),
      ...(optionalBoolean(value, "every", "artifact source") !== undefined ? { every: value.every as boolean } : {}),
      ...(optionalEpoch(value, "fallbackAt", "artifact source") !== undefined ? { fallbackAt: value.fallbackAt as number } : {}),
    };
  }
  if (value.kind === "file") {
    assertOnlyKeys(value, new Set(["kind", "path", "condition", "fallbackAt"]), "file source");
    const rawPath = optionalNonEmptyString(value, "path", "file source");
    if (!rawPath) throw new HarnessServiceError("invalid-params", "file source requires a non-empty workspace-relative path");
    if (value.condition !== "exists" && value.condition !== "changed" && value.condition !== "ready") {
      throw new HarnessServiceError("invalid-params", "file source condition must be exists | changed | ready");
    }
    return {
      kind: "file",
      path: normalizeWatchPath(rawPath),
      condition: value.condition,
      ...(optionalEpoch(value, "fallbackAt", "file source") !== undefined ? { fallbackAt: value.fallbackAt as number } : {}),
    };
  }
  if (value.kind === "log") {
    assertOnlyKeys(value, new Set(["kind", "attemptId", "stream", "pattern", "regex", "every", "fallbackAt"]), "log source");
    const attemptId = optionalNonEmptyString(value, "attemptId", "log source");
    if (!attemptId) throw new HarnessServiceError("invalid-params", "log source requires a non-empty attemptId");
    const pattern = optionalNonEmptyString(value, "pattern", "log source");
    if (!pattern || pattern.length > 512) {
      throw new HarnessServiceError("invalid-params", "log source pattern must be 1-512 characters");
    }
    if (value.stream !== undefined && value.stream !== "stdout" && value.stream !== "stderr") {
      throw new HarnessServiceError("invalid-params", "log source stream must be stdout | stderr");
    }
    const regex = optionalBoolean(value, "regex", "log source");
    if (regex === true) {
      try {
        new RegExp(pattern);
      } catch {
        throw new HarnessServiceError("invalid-params", "log source pattern is not a valid regular expression");
      }
    }
    return {
      kind: "log",
      attemptId,
      ...(value.stream !== undefined ? { stream: value.stream as "stdout" | "stderr" } : {}),
      pattern,
      ...(regex !== undefined ? { regex } : {}),
      ...(optionalBoolean(value, "every", "log source") !== undefined ? { every: value.every as boolean } : {}),
      ...(optionalEpoch(value, "fallbackAt", "log source") !== undefined ? { fallbackAt: value.fallbackAt as number } : {}),
    };
  }
  if (value.kind === "metric") {
    assertOnlyKeys(value, new Set(["kind", "machineId", "metric", "predicate", "threshold", "every", "fallbackAt"]), "metric source");
    const machineId = optionalNonEmptyString(value, "machineId", "metric source");
    if (!machineId) throw new HarnessServiceError("invalid-params", "metric source requires a non-empty machineId");
    if (typeof value.metric !== "string" || !METRIC_KEY.test(value.metric)) {
      throw new HarnessServiceError("invalid-params", "metric source metric must be cpuPercent | memoryMb | gpu:<index>.percent | gpu:<index>.memoryMb");
    }
    if (value.predicate !== "above" && value.predicate !== "below") {
      throw new HarnessServiceError("invalid-params", "metric source predicate must be above | below");
    }
    if (typeof value.threshold !== "number" || !Number.isFinite(value.threshold)) {
      throw new HarnessServiceError("invalid-params", "metric source threshold must be a finite number");
    }
    return {
      kind: "metric",
      machineId,
      metric: value.metric,
      predicate: value.predicate,
      threshold: value.threshold,
      ...(optionalBoolean(value, "every", "metric source") !== undefined ? { every: value.every as boolean } : {}),
      ...(optionalEpoch(value, "fallbackAt", "metric source") !== undefined ? { fallbackAt: value.fallbackAt as number } : {}),
    };
  }
  if (value.kind === "external") {
    assertOnlyKeys(value, new Set(["kind", "provider", "branch", "remote", "condition", "fallbackAt"]), "external source");
    if (value.provider !== "github-pr") {
      throw new HarnessServiceError("invalid-params", `external source provider "${String(value.provider)}" is not a registered adapter`);
    }
    if (value.condition !== "exists" && value.condition !== "open" && value.condition !== "merged" && value.condition !== "closed") {
      throw new HarnessServiceError("invalid-params", "external source condition must be exists | open | merged | closed");
    }
    return {
      kind: "external",
      provider: "github-pr",
      ...(optionalNonEmptyString(value, "branch", "external source") !== undefined ? { branch: (value.branch as string).trim() } : {}),
      ...(optionalNonEmptyString(value, "remote", "external source") !== undefined ? { remote: (value.remote as string).trim() } : {}),
      condition: value.condition,
      ...(optionalEpoch(value, "fallbackAt", "external source") !== undefined ? { fallbackAt: value.fallbackAt as number } : {}),
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
    case "artifact":
      return `experiment attempt ${source.attemptId} artifact ${source.artifactId ?? source.name ?? "collection"}`
        + (source.every === true ? " (each)" : "");
    case "file":
      return `workspace file ${source.path} ${source.condition}`;
    case "log":
      return `experiment attempt ${source.attemptId} ${source.stream ?? "stdout"} matching ${source.regex === true ? `/${source.pattern}/` : JSON.stringify(source.pattern)}`
        + (source.every === true ? " (each)" : "");
    case "metric":
      return `${source.metric} on machine ${source.machineId} ${source.predicate} ${source.threshold}`
        + (source.every === true ? " (each crossing)" : "");
    case "external":
      return `GitHub PR ${source.condition}${source.branch ? ` on ${source.branch}` : ""}`;
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
  /** attemptId -> Set<followUpId> for experiment/artifact/log waits. */
  const attemptWaits = new Map<string, Set<string>>();
  /** workspaceId -> normalized path -> Set<followUpId> for file waits. */
  const fileWaits = new Map<string, Map<string, Set<string>>>();
  /** workspaceId -> live document-authority watch shared by file waits. */
  const workspaceWatches = new Map<string, { close(): void; refs: number }>();
  /** followUpId -> pending "ready" settle probe (candidate stat). */
  const readySettles = new Map<string, { timer: ReturnType<typeof setTimeout>; size: number | undefined; mtimeMs: number | undefined }>();
  /** machineId -> followUpId -> workspaceId for metric waits. */
  const metricWaits = new Map<string, Map<string, string>>();
  /** followUpId -> consumed log byte offset (persisted on sourceState). */
  const logOffsets = new Map<string, number>();
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

  const watchAttempt = (attemptId: string, followUpId: string) => {
    let set = attemptWaits.get(attemptId);
    if (!set) {
      set = new Set();
      attemptWaits.set(attemptId, set);
    }
    set.add(followUpId);
  };

  /** Sources that keep observing after an occurrence is delivered. */
  const rearming = (source: FollowUpSource): boolean =>
    (source.kind === "artifact" || source.kind === "log" || source.kind === "metric") && source.every === true
    || (source.kind === "file" && source.condition === "changed");

  const ensureWorkspaceWatch = (workspaceId: string): boolean => {
    const existing = workspaceWatches.get(workspaceId);
    if (existing) {
      existing.refs += 1;
      return true;
    }
    const handle = deps.watchWorkspace?.(workspaceId, (event) => onWatchEvent(workspaceId, event));
    if (!handle) return false;
    workspaceWatches.set(workspaceId, { close: () => handle.close(), refs: 1 });
    void handle.ready.then((ok) => {
      if (!ok) {
        // Watch could not attach — every file wait in this workspace is
        // unobservable; fail them honestly instead of waiting forever.
        for (const followUpId of [...(fileWaits.get(workspaceId)?.values() ?? [])].flatMap((set) => [...set])) {
          void markUnavailable(workspaceId, followUpId).catch(reportError);
        }
      }
    }).catch(reportError);
    return true;
  };

  const releaseWorkspaceWatch = (workspaceId: string) => {
    const entry = workspaceWatches.get(workspaceId);
    if (!entry) return;
    entry.refs -= 1;
    if (entry.refs <= 0) {
      workspaceWatches.delete(workspaceId);
      entry.close();
    }
  };

  const clearReadySettle = (followUpId: string) => {
    const pending = readySettles.get(followUpId);
    if (pending) clearTimeout(pending.timer);
    readySettles.delete(followUpId);
  };

  /** Arm in-memory observers for a waiting definition (idempotent). */
  const arm = (record: KernelRecordResult) => {
    const payload = payloadOf(record) as unknown as DefinitionPayload;
    const id = payload.id;
    const source = payload.source;
    clearTimer(id);
    if (source.kind === "time") {
      const dueAt = source.at;
      scheduleAt(id, dueAt, () => fire(
        payload.workspaceId,
        id,
        "time-due",
        { dueAt },
        `time-${dueAt}`,
        { recordRevision: record.recordRevision, sourceIdentity: sourceIdentityFor(source, "time-due") },
      ));
      return;
    }
    if (source.kind === "experiment" || source.kind === "artifact" || source.kind === "log") {
      watchAttempt(source.attemptId, id);
    }
    if (source.kind === "file") {
      let paths = fileWaits.get(payload.workspaceId);
      if (!paths) {
        paths = new Map();
        fileWaits.set(payload.workspaceId, paths);
      }
      let set = paths.get(source.path);
      if (!set) {
        set = new Set();
        paths.set(source.path, set);
      }
      const first = set.size === 0;
      set.add(id);
      if (first && !ensureWorkspaceWatch(payload.workspaceId)) {
        void markUnavailable(payload.workspaceId, id).catch(reportError);
      }
    }
    if (source.kind === "metric") {
      let set = metricWaits.get(source.machineId);
      if (!set) {
        set = new Map();
        metricWaits.set(source.machineId, set);
      }
      set.set(id, payload.workspaceId);
    }
    if (source.kind === "external") {
      scheduleExternal(payload.workspaceId, id, record.recordRevision, source);
    }
    const fallbackAt = "fallbackAt" in source ? source.fallbackAt : undefined;
    if (typeof fallbackAt === "number") {
      scheduleAt(id, fallbackAt, () => fire(
        payload.workspaceId,
        id,
        "deadline",
        { fallbackAt, stillWaiting: true },
        `deadline-${fallbackAt}`,
        { recordRevision: record.recordRevision, sourceIdentity: sourceIdentityFor(source, "deadline") },
      ));
    }
  };

  const disarm = (payload: DefinitionPayload) => {
    clearTimer(payload.id);
    const source = payload.source;
    if (source.kind === "experiment" || source.kind === "artifact" || source.kind === "log") {
      unwatchAttempt(source.attemptId, payload.id);
    }
    if (source.kind === "file") {
      clearReadySettle(payload.id);
      const paths = fileWaits.get(payload.workspaceId);
      const set = paths?.get(source.path);
      if (set) {
        set.delete(payload.id);
        if (set.size === 0) {
          paths?.delete(source.path);
          releaseWorkspaceWatch(payload.workspaceId);
        }
      }
      if (paths && paths.size === 0) fileWaits.delete(payload.workspaceId);
    }
    if (source.kind === "metric") {
      const set = metricWaits.get(source.machineId);
      if (set) {
        set.delete(payload.id);
        if (set.size === 0) metricWaits.delete(source.machineId);
      }
    }

    if (source.kind === "log") logOffsets.delete(payload.id);
  };

  const changed = (workspaceId: string) => {
    try {
      deps.onChange?.(workspaceId);
    } catch {
      // SSE fan-out must not break the service.
    }
  };

  // ---------- source observers (W-A) ----------

  /**
   * Quiet window for a file "ready" claim: the path must exist, the document
   * authority must report no active writer/capture, and a re-stat after the
   * window must observe identical size+mtime. This is atomic-publish
   * evidence — a bare "file appeared" event never qualifies.
   */
  const FILE_READY_SETTLE_MS = 750;

  /** Merge into durable per-source state while the source is unchanged. */
  const updateSourceState = async (
    workspaceId: string,
    followUpId: string,
    patch: NonNullable<DefinitionPayload["sourceState"]>,
    sourceJson: string,
  ): Promise<void> => {
    await withDefinition(followUpId, async () => {
      const record = await getDefinitionRecord(workspaceId, followUpId);
      if (!record || record.state !== "waiting") return;
      const payload = payloadOf(record) as unknown as DefinitionPayload;
      if (JSON.stringify(payload.source) !== sourceJson) return;
      await putDefinition(workspaceId, {
        ...payload,
        updatedAt: now(),
        sourceState: { ...(payload.sourceState ?? {}), ...patch },
      }, "waiting", record.recordRevision);
    });
  };

  const artifactMatches = (
    source: Extract<FollowUpSource, { kind: "artifact" }>,
    artifact: ExperimentArtifactView,
  ): boolean => {
    if (source.artifactId !== undefined) return artifact.artifactId === source.artifactId;
    if (source.name !== undefined) return artifact.name === source.name || artifact.path === source.name;
    return true;
  };

  const artifactFacts = (artifact: ExperimentArtifactView): Record<string, JsonValue> => ({
    artifactId: artifact.artifactId,
    attemptId: artifact.attemptId,
    name: artifact.name,
    kind: artifact.kind,
    state: artifact.state,
    ...(artifact.byteLength !== undefined ? { byteLength: artifact.byteLength } : {}),
    ...(artifact.path !== undefined ? { path: artifact.path } : {}),
    ...(artifact.remote ? { remoteAccessible: artifact.remote.accessible } : {}),
    ...(artifact.collectedAt !== undefined ? { collectedAt: artifact.collectedAt } : {}),
    ...(artifact.error !== undefined ? { error: artifact.error } : {}),
  });

  /**
   * Evaluate an artifact wait against the authoritative attempt detail.
   * Distinguishes collected-ready, per-artifact failure, missing bound
   * artifact, and collection failure; re-reads happen under the definition
   * caller so nothing observes with maintenance authority.
   */
  const evaluateArtifactWait = async (workspaceId: string, followUpId: string, via: string): Promise<void> => {
    const record = await getDefinitionRecord(workspaceId, followUpId);
    if (!record || record.state !== "waiting") return;
    const payload = payloadOf(record) as unknown as DefinitionPayload;
    const source = payload.source;
    if (source.kind !== "artifact") return;
    if (!deps.getExperiment) {
      await markUnavailable(workspaceId, followUpId);
      return;
    }
    let detail: { attempt: ExperimentAttemptView; artifacts: ExperimentArtifactView[] } | null;
    try {
      detail = await deps.getExperiment(payload.experimentCaller, source.attemptId);
    } catch (error) {
      if (error instanceof HarnessServiceError && error.harnessCode === "not-found") detail = null;
      else {
        reportError(error);
        return;
      }
    }
    if (detail === null) {
      await markUnavailable(workspaceId, followUpId);
      return;
    }
    const { attempt, artifacts } = detail;
    const guard = (): FireGuard => ({
      sourceIdentity: sourceIdentityFor(source, "artifact-ready"),
    });
    const bound = source.artifactId !== undefined || source.name !== undefined;
    const relevant = artifacts.filter((artifact) => artifactMatches(source, artifact));
    const ready = relevant.filter((artifact) => artifact.state === "available");
    const failed = relevant.filter((artifact) => artifact.state === "failed" || artifact.state === "expired");
    const collectionDone = attempt.collection === "done" || TERMINAL_ATTEMPT_STATES.has(attempt.state);

    if (source.every === true) {
      const firedIds = new Set(payload.sourceState?.firedArtifactIds ?? []);
      for (const artifact of ready) {
        if (firedIds.has(artifact.artifactId)) continue;
        firedIds.add(artifact.artifactId);
        const fired = await fire(workspaceId, followUpId, "artifact-ready", {
          ...artifactFacts(artifact), via,
        }, `artifact-${artifact.artifactId}-available`, guard(), {
          rearm: true,
          sourceStatePatch: { firedArtifactIds: [...firedIds] },
        });
        if (!fired) return;
      }
      if (collectionDone || attempt.collection === "failed") {
        // The set is final — close the per-artifact wait with an end fact.
        await fire(workspaceId, followUpId, "artifact-collection-finished", {
          attemptId: source.attemptId,
          attemptState: attempt.state,
          collection: attempt.collection,
          artifactCount: ready.length,
          via,
        }, `artifact-collection-${source.attemptId}-${attempt.collection}-${attempt.state}`, guard());
      }
      return;
    }

    const failedArtifact = failed.find((artifact) => artifactMatches(source, artifact));
    if (failedArtifact) {
      await fire(workspaceId, followUpId, "artifact-failed", {
        ...artifactFacts(failedArtifact), via,
      }, `artifact-${failedArtifact.artifactId}-${failedArtifact.state}`, guard());
      return;
    }
    if (bound) {
      const readyBound = ready[0];
      if (readyBound) {
        await fire(workspaceId, followUpId, "artifact-ready", {
          ...artifactFacts(readyBound), via,
        }, `artifact-${readyBound.artifactId}-available`, guard());
        return;
      }
      if (collectionDone || attempt.collection === "failed") {
        await fire(workspaceId, followUpId, "artifact-missing", {
          attemptId: source.attemptId,
          attemptState: attempt.state,
          collection: attempt.collection,
          boundBy: source.artifactId !== undefined ? "artifactId" : "name",
          boundTo: source.artifactId ?? source.name ?? "",
          via,
        }, `artifact-missing-${source.attemptId}-${attempt.state}-${attempt.collection}`, guard());
      }
      return;
    }
    // Unbound one-shot: the collected set is the condition.
    if (attempt.collection === "failed") {
      await fire(workspaceId, followUpId, "artifact-failed", {
        attemptId: source.attemptId, attemptState: attempt.state, collection: attempt.collection, via,
      }, `artifact-collection-${source.attemptId}-failed`, guard());
      return;
    }
    if (attempt.collection === "done") {
      await fire(workspaceId, followUpId, "artifact-ready", {
        attemptId: source.attemptId,
        collection: attempt.collection,
        artifacts: ready.map((artifact) => artifactFacts(artifact)),
        via,
      }, `artifact-collection-${source.attemptId}-done`, guard());
      return;
    }
    if (TERMINAL_ATTEMPT_STATES.has(attempt.state)) {
      await fire(workspaceId, followUpId, "artifact-missing", {
        attemptId: source.attemptId,
        attemptState: attempt.state,
        collection: attempt.collection,
        via,
      }, `artifact-missing-${source.attemptId}-${attempt.state}-${attempt.collection}`, guard());
    }
  };

  const LOG_CHUNK_BYTES = 256 * 1024;

  /**
   * Drain new durable log bytes for a log wait. A short tail overlap is kept
   * so a pattern straddling a read boundary is not missed; the persisted
   * offset trails by the pattern length so a restart replays only a bounded
   * tail — occurrence ids dedupe the overlap.
   */
  const drainLog = async (workspaceId: string, followUpId: string, via: string): Promise<void> => {
    const record = await getDefinitionRecord(workspaceId, followUpId);
    if (!record || record.state !== "waiting") return;
    const payload = payloadOf(record) as unknown as DefinitionPayload;
    const source = payload.source;
    if (source.kind !== "log") return;
    if (!deps.readExperimentLog) {
      await markUnavailable(workspaceId, followUpId);
      return;
    }
    const sourceJson = JSON.stringify(source);
    const patternBytes = Buffer.byteLength(source.pattern);
    let offset = Math.max(0, logOffsets.get(followUpId) ?? payload.sourceState?.logOffset ?? 0);
    const regex = source.regex === true ? new RegExp(source.pattern, "g") : null;
    let tail = "";
    let tailByteLength = 0;
    let eof = false;
    // Bounded per drain; further bytes arrive with the next attempt wakeup.
    for (let chunks = 0; chunks < 64; chunks += 1) {
      let page: { text: string; offset?: number; nextOffset: number; eof: boolean };
      try {
        page = await deps.readExperimentLog(payload.experimentCaller, {
          attemptId: source.attemptId,
          ...(source.stream !== undefined ? { stream: source.stream } : {}),
          offset,
          maxBytes: LOG_CHUNK_BYTES,
        });
      } catch (error) {
        if (error instanceof HarnessServiceError && error.harnessCode === "not-found") {
          await markUnavailable(workspaceId, followUpId);
          return;
        }
        reportError(error);
        return;
      }
      if (page.text.length === 0) {
        eof = page.eof;
        break;
      }
      const pageOffset = (page as { offset?: number }).offset ?? offset;
      const scanText = tail + page.text;
      const scanBase = pageOffset - tailByteLength;
      const matches: Array<{ at: number; end: number; text: string }> = [];
      if (regex) {
        regex.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = regex.exec(scanText)) !== null) {
          const at = scanBase + Buffer.byteLength(scanText.slice(0, match.index));
          if (at >= offset) {
            matches.push({ at, end: at + Buffer.byteLength(match[0]), text: match[0].slice(0, 160) });
            if (source.every !== true) break;
          }
          if (match[0].length === 0) regex.lastIndex += 1;
        }
      } else {
        let from = 0;
        for (;;) {
          const index = scanText.indexOf(source.pattern, from);
          if (index < 0) break;
          const at = scanBase + Buffer.byteLength(scanText.slice(0, index));
          from = index + Math.max(1, source.pattern.length);
          if (at < offset) continue;
          matches.push({ at, end: at + patternBytes, text: source.pattern.slice(0, 160) });
          if (source.every !== true) break;
        }
      }
      for (const match of matches) {
        const current = await getDefinitionRecord(workspaceId, followUpId);
        if (!current || current.state !== "waiting") return;
        const currentPayload = payloadOf(current) as unknown as DefinitionPayload;
        if (JSON.stringify(currentPayload.source) !== sourceJson) return;
        const fired = await fire(workspaceId, followUpId, "log-match", {
          attemptId: source.attemptId,
          stream: source.stream ?? "stdout",
          offset: match.at,
          match: match.text,
          via,
        }, `log-${match.at}`, {
          recordRevision: current.recordRevision,
          sourceIdentity: sourceIdentityFor(currentPayload.source, "log-match"),
        }, {
          rearm: source.every === true,
          sourceStatePatch: { logOffset: match.end },
        });
        if (!fired) return;
        if (source.every !== true) {
          logOffsets.set(followUpId, match.end);
          return;
        }
      }
      const carry = Math.max(0, patternBytes - 1);
      if (scanText.length > carry) {
        tail = scanText.slice(-carry);
        tailByteLength = Buffer.byteLength(tail);
      } else {
        tail = scanText;
        tailByteLength = Buffer.byteLength(scanText);
      }
      if (page.nextOffset <= offset) break; // reader made no progress
      offset = page.nextOffset;
      logOffsets.set(followUpId, offset);
      if (page.eof) {
        eof = true;
        break;
      }
    }
    // Persist the cursor trailed by the pattern tail — restart overlap replays
    // dedupe on the `log-<offset>` occurrence identity.
    await updateSourceState(workspaceId, followUpId, {
      logOffset: Math.max(0, offset - Math.max(0, patternBytes - 1)),
    }, sourceJson).catch(reportError);
    if (eof) {
      const current = await getDefinitionRecord(workspaceId, followUpId);
      if (!current || current.state !== "waiting") return;
      const currentPayload = payloadOf(current) as unknown as DefinitionPayload;
      if (JSON.stringify(currentPayload.source) !== sourceJson) return;
      await fire(workspaceId, followUpId, "log-exhausted", {
        attemptId: source.attemptId,
        stream: source.stream ?? "stdout",
        pattern: source.pattern.slice(0, 160),
        consumedBytes: offset,
        via,
      }, `log-exhausted-${source.attemptId}-${source.stream ?? "stdout"}`, {
        recordRevision: current.recordRevision,
        sourceIdentity: sourceIdentityFor(currentPayload.source, "log-exhausted"),
      });
    }
  };

  /** file wait evaluation — watch events only invalidate; stat decides. */
  const evaluateFileWait = async (workspaceId: string, followUpId: string, via: string): Promise<void> => {
    const record = await getDefinitionRecord(workspaceId, followUpId);
    if (!record || record.state !== "waiting") return;
    const payload = payloadOf(record) as unknown as DefinitionPayload;
    const source = payload.source;
    if (source.kind !== "file") return;
    if (!deps.statWorkspaceFile) {
      await markUnavailable(workspaceId, followUpId);
      return;
    }
    let stat: { exists: boolean; size?: number; mtimeMs?: number } | null | undefined;
    try {
      stat = await deps.statWorkspaceFile(workspaceId, source.path);
    } catch (error) {
      reportError(error);
      return;
    }
    if (stat === undefined) return; // transient — the watch still covers the edge
    if (stat === null) {
      await markUnavailable(workspaceId, followUpId);
      return;
    }
    if (!stat.exists) {
      clearReadySettle(followUpId);
      return;
    }
    if (source.condition === "exists") {
      await fire(workspaceId, followUpId, "file-exists", {
        path: source.path,
        ...(stat.size !== undefined ? { size: stat.size } : {}),
        ...(stat.mtimeMs !== undefined ? { mtimeMs: stat.mtimeMs } : {}),
        via,
      }, `file-exists-${source.path}-${stat.mtimeMs ?? 0}-${stat.size ?? 0}`, {
        recordRevision: record.recordRevision,
        sourceIdentity: sourceIdentityFor(source, "file-exists"),
      });
      return;
    }
    if (source.condition !== "ready") return;
    const writers = deps.workspaceHasActiveWriters
      ? await deps.workspaceHasActiveWriters(workspaceId).catch(() => true)
      : false;
    if (writers) {
      clearReadySettle(followUpId);
      return;
    }
    const pending = readySettles.get(followUpId);
    if (pending && pending.size === stat.size && pending.mtimeMs === stat.mtimeMs) return;
    clearReadySettle(followUpId);
    const timer = setTimeout(() => {
      readySettles.delete(followUpId);
      void confirmFileReady(workspaceId, followUpId, { size: stat.size, mtimeMs: stat.mtimeMs }).catch(reportError);
    }, FILE_READY_SETTLE_MS);
    readySettles.set(followUpId, { timer, size: stat.size, mtimeMs: stat.mtimeMs });
  };

  const confirmFileReady = async (
    workspaceId: string,
    followUpId: string,
    candidate: { size: number | undefined; mtimeMs: number | undefined },
  ): Promise<void> => {
    const record = await getDefinitionRecord(workspaceId, followUpId);
    if (!record || record.state !== "waiting") return;
    const payload = payloadOf(record) as unknown as DefinitionPayload;
    const source = payload.source;
    if (source.kind !== "file" || source.condition !== "ready" || !deps.statWorkspaceFile) return;
    let stat: { exists: boolean; size?: number; mtimeMs?: number } | null;
    try {
      stat = await deps.statWorkspaceFile(workspaceId, source.path);
    } catch (error) {
      reportError(error);
      return;
    }
    if (!stat?.exists) return;
    const writers = deps.workspaceHasActiveWriters
      ? await deps.workspaceHasActiveWriters(workspaceId).catch(() => true)
      : false;
    if (writers || stat.size !== candidate.size || stat.mtimeMs !== candidate.mtimeMs) {
      // Still mutating — re-arm the settle probe on the new observed state.
      if (!writers && stat.exists) {
        const timer = setTimeout(() => {
          readySettles.delete(followUpId);
          void confirmFileReady(workspaceId, followUpId, { size: stat!.size, mtimeMs: stat!.mtimeMs }).catch(reportError);
        }, FILE_READY_SETTLE_MS);
        readySettles.set(followUpId, { timer, size: stat.size, mtimeMs: stat.mtimeMs });
      }
      return;
    }
    await fire(workspaceId, followUpId, "file-ready", {
      path: source.path,
      ...(stat.size !== undefined ? { size: stat.size } : {}),
      ...(stat.mtimeMs !== undefined ? { mtimeMs: stat.mtimeMs } : {}),
      stableForMs: FILE_READY_SETTLE_MS,
    }, `file-ready-${source.path}-${stat.mtimeMs ?? 0}-${stat.size ?? 0}`, {
      recordRevision: record.recordRevision,
      sourceIdentity: sourceIdentityFor(source, "file-ready"),
    });
  };

  const onWatchEvent = (workspaceId: string, event: {
    kind: string; sequence: number; generation: number; path?: string;
  }) => {
    const path = event.path;
    if (!path) return;
    const set = fileWaits.get(workspaceId)?.get(path);
    if (!set || set.size === 0) return;
    for (const followUpId of [...set]) {
      void (async () => {
        const record = await getDefinitionRecord(workspaceId, followUpId);
        if (!record || record.state !== "waiting") return;
        const payload = payloadOf(record) as unknown as DefinitionPayload;
        const source = payload.source;
        if (source.kind !== "file" || source.path !== path) return;
        if (event.kind === "deleted" || event.kind === "reset") {
          clearReadySettle(followUpId);
          return;
        }
        if (source.condition === "changed") {
          await fire(workspaceId, followUpId, "file-changed", {
            path: source.path,
            event: event.kind,
            sequence: event.sequence,
            generation: event.generation,
          }, `file-${event.generation}-${event.sequence}`, {
            recordRevision: record.recordRevision,
            sourceIdentity: sourceIdentityFor(source, "file-changed"),
          }, { rearm: true });
          return;
        }
        await evaluateFileWait(workspaceId, followUpId, "event");
      })().catch(reportError);
    }
  };

  const metricValue = (sample: FollowUpResourceSample, key: string): number | undefined => {
    if (key === "cpuPercent") return sample.usage.cpuPercent;
    if (key === "memoryMb") return sample.usage.memoryMb;
    const gpu = /^gpu:(\d+)\.(percent|memoryMb)$/.exec(key);
    if (gpu) {
      const entry = sample.usage.gpus?.find((device) => device.index === Number(gpu[1]))
        ?? sample.usage.gpus?.[Number(gpu[1])];
      return gpu[2] === "percent" ? entry?.utilizationPercent : entry?.usedMemoryMb;
    }
    return undefined;
  };

  /**
   * Metric waits fire on the crossing edge only. The persisted `holding`
   * flag survives restarts, so a steady-true stream cannot re-wake the
   * target and a restart cannot replay a consumed crossing.
   */
  const evaluateMetricSample = async (
    workspaceId: string,
    followUpId: string,
    sample: FollowUpResourceSample,
    via: string,
  ): Promise<void> => {
    const record = await getDefinitionRecord(workspaceId, followUpId);
    if (!record || record.state !== "waiting") return;
    const payload = payloadOf(record) as unknown as DefinitionPayload;
    const source = payload.source;
    if (source.kind !== "metric" || source.machineId !== sample.machineId) return;
    const value = metricValue(sample, source.metric);
    if (value === undefined) return; // dimension not probed — not evidence either way
    const holds = source.predicate === "above" ? value > source.threshold : value < source.threshold;
    const held = payload.sourceState?.holding === true;
    const sourceJson = JSON.stringify(source);
    if (holds === held) return;
    if (!holds) {
      await updateSourceState(workspaceId, followUpId, { holding: false }, sourceJson).catch(reportError);
      return;
    }
    await fire(workspaceId, followUpId, "metric-crossed", {
      machineId: source.machineId,
      metric: source.metric,
      predicate: source.predicate,
      threshold: source.threshold,
      value,
      observedAt: sample.observedAt,
      via,
    }, `metric-${source.machineId}-${source.metric}-${sample.observedAt}`, {
      recordRevision: record.recordRevision,
      sourceIdentity: sourceIdentityFor(source, "metric-crossed"),
    }, {
      rearm: source.every === true,
      sourceStatePatch: { holding: true },
    });
  };

  const unsubscribeSamples = deps.subscribeResourceSamples?.((sample) => {
    const set = metricWaits.get(sample.machineId);
    if (!set) return;
    for (const [followUpId, workspaceId] of [...set]) {
      void evaluateMetricSample(workspaceId, followUpId, sample, "sample").catch(reportError);
    }
  });

  /**
   * Registration/poke evaluation for an external source. The adapter's own
   * `intervalMs` spaces queries; `retryAfterMs` handles rate limiting. A
   * matched state fires once with the adapter's stable event identity.
   */
  const runExternalQuery = async (workspaceId: string, followUpId: string, via: string): Promise<void> => {
    const record = await getDefinitionRecord(workspaceId, followUpId);
    if (!record || record.state !== "waiting") return;
    const payload = payloadOf(record) as unknown as DefinitionPayload;
    const source = payload.source;
    if (source.kind !== "external") return;
    const adapter = deps.externalSource?.(source.provider);
    if (!adapter) {
      await markUnavailable(workspaceId, followUpId);
      return;
    }
    let result: Awaited<ReturnType<FollowUpExternalSource["query"]>>;
    try {
      result = await adapter.query({ workspaceId, source });
    } catch (error) {
      // Transient query failure — keep the wait and try the next slot.
      reportError(error);
      scheduleExternal(workspaceId, followUpId, record.recordRevision, source);
      return;
    }
    if (result.unavailable === true) {
      await markUnavailable(workspaceId, followUpId);
      return;
    }
    if (!result.matched) {
      scheduleExternal(workspaceId, followUpId, record.recordRevision, source, result.retryAfterMs);
      return;
    }
    await fire(workspaceId, followUpId, "external-match", {
      provider: source.provider,
      ...result.facts,
      via,
    }, result.eventId ?? `ext-${source.provider}-${JSON.stringify(result.facts)}`, {
      recordRevision: record.recordRevision,
      sourceIdentity: sourceIdentityFor(source, "external-match"),
    });
  };

  const scheduleExternal = (
    workspaceId: string,
    followUpId: string,
    recordRevision: number,
    source: Extract<FollowUpSource, { kind: "external" }>,
    delayMs?: number,
  ) => {
    const adapter = deps.externalSource?.(source.provider);
    if (!adapter) {
      void markUnavailable(workspaceId, followUpId).catch(reportError);
      return;
    }
    // Adapter-owned spacing; the floor only guards against a hot retry loop.
    const delay = Math.max(5_000, delayMs ?? adapter.intervalMs);
    scheduleAt(followUpId, now() + delay, () => runExternalQuery(workspaceId, followUpId, "poll"));
  };

  /** Registration/reconcile snapshot: fire if the condition already holds. */
  const primeSource = async (workspaceId: string, followUpId: string, via: string): Promise<void> => {
    const record = await getDefinitionRecord(workspaceId, followUpId);
    if (!record || record.state !== "waiting") return;
    const payload = payloadOf(record) as unknown as DefinitionPayload;
    const source = payload.source;
    if (source.kind === "artifact") {
      await evaluateArtifactWait(workspaceId, followUpId, via);
    } else if (source.kind === "file") {
      await evaluateFileWait(workspaceId, followUpId, via);
    } else if (source.kind === "log") {
      await drainLog(workspaceId, followUpId, via);
    } else if (source.kind === "metric") {
      if (!deps.getResourceSample) {
        await markUnavailable(workspaceId, followUpId);
        return;
      }
      const sample = await deps.getResourceSample(source.machineId).catch((error) => {
        reportError(error);
        return null;
      });
      if (sample) await evaluateMetricSample(workspaceId, followUpId, sample, via);
    } else if (source.kind === "external") {
      await runExternalQuery(workspaceId, followUpId, via);
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
      : (occurrence.reason === "deadline" || occurrence.rearm === true) ? "waiting" : "delivered";
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
    opts?: { rearm?: boolean; sourceStatePatch?: DefinitionPayload["sourceState"] },
  ): Promise<boolean> => withDefinition(followUpId, async () => {
      const record = await getDefinitionRecord(workspaceId, followUpId);
      if (!record) return false;
      const payload = payloadOf(record) as unknown as DefinitionPayload;
      const status = record.state as FollowUpStatus;
      if (status !== "waiting") return false; // cancelled/superseded/delivered — late callbacks cannot revive
      if (guard) {
        const sameRevision = guard.recordRevision === undefined
          || record.recordRevision === guard.recordRevision;
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
        ...(opts?.rearm === true ? { rearm: true } : {}),
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
      const mergedSourceState = opts?.sourceStatePatch !== undefined
        ? { ...(payload.sourceState ?? {}), ...opts.sourceStatePatch }
        : payload.sourceState;
      if (reason === "deadline" && "fallbackAt" in payload.source && payload.source.fallbackAt !== undefined) {
        // Backstop fires once; the event wait survives — clear fallbackAt so
        // a reconcile does not re-arm the consumed deadline.
        const next = { ...payload, source: { ...payload.source }, updatedAt: now() };
        delete (next.source as { fallbackAt?: number }).fallbackAt;
        const nextPayload: DefinitionPayload = {
          ...next,
          ...(mergedSourceState !== undefined ? { sourceState: mergedSourceState } : {}),
          lastOccurrence: { id: occurrenceId, reason, at: now(), delivered: false },
        };
        await putDefinition(workspaceId, nextPayload, "waiting", record.recordRevision);
        clearTimer(followUpId);
      } else {
        const nextPayload: DefinitionPayload = {
          ...payload,
          updatedAt: now(),
          ...(mergedSourceState !== undefined ? { sourceState: mergedSourceState } : {}),
          lastOccurrence: { id: occurrenceId, reason, at: now(), delivered: false },
        };
        await putDefinition(workspaceId, nextPayload, "triggered", record.recordRevision);
        if (opts?.rearm !== true) disarm(payload);
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
      // Observer first, snapshot second — an edge during the interval is
      // delivered once by whichever path commits the occurrence first.
      await primeSource(caller.workspaceId, id, "register");
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
      await primeSource(caller.workspaceId, params.id, "update");
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

  /** Read-only probe facts for a check report (no firing, no cursor advance). */
  const probeFacts = async (
    caller: FollowUpCaller,
    payload: DefinitionPayload,
  ): Promise<Record<string, JsonValue>> => {
    const source = payload.source;
    if (source.kind === "file") {
      const stat = deps.statWorkspaceFile
        ? await deps.statWorkspaceFile(caller.workspaceId, source.path).catch(() => null)
        : null;
      return {
        kind: "file",
        path: source.path,
        condition: source.condition,
        exists: stat?.exists === true,
        ...(stat?.size !== undefined ? { size: stat.size } : {}),
        ...(stat?.mtimeMs !== undefined ? { mtimeMs: stat.mtimeMs } : {}),
      };
    }
    if (source.kind === "metric") {
      const sample = deps.getResourceSample
        ? await deps.getResourceSample(source.machineId).catch(() => null)
        : null;
      const value = sample ? metricValue(sample, source.metric) : undefined;
      return {
        kind: "metric",
        machineId: source.machineId,
        metric: source.metric,
        ...(value !== undefined && sample
          ? { value, observedAt: sample.observedAt, holding: payload.sourceState?.holding === true }
          : { sampled: false }),
      };
    }
    if (source.kind === "artifact") {
      const detail = deps.getExperiment
        ? await deps.getExperiment(payload.experimentCaller, source.attemptId).catch(() => null)
        : null;
      if (!detail) return { kind: "artifact", attemptId: source.attemptId, observed: "unavailable" };
      return {
        kind: "artifact",
        attemptId: source.attemptId,
        attemptState: detail.attempt.state,
        collection: detail.attempt.collection,
        readyArtifacts: detail.artifacts.filter((a) => a.state === "available" && artifactMatches(source, a)).length,
      };
    }
    if (source.kind === "log") {
      return {
        kind: "log",
        attemptId: source.attemptId,
        consumedBytes: logOffsets.get(payload.id) ?? payload.sourceState?.logOffset ?? 0,
      };
    }
    if (source.kind === "external") {
      return { kind: "external", provider: source.provider, condition: source.condition };
    }
    return { kind: source.kind };
  };

  const OBSERVED_KINDS: ReadonlySet<string> = new Set(["artifact", "file", "log", "metric", "external"]);

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
    const { record: before } = await requireDefinition(caller, params.id);
    const beforePayload = payloadOf(before) as unknown as DefinitionPayload;
    const beforeOccurrence = beforePayload.lastOccurrence?.id;
    if (before.state === "waiting" && OBSERVED_KINDS.has(beforePayload.source.kind)) {
      // Observed sources evaluate through their own prime path — the same one
      // registration and reconcile use — so check cannot diverge from events.
      await primeSource(caller.workspaceId, params.id, "check");
      const { record: after } = await requireDefinition(caller, params.id);
      const afterPayload = payloadOf(after) as unknown as DefinitionPayload;
      const fired = afterPayload.lastOccurrence !== undefined
        && afterPayload.lastOccurrence.id !== beforeOccurrence;
      let observed = await probeFacts(caller, afterPayload).catch(() => ({ kind: afterPayload.source.kind } as Record<string, JsonValue>));
      if (fired && afterPayload.lastOccurrence) {
        const { scoped } = await recordScope(caller.workspaceId);
        const occurrence = await scoped.getRecord(caller.workspaceId, occurrenceIdFor(afterPayload.lastOccurrence.id)).catch(() => null);
        if (occurrence) observed = (payloadOf(occurrence) as unknown as OccurrencePayload).facts;
      }
      return { followUp: toView(after), fired, observed };
    }
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

  // Experiment attempt changes drive experiment/artifact/log waits. The
  // notification is only a wakeup — every path re-reads through the
  // definition's persisted caller. Occurrence identities dedupe replays.
  const unsubscribeAttempts = deps.subscribeAttempts?.((workspaceId, attemptId, _view) => {
    const waiting = attemptWaits.get(attemptId);
    if (!waiting) return;
    for (const followUpId of [...waiting]) {
      void (async () => {
        const record = await getDefinitionRecord(workspaceId, followUpId);
        if (!record || record.state !== "waiting") return;
        const payload = payloadOf(record) as unknown as DefinitionPayload;
        if (payload.source.kind === "artifact" && payload.source.attemptId === attemptId) {
          await evaluateArtifactWait(workspaceId, followUpId, "event");
          return;
        }
        if (payload.source.kind === "log" && payload.source.attemptId === attemptId) {
          await drainLog(workspaceId, followUpId, "event");
          return;
        }
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
        if (OBSERVED_KINDS.has(payload.source.kind)) {
          // Rebuild the observer, then re-read the authoritative snapshot —
          // the durable observer is installed before any eval so a restart
          // edge is never lost. Occurrence identities dedupe overlap replays.
          arm(record);
          await primeSource(workspaceId, payload.id, "reconcile");
          if (payload.lastOccurrence && payload.lastOccurrence.delivered === false) {
            await assertLatestOccurrenceSettled(workspaceId, payload.id);
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
      unsubscribeSamples?.();
      for (const id of [...timers.keys()]) clearTimer(id);
      for (const id of [...readySettles.keys()]) clearReadySettle(id);
      for (const [workspaceId] of workspaceWatches) {
        workspaceWatches.get(workspaceId)?.close();
      }
      workspaceWatches.clear();
      fileWaits.clear();
      metricWaits.clear();
      logOffsets.clear();
    },
  };
}

export type FollowUpService = ReturnType<typeof createFollowUpService>;
