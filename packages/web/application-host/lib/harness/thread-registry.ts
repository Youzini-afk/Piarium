/**
 * Durable Host-owned registry for threads and their execution attempts.
 *
 * One versioned catalog is written per workspace. Thread and ThreadRun rows
 * share the same atomic file so a run transition cannot be committed without
 * its corresponding thread projection.
 */

import fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import { ROLE_DEFINITIONS } from "@piarium/protocol";
import type {
  Thread,
  ThreadAttention,
  ThreadCreatedBy,
  ThreadDiffStats,
  ThreadIntegration,
  ThreadKind,
  ThreadLifecycle,
  ThreadLaunchManifest,
  ThreadParent,
  ThreadReport,
  ThreadRun,
  ThreadRunOutcome,
  ThreadTokens,
  ThreadViewCursor,
  ThreadWaitingFor,
  ThreadWorktree,
} from "@piarium/protocol";

export type {
  Thread,
  ThreadAttention,
  ThreadCreatedBy,
  ThreadDiffStats,
  ThreadIntegration,
  ThreadKind,
  ThreadLifecycle,
  ThreadParent,
  ThreadReport,
  ThreadRun,
  ThreadRunOutcome,
  ThreadTokens,
  ThreadWaitingFor,
  ThreadWorktree,
};

export const THREAD_REGISTRY_SCHEMA_VERSION = 4;

export type ThreadRegistryErrorCode =
  | "corrupt"
  | "future-schema"
  | "read-failed"
  | "write-failed";

export class ThreadRegistryError extends Error {
  readonly code: ThreadRegistryErrorCode;
  readonly path: string;

  constructor(code: ThreadRegistryErrorCode, message: string, path: string, options: { cause?: unknown } = {}) {
    super(message, options);
    this.name = "ThreadRegistryError";
    this.code = code;
    this.path = path;
  }
}

export interface ThreadCatalogDocument {
  schemaVersion: typeof THREAD_REGISTRY_SCHEMA_VERSION;
  workspaceId: string;
  threads: Thread[];
  runs: ThreadRun[];
}

interface ThreadCatalogV1 {
  schemaVersion: 1;
  workspaceId: string;
  threads: Array<Omit<Thread, "manifest" | "model" | "report"> & { report: LegacyThreadReport | null }>;
  runs: ThreadRun[];
}

interface ThreadCatalogV2 {
  schemaVersion: 2;
  workspaceId: string;
  threads: Array<Omit<Thread, "manifest" | "model">>;
  runs: ThreadRun[];
}

interface ThreadCatalogV3 {
  schemaVersion: 3;
  workspaceId: string;
  threads: Array<Omit<Thread, "manifest">>;
  runs: ThreadRun[];
}

export interface CreateThreadInput {
  workspaceId: string;
  parent: ThreadParent;
  brief: string;
  role?: string;
  kind: ThreadKind;
  createdBy: ThreadCreatedBy;
  forkPoint?: { entryId: string };
  carryBlocks?: boolean;
  concurrency: number;
  scope?: string[];
  worktree: "none" | "shared" | "isolated";
  model?: { providerId: string; modelId: string };
  tools: string[];
  permissions: unknown;
  systemPromptFragment?: string;
  autoRun: boolean;
  hidden?: boolean;
}

export interface ThreadRegistryOptions {
  dataDir: string;
  hostId: string;
  onThreadChanged?: (workspaceId: string, parent: ThreadParent, thread: Thread, activeRun: ThreadRun | null) => void;
  onThreadDone?: (workspaceId: string, parent: ThreadParent, threadId: string, report: ThreadReport) => void;
  onThreadDequeued?: (workspaceId: string, parent: ThreadParent, thread: Thread) => Promise<void>;
  onObserverError?: (error: unknown) => void;
  maxConcurrency?: number;
  fsPromises?: Pick<typeof fs.promises, "mkdir" | "readFile" | "readdir" | "rename" | "rm" | "writeFile">;
  now?: () => Date;
}

export interface ThreadRegistryReconcileFailure {
  code: ThreadRegistryErrorCode;
  message: string;
  path: string;
}

export interface ThreadRegistryReconcileResult {
  failures: ThreadRegistryReconcileFailure[];
  legacyFilesSkipped: number;
  reconciledRuns: number;
  workspaces: number;
}

interface LegacyThreadRecord {
  id: string;
  parentSessionId: string;
  sessionId: string;
  forkPoint: { entryId: string } | null;
  brief: string;
  role: string | null;
  createdBy: ThreadCreatedBy;
  kind: ThreadKind;
  worktree: ThreadWorktree | null;
  status: string;
  flags?: { workerLost?: boolean; stalled?: boolean; looping?: boolean };
  waitingFor: ThreadWaitingFor | null;
  lastActivityAt: string;
  steps: number;
  tokens: ThreadTokens;
  costUsd: number | null;
  lastToolCall: { name: string; at: string } | null;
  diffStats: ThreadDiffStats | null;
  report: LegacyThreadReport | null;
  exitReason: string | null;
  createdAt: string;
  updatedAt: string;
  eventSeq: number;
  hidden?: boolean;
}

interface LegacyThreadReport {
  conclusion: string;
  changedFiles: string[];
  unresolved: string[];
  deviations: string[];
  confidence: number;
  traceHandle: string;
  blocksSnapshot: Record<string, string>;
}

interface MutationResult<T> {
  value: T;
  changed: Thread[];
  done?: Array<{ thread: Thread; report: ThreadReport }>;
  wakeParents?: ThreadParent[];
  write?: boolean;
}

const LIFECYCLES = new Set<ThreadLifecycle>(["queued", "active", "settled", "archived"]);
const ATTENTIONS = new Set<ThreadAttention>(["none", "user", "permission", "stalled", "looping"]);
const INTEGRATIONS = new Set<ThreadIntegration>(["none", "dirty", "merge-ready", "conflict", "merged"]);
const WORKER_STATES = new Set<ThreadRun["workerState"]>(["starting", "running", "lost", "exited"]);
const OUTCOMES = new Set<ThreadRunOutcome>(["success", "failure", "cancelled", "lost"]);

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === "object" && !Array.isArray(value)
);
const isString = (value: unknown): value is string => typeof value === "string";
const isNullableString = (value: unknown): value is string | null => value === null || isString(value);
const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

const isParent = (value: unknown): value is ThreadParent => (
  isRecord(value)
  && (value.kind === "session" || value.kind === "thread")
  && isString(value.id)
  && value.id.length > 0
);

const isTokens = (value: unknown): value is ThreadTokens => (
  isRecord(value)
  && isFiniteNumber(value.input)
  && isFiniteNumber(value.output)
  && isFiniteNumber(value.cacheRead)
);

const isWaitingFor = (value: unknown): value is ThreadWaitingFor | null => (
  value === null
  || (isRecord(value)
    && (value.kind === "user" || value.kind === "permission" || value.kind === "thread")
    && isString(value.text))
);

const isDiffStats = (value: unknown): value is ThreadDiffStats | null => (
  value === null
  || (isRecord(value)
    && isFiniteNumber(value.files)
    && isFiniteNumber(value.insertions)
    && isFiniteNumber(value.deletions))
);

const isTranscriptRef = (value: unknown): value is ThreadReport["transcriptRef"] => (
  isRecord(value)
  && isString(value.runtimeId)
  && isString(value.sessionId)
  && isNullableString(value.fromEntryId)
  && isNullableString(value.toEntryId)
  && (value.branchLeafId === undefined || isString(value.branchLeafId))
);

const isLaunchManifest = (value: unknown): value is ThreadLaunchManifest => (
  isRecord(value)
  && Number.isSafeInteger(value.concurrency) && Number(value.concurrency) > 0
  && Array.isArray(value.scope) && value.scope.every(isString)
  && isNullableString(value.systemPromptFragment)
  && Array.isArray(value.tools) && value.tools.every(isString)
  && (value.worktree === "none" || value.worktree === "shared" || value.worktree === "isolated")
);

const isReport = (value: unknown): value is ThreadReport | null => (
  value === null
  || (isRecord(value)
    && isString(value.conclusion)
    && Array.isArray(value.changedFiles) && value.changedFiles.every(isString)
    && Array.isArray(value.unresolved) && value.unresolved.every(isString)
    && Array.isArray(value.deviations) && value.deviations.every(isString)
    && isFiniteNumber(value.confidence)
    && isTranscriptRef(value.transcriptRef)
    && isRecord(value.blocksSnapshot) && Object.values(value.blocksSnapshot).every(isString))
);

const isLegacyReport = (value: unknown): value is LegacyThreadReport | null => (
  value === null
  || (isRecord(value)
    && isString(value.conclusion)
    && Array.isArray(value.changedFiles) && value.changedFiles.every(isString)
    && Array.isArray(value.unresolved) && value.unresolved.every(isString)
    && Array.isArray(value.deviations) && value.deviations.every(isString)
    && isFiniteNumber(value.confidence)
    && isString(value.traceHandle)
    && isRecord(value.blocksSnapshot) && Object.values(value.blocksSnapshot).every(isString))
);

const isThread = (value: unknown): value is Thread => {
  if (!isRecord(value)) return false;
  return isString(value.id)
    && isParent(value.parent)
    && isString(value.workspaceId)
    && (value.forkPoint === null || (isRecord(value.forkPoint) && isString(value.forkPoint.entryId)))
    && isString(value.brief)
    && isNullableString(value.role)
    && (value.model === null || (isRecord(value.model) && isString(value.model.providerId) && isString(value.model.modelId)))
    && isLaunchManifest(value.manifest)
    && (value.createdBy === "user" || value.createdBy === "agent")
    && (value.kind === "discussion" || value.kind === "implementation")
    && (value.worktree === null || (isRecord(value.worktree) && isString(value.worktree.path) && isString(value.worktree.base)))
    && LIFECYCLES.has(value.lifecycle as ThreadLifecycle)
    && ATTENTIONS.has(value.attention as ThreadAttention)
    && isWaitingFor(value.waitingFor)
    && INTEGRATIONS.has(value.integration as ThreadIntegration)
    && isDiffStats(value.diffStats)
    && isReport(value.report)
    && isNullableString(value.activeRunId)
    && isString(value.createdAt)
    && isString(value.updatedAt)
    && Number.isSafeInteger(value.eventSeq)
    && typeof value.hidden === "boolean";
};

const legacyLaunchManifest = (value: Record<string, unknown>): ThreadLaunchManifest => {
  const role = typeof value.role === "string" && Object.hasOwn(ROLE_DEFINITIONS, value.role)
    ? ROLE_DEFINITIONS[value.role as keyof typeof ROLE_DEFINITIONS]
    : null;
  const configuredWorktree = role?.worktree === "shared"
    ? "shared" as const
    : role?.worktree === "none"
      ? "none" as const
      : "isolated" as const;
  return {
    concurrency: 12,
    scope: [],
    systemPromptFragment: role?.systemPromptFragment ?? null,
    tools: [...(role?.tools ?? [])],
    worktree: value.worktree && typeof value.worktree === "object" ? "isolated" : configuredWorktree,
  };
};

const isThreadV1 = (value: unknown): value is ThreadCatalogV1["threads"][number] => (
  isRecord(value)
  && isLegacyReport(value.report)
  && isThread({ ...value, manifest: legacyLaunchManifest(value), model: null, report: null })
);

const isThreadV2 = (value: unknown): value is ThreadCatalogV2["threads"][number] => (
  isRecord(value) && isThread({ ...value, manifest: legacyLaunchManifest(value), model: null })
);

const isThreadV3 = (value: unknown): value is ThreadCatalogV3["threads"][number] => (
  isRecord(value) && isThread({ ...value, manifest: legacyLaunchManifest(value) })
);

const isThreadRun = (value: unknown): value is ThreadRun => {
  if (!isRecord(value)) return false;
  return isString(value.id)
    && isString(value.threadId)
    && Number.isSafeInteger(value.attempt)
    && Number(value.attempt) > 0
    && isString(value.runtimeId)
    && isNullableString(value.sessionId)
    && WORKER_STATES.has(value.workerState as ThreadRun["workerState"])
    && (value.outcome === null || OUTCOMES.has(value.outcome as ThreadRunOutcome))
    && isNullableString(value.exitReason)
    && isTokens(value.tokens)
    && (value.costUsd === null || isFiniteNumber(value.costUsd))
    && Number.isSafeInteger(value.steps)
    && (value.lastToolCall === null
      || (isRecord(value.lastToolCall) && isString(value.lastToolCall.name) && isString(value.lastToolCall.at)))
    && isString(value.startedAt)
    && isString(value.lastActivityAt)
    && isNullableString(value.endedAt);
};

const isLegacyThread = (value: unknown): value is LegacyThreadRecord => (
  isRecord(value)
  && isString(value.id)
  && isString(value.parentSessionId)
  && isString(value.sessionId)
  && (value.forkPoint === null || (isRecord(value.forkPoint) && isString(value.forkPoint.entryId)))
  && isString(value.brief)
  && isNullableString(value.role)
  && (value.createdBy === "user" || value.createdBy === "agent")
  && (value.kind === "discussion" || value.kind === "implementation")
  && (value.worktree === null || (isRecord(value.worktree) && isString(value.worktree.path) && isString(value.worktree.base)))
  && isString(value.status)
  && (value.flags === undefined || (isRecord(value.flags)
    && (value.flags.workerLost === undefined || typeof value.flags.workerLost === "boolean")
    && (value.flags.stalled === undefined || typeof value.flags.stalled === "boolean")
    && (value.flags.looping === undefined || typeof value.flags.looping === "boolean")))
  && isNullableString(value.exitReason)
  && isString(value.createdAt)
  && isString(value.updatedAt)
  && isString(value.lastActivityAt)
  && Number.isSafeInteger(value.eventSeq)
  && Number.isSafeInteger(value.steps)
  && isTokens(value.tokens)
  && isWaitingFor(value.waitingFor)
  && (value.costUsd === null || isFiniteNumber(value.costUsd))
  && (value.lastToolCall === null
    || (isRecord(value.lastToolCall) && isString(value.lastToolCall.name) && isString(value.lastToolCall.at)))
  && isDiffStats(value.diffStats)
  && isLegacyReport(value.report)
);

const parentEquals = (left: ThreadParent, right: ThreadParent): boolean => (
  left.kind === right.kind && left.id === right.id
);

const scopeKey = (workspaceId: string, parent: ThreadParent): string => (
  `${workspaceId}\0${parent.kind}\0${parent.id}`
);

const workspaceFileName = (workspaceId: string): string => (
  `${createHash("sha256").update(workspaceId).digest("hex")}.json`
);

export const threadCatalogPath = (dataDir: string, hostId: string, workspaceId: string): string => (
  join(dataDir, "threads", hostId, workspaceFileName(workspaceId))
);

const legacyThreadPath = (dataDir: string, hostId: string, parentSessionId: string): string | null => {
  const fileName = `${parentSessionId}.json`;
  return basename(fileName) === fileName ? join(dataDir, "threads", hostId, fileName) : null;
};

const emptyCatalog = (workspaceId: string): ThreadCatalogDocument => ({
  schemaVersion: THREAD_REGISTRY_SCHEMA_VERSION,
  workspaceId,
  threads: [],
  runs: [],
});

const catalogMaxEventSeq = (catalog: ThreadCatalogDocument): number => (
  catalog.threads.reduce((maximum, thread) => Math.max(maximum, thread.eventSeq), 0)
);

const parseJson = (raw: string, path: string): unknown => {
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new ThreadRegistryError("corrupt", `Thread registry JSON is malformed: ${path}`, path, { cause: error });
  }
};

const migrateLegacyReport = (report: LegacyThreadReport | null, sessionId: string): ThreadReport | null => (
  report
    ? {
        conclusion: report.conclusion,
        changedFiles: report.changedFiles,
        unresolved: report.unresolved,
        deviations: report.deviations,
        confidence: report.confidence,
        transcriptRef: {
          runtimeId: "pi",
          sessionId,
          fromEntryId: null,
          toEntryId: null,
        },
        blocksSnapshot: report.blocksSnapshot,
      }
    : null
);

const parseCatalog = (raw: string, path: string, expectedWorkspaceId?: string): ThreadCatalogDocument => {
  const value = parseJson(raw, path);
  if (!isRecord(value)) {
    throw new ThreadRegistryError("corrupt", `Thread registry catalog must be an object: ${path}`, path);
  }
  const schemaVersion = value.schemaVersion;
  if (typeof schemaVersion !== "number" || !Number.isSafeInteger(schemaVersion)) {
    throw new ThreadRegistryError("corrupt", `Thread registry schemaVersion is missing or invalid: ${path}`, path);
  }
  if (schemaVersion > THREAD_REGISTRY_SCHEMA_VERSION) {
    throw new ThreadRegistryError(
      "future-schema",
      `Thread registry schema ${schemaVersion} is newer than supported schema ${THREAD_REGISTRY_SCHEMA_VERSION}: ${path}`,
      path,
    );
  }
  if (schemaVersion !== 1 && schemaVersion !== 2 && schemaVersion !== 3 && schemaVersion !== THREAD_REGISTRY_SCHEMA_VERSION) {
    throw new ThreadRegistryError("corrupt", `Unsupported thread registry schema ${schemaVersion}: ${path}`, path);
  }
  if (!isString(value.workspaceId) || !Array.isArray(value.threads) || !Array.isArray(value.runs)) {
    throw new ThreadRegistryError("corrupt", `Thread registry catalog shape is invalid: ${path}`, path);
  }
  if (expectedWorkspaceId !== undefined && value.workspaceId !== expectedWorkspaceId) {
    throw new ThreadRegistryError("corrupt", `Thread registry workspace identity does not match its catalog: ${path}`, path);
  }
  if (!value.runs.every(isThreadRun)) {
    throw new ThreadRegistryError("corrupt", `Thread registry contains malformed run records: ${path}`, path);
  }
  let catalog: ThreadCatalogDocument;
  if (schemaVersion === 1) {
    if (!value.threads.every(isThreadV1)) {
      throw new ThreadRegistryError("corrupt", `Thread registry contains malformed v1 thread records: ${path}`, path);
    }
    const v1 = value as unknown as ThreadCatalogV1;
    catalog = {
      schemaVersion: THREAD_REGISTRY_SCHEMA_VERSION,
      workspaceId: v1.workspaceId,
      runs: structuredClone(v1.runs),
      threads: v1.threads.map((thread) => {
        const sessionId = thread.activeRunId === null
          ? ""
          : v1.runs.find((run) => run.id === thread.activeRunId)?.sessionId ?? "";
        return {
          ...structuredClone(thread),
          manifest: legacyLaunchManifest(thread as unknown as Record<string, unknown>),
          model: null,
          report: migrateLegacyReport(thread.report, sessionId),
        };
      }),
    };
  } else if (schemaVersion === 2) {
    if (!value.threads.every(isThreadV2)) {
      throw new ThreadRegistryError("corrupt", `Thread registry contains malformed v2 thread records: ${path}`, path);
    }
    const v2 = value as unknown as ThreadCatalogV2;
    catalog = {
      schemaVersion: THREAD_REGISTRY_SCHEMA_VERSION,
      workspaceId: v2.workspaceId,
      runs: structuredClone(v2.runs),
      threads: v2.threads.map((thread) => ({
        ...structuredClone(thread),
        manifest: legacyLaunchManifest(thread as unknown as Record<string, unknown>),
        model: null,
      })),
    };
  } else if (schemaVersion === 3) {
    if (!value.threads.every(isThreadV3)) {
      throw new ThreadRegistryError("corrupt", `Thread registry contains malformed v3 thread records: ${path}`, path);
    }
    const v3 = value as unknown as ThreadCatalogV3;
    catalog = {
      schemaVersion: THREAD_REGISTRY_SCHEMA_VERSION,
      workspaceId: v3.workspaceId,
      runs: structuredClone(v3.runs),
      threads: v3.threads.map((thread) => ({
        ...structuredClone(thread),
        manifest: legacyLaunchManifest(thread as unknown as Record<string, unknown>),
      })),
    };
  } else {
    if (!value.threads.every(isThread)) {
      throw new ThreadRegistryError("corrupt", `Thread registry contains malformed thread records: ${path}`, path);
    }
    catalog = value as unknown as ThreadCatalogDocument;
  }
  const threadIds = new Set<string>();
  for (const thread of catalog.threads) {
    if (thread.workspaceId !== catalog.workspaceId || threadIds.has(thread.id)) {
      throw new ThreadRegistryError("corrupt", `Thread registry contains duplicate or cross-workspace threads: ${path}`, path);
    }
    threadIds.add(thread.id);
  }
  const runIds = new Set<string>();
  const attempts = new Set<string>();
  for (const run of catalog.runs) {
    const attemptKey = `${run.threadId}\0${run.attempt}`;
    if (!threadIds.has(run.threadId) || runIds.has(run.id) || attempts.has(attemptKey)) {
      throw new ThreadRegistryError("corrupt", `Thread registry contains orphaned or duplicate runs: ${path}`, path);
    }
    runIds.add(run.id);
    attempts.add(attemptKey);
  }
  for (const thread of catalog.threads) {
    const activeRun = thread.activeRunId === null
      ? null
      : catalog.runs.find((run) => run.id === thread.activeRunId) ?? null;
    if (thread.activeRunId !== null && (!activeRun || activeRun.threadId !== thread.id)) {
      throw new ThreadRegistryError("corrupt", `Thread registry thread points to a missing active run: ${path}`, path);
    }
    if (
      ((thread.attention === "user" || thread.attention === "permission") && thread.waitingFor === null)
      || (thread.waitingFor !== null && thread.attention !== "user" && thread.attention !== "permission")
    ) {
      throw new ThreadRegistryError("corrupt", `Thread registry contains inconsistent attention state: ${path}`, path);
    }
  }
  for (const run of catalog.runs) {
    const active = run.workerState === "starting" || run.workerState === "running";
    const terminal = run.workerState === "lost" || run.workerState === "exited";
    if (
      (active && (run.outcome !== null || run.endedAt !== null))
      || (terminal && (run.outcome === null || run.endedAt === null))
      || (run.workerState === "lost" && run.outcome !== "lost")
      || (run.workerState === "exited" && run.outcome === "lost")
    ) {
      throw new ThreadRegistryError("corrupt", `Thread registry contains inconsistent run state: ${path}`, path);
    }
  }
  return structuredClone(catalog);
};

const legacyLifecycle = (status: string): ThreadLifecycle => {
  if (status === "queued") return "queued";
  if (status === "archived") return "archived";
  if (["done", "failed", "cancelled", "merged"].includes(status)) return "settled";
  return "active";
};

const legacyOutcome = (record: LegacyThreadRecord): ThreadRunOutcome | null => {
  if (record.flags?.workerLost) return "lost";
  if (record.status === "done" || record.status === "merged") return "success";
  if (record.status === "failed") return "failure";
  if (record.status === "cancelled" || record.status === "archived") return "cancelled";
  return null;
};

const convertLegacy = (workspaceId: string, records: LegacyThreadRecord[]): { threads: Thread[]; runs: ThreadRun[] } => {
  const threads: Thread[] = [];
  const runs: ThreadRun[] = [];
  for (const legacy of records) {
    const hasRun = legacy.sessionId.length > 0 || !["queued", "idle"].includes(legacy.status);
    const runId = hasRun ? `run-${randomUUID()}` : null;
    const outcome = legacyOutcome(legacy);
    const workerState: ThreadRun["workerState"] = outcome === "lost"
      ? "lost"
      : outcome === null
        ? "running"
        : "exited";
    let attention: ThreadAttention = "none";
    if (legacy.waitingFor?.kind === "permission") attention = "permission";
    else if (legacy.waitingFor) attention = "user";
    else if (legacy.flags?.looping) attention = "looping";
    else if (legacy.flags?.stalled) attention = "stalled";
    const integration: ThreadIntegration = legacy.status === "merged"
      ? "merged"
      : legacy.diffStats && legacy.diffStats.files > 0
        ? legacy.status === "done" ? "merge-ready" : "dirty"
        : "none";
    const migratedReport = migrateLegacyReport(legacy.report, legacy.sessionId);
    threads.push({
      id: legacy.id,
      parent: { kind: "session", id: legacy.parentSessionId },
      workspaceId,
      forkPoint: legacy.forkPoint ?? null,
      brief: legacy.brief,
      role: legacy.role ?? null,
      model: null,
      manifest: legacyLaunchManifest(legacy as unknown as Record<string, unknown>),
      createdBy: legacy.createdBy === "user" ? "user" : "agent",
      kind: legacy.kind === "discussion" ? "discussion" : "implementation",
      worktree: legacy.worktree ?? null,
      lifecycle: legacyLifecycle(legacy.status),
      attention,
      waitingFor: legacy.waitingFor ?? null,
      integration,
      diffStats: legacy.diffStats ?? null,
      report: migratedReport,
      activeRunId: runId,
      createdAt: legacy.createdAt,
      updatedAt: legacy.updatedAt,
      eventSeq: legacy.eventSeq,
      hidden: legacy.hidden ?? false,
    });
    if (runId) {
      runs.push({
        id: runId,
        threadId: legacy.id,
        attempt: 1,
        runtimeId: "pi",
        sessionId: legacy.sessionId || null,
        workerState,
        outcome,
        exitReason: legacy.exitReason ?? null,
        tokens: legacy.tokens,
        costUsd: legacy.costUsd ?? null,
        steps: legacy.steps,
        lastToolCall: legacy.lastToolCall ?? null,
        startedAt: legacy.createdAt,
        lastActivityAt: legacy.lastActivityAt || legacy.updatedAt,
        endedAt: outcome === null ? null : legacy.updatedAt,
      });
    }
  }
  return { threads, runs };
};

export function createThreadRegistry(options: ThreadRegistryOptions) {
  const { dataDir, hostId } = options;
  const fsPromises = options.fsPromises ?? fs.promises;
  const now = options.now ?? (() => new Date());
  const maxConcurrency = options.maxConcurrency ?? 12;
  const cache = new Map<string, ThreadCatalogDocument>();
  const loads = new Map<string, Promise<ThreadCatalogDocument>>();
  const mutationTails = new Map<string, Promise<void>>();
  const legacyImports = new Set<string>();
  const cursors = new Map<string, ThreadViewCursor>();
  const waiters = new Map<string, Set<() => void>>();
  const draining = new Set<string>();
  const retiredParents = new Set<string>();
  const dequeueing = new Set<string>();
  let persistCounter = 0;

  const nowISO = (): string => now().toISOString();

  const readText = async (path: string): Promise<string | null> => {
    try {
      return await fsPromises.readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new ThreadRegistryError("read-failed", `Unable to read thread registry: ${path}`, path, { cause: error });
    }
  };

  const loadWorkspace = async (workspaceId: string): Promise<ThreadCatalogDocument> => {
    const cached = cache.get(workspaceId);
    if (cached) return cached;
    const pending = loads.get(workspaceId);
    if (pending) return pending;
    const path = threadCatalogPath(dataDir, hostId, workspaceId);
    const loading = (async () => {
      const raw = await readText(path);
      const catalog = raw === null ? emptyCatalog(workspaceId) : parseCatalog(raw, path, workspaceId);
      cache.set(workspaceId, catalog);
      return catalog;
    })();
    loads.set(workspaceId, loading);
    try {
      return await loading;
    } finally {
      loads.delete(workspaceId);
    }
  };

  const writeCatalog = async (catalog: ThreadCatalogDocument): Promise<void> => {
    const path = threadCatalogPath(dataDir, hostId, catalog.workspaceId);
    const directory = join(dataDir, "threads", hostId);
    persistCounter += 1;
    const temporary = `${path}.${process.pid}.${persistCounter}.tmp`;
    try {
      await fsPromises.mkdir(directory, { recursive: true });
      await fsPromises.writeFile(temporary, JSON.stringify(catalog, null, 2), "utf8");
      await fsPromises.rename(temporary, path);
    } catch (error) {
      await fsPromises.rm(temporary, { force: true }).catch(() => undefined);
      throw new ThreadRegistryError("write-failed", `Unable to persist thread registry: ${path}`, path, { cause: error });
    }
  };

  const activeRunFor = (catalog: ThreadCatalogDocument, thread: Thread): ThreadRun | null => (
    thread.activeRunId === null
      ? null
      : catalog.runs.find((run) => run.id === thread.activeRunId) ?? null
  );

  const reportObserverError = (error: unknown): void => {
    try { options.onObserverError?.(error); } catch { /* Observers cannot break registry authority. */ }
  };

  const emitChanges = (catalog: ThreadCatalogDocument, mutation: MutationResult<unknown>): void => {
    for (const thread of mutation.changed) {
      try {
        options.onThreadChanged?.(catalog.workspaceId, thread.parent, structuredClone(thread), structuredClone(activeRunFor(catalog, thread)));
      } catch (error) {
        reportObserverError(error);
      }
      const done = mutation.done?.find((entry) => entry.thread.id === thread.id);
      if (done) {
        try {
          options.onThreadDone?.(catalog.workspaceId, thread.parent, thread.id, structuredClone(done.report));
        } catch (error) {
          reportObserverError(error);
        }
      }
      const callbacks = waiters.get(scopeKey(catalog.workspaceId, thread.parent));
      if (callbacks) {
        for (const callback of callbacks) {
          try { callback(); } catch (error) { reportObserverError(error); }
        }
        callbacks.clear();
      }
    }
    for (const parent of mutation.wakeParents ?? []) {
      const callbacks = waiters.get(scopeKey(catalog.workspaceId, parent));
      if (!callbacks) continue;
      for (const callback of callbacks) {
        try { callback(); } catch (error) { reportObserverError(error); }
      }
      callbacks.clear();
    }
  };

  const mutateWorkspace = async <T>(
    workspaceId: string,
    mutate: (catalog: ThreadCatalogDocument) => MutationResult<T>,
  ): Promise<T> => {
    const previous = mutationTails.get(workspaceId) ?? Promise.resolve();
    let value!: T;
    const operation = previous.then(async () => {
      const current = await loadWorkspace(workspaceId);
      const draft = structuredClone(current);
      const mutation = mutate(draft);
      value = mutation.value;
      if (mutation.write !== false) {
        await writeCatalog(draft);
        cache.set(workspaceId, draft);
        emitChanges(draft, mutation);
      }
    });
    mutationTails.set(workspaceId, operation.then(() => undefined, () => undefined));
    await operation;
    return structuredClone(value);
  };

  const nextEventSeq = (catalog: ThreadCatalogDocument): number => catalogMaxEventSeq(catalog) + 1;

  const ensureLegacyParent = async (workspaceId: string, parent: ThreadParent): Promise<void> => {
    if (parent.kind !== "session") return;
    const key = scopeKey(workspaceId, parent);
    if (legacyImports.has(key)) return;
    const current = await loadWorkspace(workspaceId);
    if (current.threads.some((thread) => parentEquals(thread.parent, parent))) {
      legacyImports.add(key);
      return;
    }
    const path = legacyThreadPath(dataDir, hostId, parent.id);
    if (!path || path === threadCatalogPath(dataDir, hostId, workspaceId)) {
      legacyImports.add(key);
      return;
    }
    const raw = await readText(path);
    if (raw === null) {
      legacyImports.add(key);
      return;
    }
    const parsed = parseJson(raw, path);
    if (!Array.isArray(parsed) || !parsed.every(isLegacyThread)) {
      throw new ThreadRegistryError("corrupt", `Legacy thread registry is malformed: ${path}`, path);
    }
    const converted = convertLegacy(workspaceId, parsed);
    await mutateWorkspace(workspaceId, (catalog) => {
      const existingThreadIds = new Set(catalog.threads.map((thread) => thread.id));
      const importedThreads = converted.threads.filter((thread) => !existingThreadIds.has(thread.id));
      const importedIds = new Set(importedThreads.map((thread) => thread.id));
      catalog.threads.push(...importedThreads);
      catalog.runs.push(...converted.runs.filter((run) => importedIds.has(run.threadId)));
      return { value: undefined, changed: importedThreads, write: importedThreads.length > 0 };
    });
    legacyImports.add(key);
  };

  const catalogForScope = async (workspaceId: string, parent: ThreadParent): Promise<ThreadCatalogDocument> => {
    await ensureLegacyParent(workspaceId, parent);
    return loadWorkspace(workspaceId);
  };

  const findThread = (catalog: ThreadCatalogDocument, threadId: string): Thread | null => (
    catalog.threads.find((thread) => thread.id === threadId) ?? null
  );

  const findThreadInScope = (catalog: ThreadCatalogDocument, parent: ThreadParent, threadId: string): Thread | null => {
    const thread = findThread(catalog, threadId);
    return thread && parentEquals(thread.parent, parent) ? thread : null;
  };

  const touchThread = (catalog: ThreadCatalogDocument, thread: Thread): void => {
    thread.updatedAt = nowISO();
    thread.eventSeq = nextEventSeq(catalog);
  };

  const createThread = async (input: CreateThreadInput): Promise<Thread> => {
    const key = scopeKey(input.workspaceId, input.parent);
    if (draining.has(key) || retiredParents.has(key)) {
      throw new Error("Cannot create a thread while its parent is being deleted");
    }
    await ensureLegacyParent(input.workspaceId, input.parent);
    return mutateWorkspace(input.workspaceId, (catalog) => {
      if (draining.has(key) || retiredParents.has(key)) {
        throw new Error("Cannot create a thread after its parent entered deletion");
      }
      const timestamp = nowISO();
      const thread: Thread = {
        id: `thread-${randomUUID().slice(0, 8)}`,
        parent: structuredClone(input.parent),
        workspaceId: input.workspaceId,
        forkPoint: input.forkPoint ?? null,
        brief: input.brief,
        role: input.role ?? null,
        model: input.model ?? null,
        manifest: {
          concurrency: input.concurrency,
          scope: [...(input.scope ?? [])],
          systemPromptFragment: input.systemPromptFragment ?? null,
          tools: [...new Set(input.tools)],
          worktree: input.worktree,
        },
        createdBy: input.createdBy,
        kind: input.kind,
        worktree: null,
        lifecycle: input.autoRun ? "queued" : "active",
        attention: "none",
        waitingFor: null,
        integration: "none",
        diffStats: null,
        report: null,
        activeRunId: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        eventSeq: nextEventSeq(catalog),
        hidden: input.hidden ?? false,
      };
      catalog.threads.push(thread);
      return { value: thread, changed: [thread] };
    });
  };

  const getThread = async (workspaceId: string, parent: ThreadParent, threadId: string): Promise<Thread | null> => {
    const catalog = await catalogForScope(workspaceId, parent);
    return structuredClone(findThreadInScope(catalog, parent, threadId));
  };

  const listThreads = async (workspaceId: string, parent: ThreadParent, includeHidden = false): Promise<Thread[]> => {
    const catalog = await catalogForScope(workspaceId, parent);
    return structuredClone(catalog.threads.filter((thread) => (
      parentEquals(thread.parent, parent) && (includeHidden || !thread.hidden)
    )));
  };

  const getActiveRun = async (workspaceId: string, threadId: string): Promise<ThreadRun | null> => {
    const catalog = await loadWorkspace(workspaceId);
    const thread = findThread(catalog, threadId);
    return structuredClone(thread ? activeRunFor(catalog, thread) : null);
  };

  const listRuns = async (workspaceId: string, threadId: string): Promise<ThreadRun[]> => {
    const catalog = await loadWorkspace(workspaceId);
    return structuredClone(catalog.runs.filter((run) => run.threadId === threadId).toSorted((a, b) => a.attempt - b.attempt));
  };

  const countActive = async (workspaceId: string, parent: ThreadParent): Promise<number> => {
    const catalog = await catalogForScope(workspaceId, parent);
    return catalog.threads.filter((thread) => {
      if (!parentEquals(thread.parent, parent) || thread.lifecycle !== "active") return false;
      const run = activeRunFor(catalog, thread);
      return run?.workerState === "starting" || run?.workerState === "running";
    }).length;
  };

  const startRun = async (workspaceId: string, threadId: string, runtimeId = "pi"): Promise<ThreadRun> => (
    mutateWorkspace(workspaceId, (catalog) => {
      const thread = findThread(catalog, threadId);
      if (!thread) throw new Error(`Unknown thread: ${threadId}`);
      const parentKey = scopeKey(workspaceId, thread.parent);
      if (draining.has(parentKey) || retiredParents.has(parentKey)) {
        throw new Error("Cannot start a thread while its parent is being deleted");
      }
      const current = activeRunFor(catalog, thread);
      if (current?.workerState === "starting" || current?.workerState === "running") {
        throw new Error(`Thread already has an active run: ${threadId}`);
      }
      if (thread.lifecycle === "settled" || thread.lifecycle === "archived") {
        throw new Error(`Cannot start a run for ${thread.lifecycle} thread: ${threadId}`);
      }
      const attempt = catalog.runs
        .filter((run) => run.threadId === threadId)
        .reduce((maximum, run) => Math.max(maximum, run.attempt), 0) + 1;
      const timestamp = nowISO();
      const run: ThreadRun = {
        id: `run-${randomUUID()}`,
        threadId,
        attempt,
        runtimeId,
        sessionId: null,
        workerState: "starting",
        outcome: null,
        exitReason: null,
        tokens: { input: 0, output: 0, cacheRead: 0 },
        costUsd: null,
        steps: 0,
        lastToolCall: null,
        startedAt: timestamp,
        lastActivityAt: timestamp,
        endedAt: null,
      };
      catalog.runs.push(run);
      thread.activeRunId = run.id;
      thread.lifecycle = "active";
      touchThread(catalog, thread);
      return { value: run, changed: [thread] };
    })
  );

  const markRunRunning = async (
    workspaceId: string,
    threadId: string,
    runId: string,
    sessionId: string,
  ): Promise<ThreadRun> => mutateWorkspace(workspaceId, (catalog) => {
    const thread = findThread(catalog, threadId);
    const run = catalog.runs.find((candidate) => candidate.id === runId && candidate.threadId === threadId);
    if (!thread || !run || thread.activeRunId !== runId) throw new Error(`Unknown active run: ${runId}`);
    if (run.workerState !== "starting" && run.workerState !== "running") {
      throw new Error(`Cannot mark ${run.workerState} run as running: ${runId}`);
    }
    run.workerState = "running";
    run.sessionId = sessionId;
    run.lastActivityAt = nowISO();
    touchThread(catalog, thread);
    return { value: run, changed: [thread] };
  });

  const maybeDequeue = async (workspaceId: string, parent: ThreadParent): Promise<void> => {
    const key = scopeKey(workspaceId, parent);
    if (draining.has(key)) return;
    await tryDequeue(workspaceId, parent);
  };

  const endRun = async (
    workspaceId: string,
    threadId: string,
    runId: string,
    outcome: ThreadRunOutcome,
    exitReason: string | null = null,
    report: ThreadReport | null = null,
  ): Promise<Thread> => {
    const result = await mutateWorkspace(workspaceId, (catalog) => {
      const thread = findThread(catalog, threadId);
      const run = catalog.runs.find((candidate) => candidate.id === runId && candidate.threadId === threadId);
      if (!thread || !run || thread.activeRunId !== runId) throw new Error(`Unknown active run: ${runId}`);
      if (run.outcome !== null) {
        if (run.outcome !== outcome) throw new Error(`Run already ended as ${run.outcome}: ${runId}`);
        return { value: thread, changed: [], write: false };
      }
      run.workerState = outcome === "lost" ? "lost" : "exited";
      run.outcome = outcome;
      run.exitReason = exitReason;
      run.endedAt = nowISO();
      run.lastActivityAt = run.endedAt;
      thread.lifecycle = outcome === "lost" ? "active" : "settled";
      if (report) {
        thread.report = report;
        if (thread.integration === "none" && report.changedFiles.length > 0) thread.integration = "merge-ready";
      }
      touchThread(catalog, thread);
      return {
        value: thread,
        changed: [thread],
        ...(outcome === "success" && report ? { done: [{ thread, report }] } : {}),
      };
    });
    await maybeDequeue(workspaceId, result.parent).catch(reportObserverError);
    return result;
  };

  const updateRunProgress = async (
    workspaceId: string,
    threadId: string,
    progress: {
      steps?: number;
      tokens?: Partial<ThreadTokens>;
      lastToolCall?: { name: string; at: string };
      diffStats?: ThreadDiffStats;
      costUsd?: number;
    },
  ): Promise<Thread | null> => mutateWorkspace(workspaceId, (catalog) => {
    const thread = findThread(catalog, threadId);
    if (!thread) return { value: null, changed: [], write: false };
    const run = activeRunFor(catalog, thread);
    if (!run) throw new Error(`Thread has no active run: ${threadId}`);
    run.steps = progress.steps ?? run.steps;
    run.tokens = { ...run.tokens, ...(progress.tokens ?? {}) };
    run.lastToolCall = progress.lastToolCall ?? run.lastToolCall;
    run.costUsd = progress.costUsd ?? run.costUsd;
    run.lastActivityAt = nowISO();
    thread.diffStats = progress.diffStats ?? thread.diffStats;
    if (thread.diffStats && thread.diffStats.files > 0 && thread.integration === "none") thread.integration = "dirty";
    touchThread(catalog, thread);
    return { value: thread, changed: [thread] };
  });

  const setAttention = async (
    workspaceId: string,
    threadId: string,
    attention: ThreadAttention,
    waitingFor: ThreadWaitingFor | null = null,
  ): Promise<Thread | null> => mutateWorkspace(workspaceId, (catalog) => {
    const thread = findThread(catalog, threadId);
    if (!thread) return { value: null, changed: [], write: false };
    if ((attention === "user" || attention === "permission") && waitingFor === null) {
      throw new Error(`${attention} attention requires waitingFor details`);
    }
    thread.attention = attention;
    thread.waitingFor = waitingFor;
    touchThread(catalog, thread);
    return { value: thread, changed: [thread] };
  });

  const setIntegration = async (
    workspaceId: string,
    threadId: string,
    integration: ThreadIntegration,
    diffStats?: ThreadDiffStats | null,
  ): Promise<Thread | null> => mutateWorkspace(workspaceId, (catalog) => {
    const thread = findThread(catalog, threadId);
    if (!thread) return { value: null, changed: [], write: false };
    thread.integration = integration;
    if (diffStats !== undefined) thread.diffStats = diffStats;
    touchThread(catalog, thread);
    return { value: thread, changed: [thread] };
  });

  const setWorktree = async (workspaceId: string, threadId: string, worktree: ThreadWorktree): Promise<Thread | null> => (
    mutateWorkspace(workspaceId, (catalog) => {
      const thread = findThread(catalog, threadId);
      if (!thread) return { value: null, changed: [], write: false };
      thread.worktree = worktree;
      touchThread(catalog, thread);
      return { value: thread, changed: [thread] };
    })
  );

  const completeThread = async (
    workspaceId: string,
    threadId: string,
    report: ThreadReport,
  ): Promise<Thread | null> => {
    const catalog = await loadWorkspace(workspaceId);
    const thread = findThread(catalog, threadId);
    if (!thread) return null;
    if (thread.lifecycle === "settled" && thread.report) return structuredClone(thread);
    if (!thread.activeRunId) throw new Error(`Thread has no active run: ${threadId}`);
    return endRun(workspaceId, threadId, thread.activeRunId, "success", null, report);
  };

  const cancelThread = async (workspaceId: string, threadId: string, exitReason = "cancelled by user or parent"): Promise<Thread | null> => {
    const catalog = await loadWorkspace(workspaceId);
    const thread = findThread(catalog, threadId);
    if (!thread) return null;
    const run = activeRunFor(catalog, thread);
    if (run && run.outcome === null) return endRun(workspaceId, threadId, run.id, "cancelled", exitReason);
    const result = await mutateWorkspace(workspaceId, (draft) => {
      const candidate = findThread(draft, threadId);
      if (!candidate) return { value: null, changed: [], write: false };
      candidate.lifecycle = "settled";
      candidate.attention = "none";
      candidate.waitingFor = null;
      touchThread(draft, candidate);
      return { value: candidate, changed: [candidate] };
    });
    if (result) await maybeDequeue(workspaceId, result.parent).catch(reportObserverError);
    return result;
  };

  const archiveThread = async (workspaceId: string, threadId: string): Promise<Thread | null> => (
    mutateWorkspace(workspaceId, (catalog) => {
      const thread = findThread(catalog, threadId);
      if (!thread) return { value: null, changed: [], write: false };
      thread.lifecycle = "archived";
      touchThread(catalog, thread);
      return { value: thread, changed: [thread] };
    })
  );

  const archiveThreadsForDeletedSession = async (
    workspaceId: string,
    sessionId: string,
  ): Promise<Thread[]> => mutateWorkspace(workspaceId, (catalog) => {
    const timestamp = nowISO();
    const affectedIds = new Set(
      catalog.runs.filter((run) => run.sessionId === sessionId).map((run) => run.threadId),
    );
    const changed: Thread[] = [];
    for (const threadId of affectedIds) {
      const thread = findThread(catalog, threadId);
      if (!thread) continue;
      const activeRun = activeRunFor(catalog, thread);
      if (activeRun?.sessionId === sessionId && activeRun.outcome === null) {
        activeRun.workerState = "exited";
        activeRun.outcome = "cancelled";
        activeRun.exitReason = "thread session deleted by user";
        activeRun.endedAt = timestamp;
        activeRun.lastActivityAt = timestamp;
      }
      thread.lifecycle = "archived";
      thread.attention = "none";
      thread.waitingFor = null;
      // The report's TranscriptRef points at the file being deleted. Retaining
      // it would turn an intentional deletion into a durable broken reference.
      thread.report = null;
      touchThread(catalog, thread);
      changed.push(thread);
    }
    return { value: changed, changed, write: changed.length > 0 };
  });

  const convertThread = async (workspaceId: string, threadId: string): Promise<Thread | null> => (
    mutateWorkspace(workspaceId, (catalog) => {
      const thread = findThread(catalog, threadId);
      if (!thread) return { value: null, changed: [], write: false };
      thread.kind = "implementation";
      touchThread(catalog, thread);
      return { value: thread, changed: [thread] };
    })
  );

  const mergeThread = async (workspaceId: string, threadId: string): Promise<Thread | null> => (
    setIntegration(workspaceId, threadId, "merged")
  );

  const cancelAllForParent = async (
    workspaceId: string,
    parent: ThreadParent,
    stopActive?: (thread: Thread) => Promise<void>,
  ): Promise<void> => {
    const key = scopeKey(workspaceId, parent);
    draining.add(key);
    try {
      const threads = await listThreads(workspaceId, parent, true);
      for (const thread of threads) {
        if (thread.lifecycle === "queued" || thread.lifecycle === "active") {
          if (thread.lifecycle === "active") await stopActive?.(thread);
          await cancelThread(workspaceId, thread.id, "parent session deleted");
        }
        await archiveThread(workspaceId, thread.id);
      }
      retiredParents.add(key);
    } finally {
      draining.delete(key);
    }
  };

  const deleteThread = async (workspaceId: string, parent: ThreadParent, threadId: string): Promise<boolean> => (
    mutateWorkspace(workspaceId, (catalog) => {
      const index = catalog.threads.findIndex((thread) => thread.id === threadId && parentEquals(thread.parent, parent));
      if (index < 0) return { value: false, changed: [], write: false };
      catalog.threads.splice(index, 1);
      catalog.runs = catalog.runs.filter((run) => run.threadId !== threadId);
      for (const key of cursors.keys()) if (key.endsWith(`\0${threadId}`)) cursors.delete(key);
      return { value: true, changed: [], wakeParents: [parent] };
    })
  );

  const cursorKey = (observerSessionId: string, threadId: string): string => `${observerSessionId}\0${threadId}`;
  const getCursor = (observerSessionId: string, threadId: string): ThreadViewCursor | null => (
    structuredClone(cursors.get(cursorKey(observerSessionId, threadId)) ?? null)
  );
  const setCursor = (observerSessionId: string, threadId: string, cursor: ThreadViewCursor): void => {
    cursors.set(cursorKey(observerSessionId, threadId), structuredClone(cursor));
  };
  const clearCursorsForSession = (observerSessionId: string): void => {
    for (const key of cursors.keys()) if (key.startsWith(`${observerSessionId}\0`)) cursors.delete(key);
  };

  const subscribeToChanges = (workspaceId: string, parent: ThreadParent, callback: () => void): (() => void) => {
    const key = scopeKey(workspaceId, parent);
    let callbacks = waiters.get(key);
    if (!callbacks) {
      callbacks = new Set();
      waiters.set(key, callbacks);
    }
    callbacks.add(callback);
    return () => {
      callbacks?.delete(callback);
      if (callbacks?.size === 0) waiters.delete(key);
    };
  };

  async function tryDequeue(workspaceId: string, parent: ThreadParent): Promise<Thread | null> {
    const key = scopeKey(workspaceId, parent);
    if (dequeueing.has(key)) return null;
    const catalog = await catalogForScope(workspaceId, parent);
    const next = catalog.threads
      .filter((thread) => parentEquals(thread.parent, parent) && thread.lifecycle === "queued")
      .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt))[0] ?? null;
    if (next && await countActive(workspaceId, parent) >= next.manifest.concurrency) return null;
    if (!next || !options.onThreadDequeued) return structuredClone(next);
    dequeueing.add(key);
    try {
      await options.onThreadDequeued(workspaceId, parent, structuredClone(next));
      return structuredClone(next);
    } finally {
      dequeueing.delete(key);
    }
  }

  const reconcileWorkspace = async (
    workspaceId: string,
    activeSessionIds: ReadonlySet<string> = new Set(),
  ): Promise<number> => mutateWorkspace(workspaceId, (catalog) => {
    let reconciled = 0;
    const changed: Thread[] = [];
    for (const run of catalog.runs) {
      if (run.workerState !== "starting" && run.workerState !== "running") continue;
      if (run.sessionId && activeSessionIds.has(run.sessionId)) continue;
      run.workerState = "lost";
      run.outcome = "lost";
      run.exitReason = "host restarted";
      run.endedAt = nowISO();
      run.lastActivityAt = run.endedAt;
      const thread = findThread(catalog, run.threadId);
      if (thread) {
        thread.lifecycle = "active";
        touchThread(catalog, thread);
        changed.push(thread);
      }
      reconciled += 1;
    }
    return { value: reconciled, changed, write: reconciled > 0 };
  });

  const reconcileAfterHostRestart = async (): Promise<ThreadRegistryReconcileResult> => {
    const directory = join(dataDir, "threads", hostId);
    let entries: fs.Dirent<string>[];
    try {
      entries = await fsPromises.readdir(directory, { withFileTypes: true, encoding: "utf8" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { failures: [], legacyFilesSkipped: 0, reconciledRuns: 0, workspaces: 0 };
      }
      const failure = new ThreadRegistryError("read-failed", `Unable to enumerate thread registries: ${directory}`, directory, { cause: error });
      return {
        failures: [{ code: failure.code, message: failure.message, path: failure.path }],
        legacyFilesSkipped: 0,
        reconciledRuns: 0,
        workspaces: 0,
      };
    }
    const failures: ThreadRegistryReconcileFailure[] = [];
    let legacyFilesSkipped = 0;
    let reconciledRuns = 0;
    let workspaces = 0;
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const path = join(directory, entry.name);
      try {
        const raw = await readText(path);
        if (raw === null) continue;
        const parsed = parseJson(raw, path);
        if (Array.isArray(parsed)) {
          legacyFilesSkipped += 1;
          continue;
        }
        const catalog = parseCatalog(raw, path);
        const expectedPath = threadCatalogPath(dataDir, hostId, catalog.workspaceId);
        if (expectedPath !== path) {
          throw new ThreadRegistryError("corrupt", `Thread registry filename does not match its workspace identity: ${path}`, path);
        }
        cache.set(catalog.workspaceId, catalog);
        workspaces += 1;
        reconciledRuns += await reconcileWorkspace(catalog.workspaceId);
      } catch (error) {
        const failure = error instanceof ThreadRegistryError
          ? error
          : new ThreadRegistryError("read-failed", `Unable to inspect thread registry: ${path}`, path, { cause: error });
        failures.push({ code: failure.code, message: failure.message, path: failure.path });
      }
    }
    return { failures, legacyFilesSkipped, reconciledRuns, workspaces };
  };

  const dispose = async (): Promise<void> => {
    await Promise.allSettled(mutationTails.values());
    waiters.clear();
    cursors.clear();
    cache.clear();
    retiredParents.clear();
  };

  return {
    createThread,
    getThread,
    listThreads,
    getActiveRun,
    listRuns,
    countActive,
    startRun,
    markRunRunning,
    endRun,
    updateRunProgress,
    setAttention,
    setIntegration,
    setWorktree,
    completeThread,
    cancelThread,
    archiveThread,
    archiveThreadsForDeletedSession,
    convertThread,
    mergeThread,
    cancelAllForParent,
    deleteThread,
    getCursor,
    setCursor,
    clearCursorsForSession,
    subscribeToChanges,
    tryDequeue,
    reconcileWorkspace,
    reconcileAfterHostRestart,
    dispose,
    maxConcurrency,
  };
}

export type ThreadRegistry = ReturnType<typeof createThreadRegistry>;
