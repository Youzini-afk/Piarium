/**
 * Experiment execution on durable kernel records (7C/7D-1, D-300).
 *
 * Flow: intent → spec/attempt records → resource admission → kernel process
 * (job record) → exit facts → collected artifacts. The process identity is
 * derived from the attempt id, so a lost submit response or a Host restart can
 * reconcile by asking the kernel whether that exact process exists — a retry
 * never starts a second copy.
 *
 * Attempt state and collection state are separate facts: a finished experiment
 * whose artifacts failed to copy stays completed/failed with
 * collection:"failed" and can be re-collected without re-running.
 */
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { KernelClient, KernelScopedClient } from "../kernel/kernel-client.js";
import type { KernelProcessSnapshot, KernelRecordResult } from "../kernel/protocol.generated.js";
import type {
  ExperimentArtifactState,
  ExperimentArtifactView,
  ExperimentAttemptState,
  ExperimentAttemptView,
  ExperimentCollectResult,
  ExperimentGetResult,
  ExperimentInputRef,
  ExperimentJobState,
  ExperimentJobView,
  ExperimentListResult,
  ExperimentLogsResult,
  ExperimentResourceRequest,
  ExperimentSpecView,
  ExperimentSubmitParams,
} from "@piarium/protocol";
import { canonicalizePathIdentity } from "../workspace/path-safety.js";
import { HarnessServiceError } from "./service-error.js";
import type { ResourceService } from "./resources.js";
import type { SourceService } from "./sources.js";

const SPEC_PREFIX = "experiment.spec:";
const ATTEMPT_PREFIX = "experiment.attempt:";
const JOB_PREFIX = "experiment.job:";
const ARTIFACT_PREFIX = "experiment.artifact:";
const LOCAL_MACHINE_ID = "local";
const MAX_STREAM_BYTES = 8 * 1024 * 1024;
const POLL_MS = 25;
const TERMINAL: ReadonlySet<ExperimentAttemptState> = new Set(["completed", "failed", "cancelled", "lost"]);

export const isTerminalAttemptState = (state: ExperimentAttemptState): boolean => TERMINAL.has(state);

export interface ExperimentCaller {
  /** Workspace that owns the durable records and resource facts. */
  workspaceId: string;
  /** The actor's execution workspace (may differ for isolated branches). */
  executionWorkspaceId: string;
  sessionId?: string;
  threadId?: string;
  runId?: string;
  /** Restricted child-Run path scopes (owning-root relative). */
  workspaceScope?: readonly string[];
}

interface ExperimentContext {
  scoped: KernelScopedClient;
  rootId: string;
  canonicalRoot: string;
}

// Host-internal service grant: same trust level as the native process host.
// `storage.maintenance` (not `storage.admin`) is the narrowest capability that
// lets an unbound service grant write records carrying caller attribution
// (sessionId/threadId/runId) and read them back across actors — it grants no
// cross-workspace authority. `process.maintenance` covers inspecting and
// stopping jobs owned by an earlier grant after a Host restart.
const SERVICE_CAPABILITIES = ["storage.read", "storage.write", "storage.maintenance", "process", "process.maintenance"];

interface RunningJob {
  processId: string;
  cursor: number;
  buffers: Record<"stdout" | "stderr", Buffer[]>;
  totals: Record<"stdout" | "stderr", number>;
  truncated: Record<"stdout" | "stderr", boolean>;
  poll: Promise<void>;
  cancelRequested: boolean;
}

interface ExperimentServiceDeps {
  client: KernelClient;
  resources: ResourceService;
  sources?: SourceService;
  /** Resolve the owning workspace's canonical root (default experiment cwd). */
  resolveWorkspaceRoot: (workspaceId: string) => Promise<string | null>;
  now?: () => number;
  onError?: (error: Error) => void;
}

const payloadOf = (record: KernelRecordResult): Record<string, unknown> => {
  try {
    const parsed = JSON.parse(record.payloadJson) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
};

const num = (value: unknown): number | undefined => (
  typeof value === "number" && Number.isFinite(value) ? value : undefined
);

const str = (value: unknown): string | undefined => (
  typeof value === "string" && value ? value : undefined
);

const strArray = (value: unknown): string[] => (
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
);

const recordIdFor = {
  spec: (id: string) => `${SPEC_PREFIX}${id}`,
  attempt: (id: string) => `${ATTEMPT_PREFIX}${id}`,
  job: (id: string) => `${JOB_PREFIX}${id}`,
  artifact: (id: string) => `${ARTIFACT_PREFIX}${id}`,
};

const processIdFor = (attemptId: string) => `experiment-${attemptId}`.slice(0, 200);
const jobIdFor = (attemptId: string) => `job-${attemptId}`.slice(0, 160);
const attemptIdForRequest = (requestId: string) => `attempt-${requestId.replace(/[^A-Za-z0-9_-]/g, "-")}`.slice(0, 160);

const specView = (record: KernelRecordResult): ExperimentSpecView | null => {
  const payload = payloadOf(record);
  const specId = str(payload.id);
  const command = str(payload.command);
  if (!specId || !command) return null;
  const inputs = Array.isArray(payload.inputs)
    ? payload.inputs.flatMap((input): ExperimentInputRef[] => {
        if (!input || typeof input !== "object") return [];
        const raw = input as Record<string, unknown>;
        const sourceId = str(raw.sourceId);
        const inputPath = str(raw.path);
        const objectHash = str(raw.objectHash);
        const role = str(raw.role);
        return [{
          ...(sourceId ? { sourceId } : {}),
          ...(inputPath ? { path: inputPath } : {}),
          ...(objectHash ? { objectHash } : {}),
          ...(role ? { role } : {}),
        }];
      })
    : [];
  const title = str(payload.title);
  const cwd = str(payload.cwd);
  return {
    specId,
    ...(title ? { title } : {}),
    command,
    args: strArray(payload.args),
    ...(cwd ? { cwd } : {}),
    inputs,
    ...(payload.resources && typeof payload.resources === "object"
      ? { resources: payload.resources as ExperimentResourceRequest }
      : {}),
    outputPaths: strArray(payload.outputPaths),
    state: record.state === "retired" ? "retired" : "active",
    revision: record.recordRevision,
    createdAt: record.createdAt,
  };
};

const attemptView = (record: KernelRecordResult): ExperimentAttemptView | null => {
  const payload = payloadOf(record);
  const attemptId = str(payload.id);
  const specId = str(payload.specId);
  if (!attemptId || !specId) return null;
  const machineId = str(payload.machineId);
  const signal = str(payload.signal);
  const error = str(payload.error);
  const queueReason = str(payload.queueReason);
  const requestId = str(payload.requestId);
  const exitCode = num(payload.exitCode);
  const startedAt = num(payload.startedAt);
  const endedAt = num(payload.endedAt);
  return {
    attemptId,
    specId,
    backend: str(payload.backend) ?? "local",
    ...(machineId ? { machineId } : {}),
    state: record.state as ExperimentAttemptState,
    collection: (["none", "pending", "done", "failed"] as const)
      .find((value) => value === payload.collection) ?? "none",
    ...(payload.exitCode === null || exitCode !== undefined
      ? { exitCode: payload.exitCode === null ? null : exitCode! }
      : {}),
    ...(signal ? { signal } : {}),
    ...(error ? { error } : {}),
    ...(queueReason ? { queueReason } : {}),
    ...(requestId ? { requestId } : {}),
    ...(record.threadId ? { threadId: record.threadId } : {}),
    ...(record.runId ? { runId: record.runId } : {}),
    createdAt: record.createdAt,
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(endedAt !== undefined ? { endedAt } : {}),
  };
};

const jobView = (record: KernelRecordResult): ExperimentJobView | null => {
  const payload = payloadOf(record);
  const jobId = str(payload.id);
  const attemptId = str(payload.attemptId);
  if (!jobId || !attemptId) return null;
  const machineId = str(payload.machineId);
  const backendJobId = str(payload.backendJobId);
  const kernelEpoch = str(payload.kernelEpoch);
  const pid = num(payload.pid);
  const signal = str(payload.signal);
  const reason = str(payload.reason);
  const exitCode = num(payload.exitCode);
  const startedAt = num(payload.startedAt);
  const endedAt = num(payload.endedAt);
  return {
    jobId,
    attemptId,
    backend: str(payload.backend) ?? "local",
    ...(machineId ? { machineId } : {}),
    ...(backendJobId ? { backendJobId } : {}),
    ...(kernelEpoch ? { kernelEpoch } : {}),
    ...(pid !== undefined ? { pid } : {}),
    state: record.state as ExperimentJobState,
    ...(payload.exitCode === null || exitCode !== undefined
      ? { exitCode: payload.exitCode === null ? null : exitCode! }
      : {}),
    ...(signal ? { signal } : {}),
    ...(reason ? { reason } : {}),
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(endedAt !== undefined ? { endedAt } : {}),
  };
};

const artifactView = (record: KernelRecordResult): ExperimentArtifactView | null => {
  const payload = payloadOf(record);
  const artifactId = str(payload.id);
  const attemptId = str(payload.attemptId);
  const name = str(payload.name);
  if (!artifactId || !attemptId || !name) return null;
  const kind = (["stdout", "stderr", "file", "object"] as const)
    .find((value) => value === payload.kind) ?? "object";
  const content = record.references.find((reference) => reference.slot === "content");
  const byteLength = num(payload.byteLength);
  const artifactPath = str(payload.path);
  const collectedAt = num(payload.collectedAt);
  const error = str(payload.error);
  return {
    artifactId,
    attemptId,
    name,
    kind,
    state: record.state as ExperimentArtifactState,
    ...(byteLength !== undefined ? { byteLength } : {}),
    ...(payload.truncated === true ? { truncated: true } : {}),
    ...(content ? { objectHash: content.objectHash } : {}),
    ...(artifactPath ? { path: artifactPath } : {}),
    ...(collectedAt !== undefined ? { collectedAt } : {}),
    ...(error ? { error } : {}),
  };
};

const specDigest = (input: {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  inputs?: ExperimentInputRef[];
  resources?: ExperimentResourceRequest;
  outputPaths?: string[];
}): string => {
  const normalized = {
    command: input.command,
    args: [...input.args].sort(),
    cwd: input.cwd ?? null,
    env: input.env ? Object.fromEntries(Object.entries(input.env).sort(([a], [b]) => a.localeCompare(b))) : null,
    inputs: input.inputs ?? [],
    resources: input.resources ?? null,
    outputPaths: input.outputPaths ?? [],
  };
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex").slice(0, 24);
};

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

export function createExperimentService(deps: ExperimentServiceDeps) {
  const now = deps.now ?? (() => Date.now());
  const contexts = new Map<string, Promise<ExperimentContext>>();
  const reconciled = new Set<string>();
  const jobs = new Map<string, RunningJob>();
  const waiters = new Map<string, Set<(view: ExperimentAttemptView | null) => void>>();
  const queued = new Map<string, Set<string>>();
  const report = (error: unknown) => {
    if (deps.onError) deps.onError(error instanceof Error ? error : new Error(String(error)));
  };

  // Experiment execution is a Host-managed authority (like the process-host
  // service): one service grant per (owning, execution) workspace pair so a
  // detached reconciler can still inspect, stop and collect the jobs it
  // launched. Records live in the owning workspace so facts are shared across
  // roots; the process root and cwd resolve against the actor's execution
  // workspace, whose scope the router already admitted for params.cwd.
  const context = (caller: ExperimentCaller): Promise<ExperimentContext> => {
    const key = `${caller.workspaceId}${caller.executionWorkspaceId}`;
    const existing = contexts.get(key);
    if (existing) return existing;
    const creating = (async (): Promise<ExperimentContext> => {
      const resolved = await deps.resolveWorkspaceRoot(caller.executionWorkspaceId);
      if (!resolved) throw new HarnessServiceError("unavailable", `Workspace root is unavailable: ${caller.executionWorkspaceId}`);
      const canonicalRoot = await canonicalizePathIdentity(resolved);
      const grant = await deps.client.issueGrant({
        grantId: `experiment:${randomUUID()}`,
        owningWorkspace: caller.workspaceId,
        executionWorkspace: caller.executionWorkspaceId,
        capabilities: SERVICE_CAPABILITIES,
        pathScopes: [""],
      });
      const scoped = deps.client.scoped(grant);
      const root = await scoped.fileRootRegister({
        workspaceId: caller.workspaceId,
        executionWorkspaceId: caller.executionWorkspaceId,
        canonicalRoot,
      });
      if (typeof root.rootId !== "string") {
        throw new HarnessServiceError("unavailable", "Experiment root registration returned no identity");
      }
      return { scoped, rootId: root.rootId, canonicalRoot };
    })();
    contexts.set(key, creating);
    void creating.catch(() => { if (contexts.get(key) === creating) contexts.delete(key); });
    return creating;
  };

  const putRecord = async (
    ctx: ExperimentContext,
    workspaceId: string,
    caller: ExperimentCaller,
    input: {
      recordId: string;
      recordType: string;
      state: string;
      payload: Record<string, unknown>;
      references?: Array<{ slot: string; objectHash: string }>;
      ownerIds?: string[];
      expectedRecordRevision?: number;
    },
  ): Promise<KernelRecordResult> => ctx.scoped.putRecord({
    operationId: `${input.recordType}:${randomUUID()}`,
    recordId: input.recordId,
    workspaceId,
    recordType: input.recordType,
    state: input.state,
    payloadJson: JSON.stringify(input.payload),
    ownerIds: input.ownerIds ?? [],
    references: input.references ?? [],
    ...(caller.sessionId ? { sessionId: caller.sessionId } : {}),
    ...(caller.threadId ? { threadId: caller.threadId } : {}),
    ...(caller.runId ? { runId: caller.runId } : {}),
    ...(input.expectedRecordRevision === undefined ? {} : { expectedRecordRevision: input.expectedRecordRevision }),
  });

  const getAttemptRecord = (ctx: ExperimentContext, workspaceId: string, attemptId: string) => (
    ctx.scoped.getRecord(workspaceId, recordIdFor.attempt(attemptId))
  );

  const updateAttempt = async (
    ctx: ExperimentContext,
    workspaceId: string,
    caller: ExperimentCaller,
    attemptId: string,
    state: ExperimentAttemptState,
    mutate: (payload: Record<string, unknown>) => Record<string, unknown>,
  ): Promise<KernelRecordResult> => {
    const existing = await getAttemptRecord(ctx, workspaceId, attemptId);
    if (!existing) throw new HarnessServiceError("not-found", `Unknown experiment attempt: ${attemptId}`);
    const record = await putRecord(ctx, workspaceId, caller, {
      recordId: existing.recordId,
      recordType: "experiment.attempt",
      state,
      expectedRecordRevision: existing.recordRevision,
      payload: mutate(payloadOf(existing)),
    });
    const view = attemptView(record);
    notify(attemptId, view);
    return record;
  };

  const notify = (attemptId: string, view: ExperimentAttemptView | null) => {
    if (!view || !TERMINAL.has(view.state)) return;
    const pending = waiters.get(attemptId);
    if (!pending) return;
    waiters.delete(attemptId);
    for (const resolve of pending) resolve(view);
  };

  const persistArtifacts = async (
    ctx: ExperimentContext,
    workspaceId: string,
    caller: ExperimentCaller,
    attemptId: string,
    spec: ExperimentSpecView,
    running: RunningJob | null,
  ): Promise<ExperimentArtifactView[]> => {
    const artifacts: ExperimentArtifactView[] = [];
    const persistBlob = async (
      name: string,
      kind: ExperimentArtifactView["kind"],
      bytes: Buffer,
      truncated: boolean,
      extra: Record<string, unknown> = {},
    ) => {
      const artifactId = `${attemptId}:${name}`.slice(0, 190);
      const recordId = recordIdFor.artifact(artifactId);
      const prior = await ctx.scoped.getRecord(workspaceId, recordId);
      if (prior && prior.state === "available") {
        const existing = artifactView(prior);
        if (existing) { artifacts.push(existing); return; }
      }
      try {
        const blob = await ctx.scoped.putBlob(bytes, `experiment-artifact:${randomUUID()}`);
        const record = await putRecord(ctx, workspaceId, caller, {
          recordId,
          recordType: "experiment.artifact",
          state: "available",
          ownerIds: [blob.ownerId],
          references: [{ slot: "content", objectHash: blob.hash }],
          ...(prior ? { expectedRecordRevision: prior.recordRevision } : {}),
          payload: {
            id: artifactId,
            attemptId,
            name,
            kind,
            byteLength: bytes.byteLength,
            ...(truncated ? { truncated: true } : {}),
            collectedAt: now(),
            ...extra,
          },
        });
        const view = artifactView(record);
        if (view) artifacts.push(view);
      } catch (error) {
        const record = await putRecord(ctx, workspaceId, caller, {
          recordId,
          recordType: "experiment.artifact",
          state: "failed",
          ...(prior ? { expectedRecordRevision: prior.recordRevision } : {}),
          payload: {
            id: artifactId, attemptId, name, kind,
            collectedAt: now(), error: errorMessage(error),
            ...extra,
          },
        }).catch(() => null);
        const view = record ? artifactView(record) : null;
        artifacts.push(view ?? {
          artifactId, attemptId, name, kind, state: "failed", error: errorMessage(error),
        });
      }
    };
    if (running) {
      for (const stream of ["stdout", "stderr"] as const) {
        const bytes = Buffer.concat(running.buffers[stream]);
        if (bytes.byteLength === 0 && !running.truncated[stream]) continue;
        await persistBlob(stream, stream, bytes, running.truncated[stream]);
      }
    }
    for (const relativePath of spec.outputPaths) {
      try {
        const absolute = path.join(ctx.canonicalRoot, relativePath);
        const resolved = await canonicalizePathIdentity(absolute);
        if (!resolved.startsWith(ctx.canonicalRoot)) {
          throw new Error(`output path escaped the experiment root: ${relativePath}`);
        }
        const bytes = await fs.readFile(resolved);
        await persistBlob(relativePath, "file", bytes, false, { path: relativePath });
      } catch (error) {
        const artifactId = `${attemptId}:${relativePath}`.slice(0, 190);
        const recordId = recordIdFor.artifact(artifactId);
        const prior = await ctx.scoped.getRecord(workspaceId, recordId);
        if (prior?.state === "available") continue;
        const record = await putRecord(ctx, workspaceId, caller, {
          recordId,
          recordType: "experiment.artifact",
          state: "failed",
          ...(prior ? { expectedRecordRevision: prior.recordRevision } : {}),
          payload: {
            id: artifactId, attemptId, name: relativePath, kind: "file",
            path: relativePath, collectedAt: now(), error: errorMessage(error),
          },
        }).catch(() => null);
        if (record) {
          const view = artifactView(record);
          if (view) artifacts.push(view);
        }
      }
    }
    return artifacts;
  };

  const finalize = async (
    ctx: ExperimentContext,
    workspaceId: string,
    caller: ExperimentCaller,
    attemptId: string,
    running: RunningJob,
    snapshot: KernelProcessSnapshot,
  ): Promise<void> => {
    const jobRecordId = recordIdFor.job(jobIdFor(attemptId));
    const jobRecord = await ctx.scoped.getRecord(workspaceId, jobRecordId);
    const jobPayload = jobRecord ? payloadOf(jobRecord) : { id: jobIdFor(attemptId), attemptId, backend: "local" };
    const jobState: ExperimentJobState = snapshot.status === "exited" ? "exited"
      : snapshot.status === "unknown" ? "unknown"
      : "failed";
    await putRecord(ctx, workspaceId, caller, {
      recordId: jobRecordId,
      recordType: "experiment.job",
      state: jobState,
      ...(jobRecord ? { expectedRecordRevision: jobRecord.recordRevision } : {}),
      payload: {
        ...jobPayload,
        exitCode: snapshot.exitCode,
        signal: snapshot.signal,
        reason: snapshot.reason,
        endedAt: now(),
      },
    }).catch(report);
    const attemptRecord = await getAttemptRecord(ctx, workspaceId, attemptId);
    const attemptPayload = attemptRecord ? payloadOf(attemptRecord) : {};
    const specRecord = await ctx.scoped.getRecord(workspaceId, recordIdFor.spec(str(attemptPayload.specId) ?? ""));
    const spec = specRecord ? specView(specRecord) : null;
    let collection: ExperimentAttemptView["collection"] = "none";
    if (spec && jobState !== "unknown") {
      collection = "pending";
      try {
        const artifacts = await persistArtifacts(ctx, workspaceId, caller, attemptId, spec, running);
        collection = artifacts.some((artifact) => artifact.state === "failed") ? "failed" : "done";
      } catch {
        collection = "failed";
      }
    }
    if (jobState !== "unknown") {
      await ctx.scoped.processRelease({ workspaceId, processId: running.processId }).catch(report);
      const releasedRecord = await ctx.scoped.getRecord(workspaceId, jobRecordId).catch(() => null);
      await putRecord(ctx, workspaceId, caller, {
        recordId: jobRecordId,
        recordType: "experiment.job",
        state: "released",
        ...(releasedRecord ? { expectedRecordRevision: releasedRecord.recordRevision } : {}),
        payload: { ...jobPayload, exitCode: snapshot.exitCode, signal: snapshot.signal, reason: snapshot.reason, endedAt: now() },
      }).catch(report);
    }
    const finalState: ExperimentAttemptState = running.cancelRequested ? "cancelled"
      : jobState === "unknown" ? "lost"
      : snapshot.exitCode === 0 ? "completed"
      : "failed";
    await updateAttempt(ctx, workspaceId, caller, attemptId, finalState, (payload) => ({
      ...payload,
      exitCode: snapshot.exitCode,
      signal: snapshot.signal,
      endedAt: now(),
      collection,
      ...(snapshot.reason && finalState !== "completed" ? { error: snapshot.reason } : {}),
    }));
    const commitmentId = str(attemptPayload.commitmentId);
    if (commitmentId) await deps.resources.release(workspaceId, commitmentId, "attempt finished").catch(report);
    await drainQueue(workspaceId);
  };

  const poll = async (
    ctx: ExperimentContext,
    workspaceId: string,
    caller: ExperimentCaller,
    attemptId: string,
    running: RunningJob,
  ): Promise<void> => {
    for (;;) {
      const result = await ctx.scoped.processRead({
        workspaceId,
        processId: running.processId,
        cursor: running.cursor,
      });
      const snapshot = result.process;
      for (const chunk of result.chunks) {
        const bytes = Buffer.from(chunk.bytesBase64, "base64");
        running.totals[chunk.channel] += bytes.byteLength;
        const buffered = running.buffers[chunk.channel].reduce((sum, item) => sum + item.byteLength, 0);
        if (buffered + bytes.byteLength <= MAX_STREAM_BYTES) {
          running.buffers[chunk.channel].push(bytes);
        } else {
          const room = MAX_STREAM_BYTES - buffered;
          if (room > 0) running.buffers[chunk.channel].push(bytes.subarray(0, room));
          running.truncated[chunk.channel] = true;
        }
      }
      running.cursor = result.nextCursor;
      if (!snapshot.writerActive && running.cursor === result.endCursor) {
        jobs.delete(attemptId);
        await finalize(ctx, workspaceId, caller, attemptId, running, snapshot);
        return;
      }
      if (snapshot.status === "unknown") {
        jobs.delete(attemptId);
        await finalize(ctx, workspaceId, caller, attemptId, running, snapshot);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  };

  const launch = async (
    ctx: ExperimentContext,
    workspaceId: string,
    caller: ExperimentCaller,
    attemptRecord: KernelRecordResult,
  ): Promise<void> => {
    const attempt = attemptView(attemptRecord);
    if (!attempt || jobs.has(attempt.attemptId)) return;
    const payload = payloadOf(attemptRecord);
    const specRecord = await ctx.scoped.getRecord(workspaceId, recordIdFor.spec(attempt.specId));
    const spec = specRecord ? specView(specRecord) : null;
    if (!spec) {
      await updateAttempt(ctx, workspaceId, caller, attempt.attemptId, "failed", (p) => ({
        ...p, error: "experiment spec is unavailable", endedAt: now(), collection: "none",
      }));
      return;
    }
    const processId = processIdFor(attempt.attemptId);
    try {
      const specEnv = payloadOf(specRecord!).env;
      const mergedEnv: Record<string, string> = { ...process.env } as Record<string, string>;
      if (specEnv && typeof specEnv === "object") {
        for (const [name, value] of Object.entries(specEnv)) {
          if (typeof value === "string") mergedEnv[name] = value;
        }
      }
      const snapshot = await ctx.scoped.processSpawn({
        workspaceId,
        processId,
        rootId: ctx.rootId,
        cwd: spec.cwd ?? "",
        command: spec.command,
        args: spec.args,
        env: Object.entries(mergedEnv)
          .filter(([name, value]) => name !== "NODE_CHANNEL_FD" && typeof value === "string")
          .map(([name, value]) => ({ name, value })),
        mode: "pipe",
      });
      const jobId = jobIdFor(attempt.attemptId);
      await putRecord(ctx, workspaceId, caller, {
        recordId: recordIdFor.job(jobId),
        recordType: "experiment.job",
        state: snapshot.status === "running" || snapshot.status === "starting" ? snapshot.status : "failed",
        payload: {
          id: jobId,
          attemptId: attempt.attemptId,
          backend: "local",
          machineId: LOCAL_MACHINE_ID,
          backendJobId: processId,
          kernelEpoch: snapshot.kernelEpoch,
          pid: snapshot.pid,
          startedAt: now(),
          reason: snapshot.reason,
        },
      });
      if (snapshot.status === "failed") {
        await updateAttempt(ctx, workspaceId, caller, attempt.attemptId, "failed", (p) => ({
          ...p, error: snapshot.reason ?? "process failed to start", endedAt: now(), collection: "none",
        }));
        return;
      }
      await updateAttempt(ctx, workspaceId, caller, attempt.attemptId, "running", (p) => ({
        ...p, startedAt: num(payload.startedAt) ?? now(),
      }));
      const running: RunningJob = {
        processId,
        cursor: 0,
        buffers: { stdout: [], stderr: [] },
        totals: { stdout: 0, stderr: 0 },
        truncated: { stdout: false, stderr: false },
        cancelRequested: payload.cancelRequested === true,
        poll: Promise.resolve(),
      };
      running.poll = poll(ctx, workspaceId, caller, attempt.attemptId, running).catch(report);
      jobs.set(attempt.attemptId, running);
      return;
    } catch (error) {
      await updateAttempt(ctx, workspaceId, caller, attempt.attemptId, "failed", (p) => ({
        ...p, error: errorMessage(error), endedAt: now(), collection: "none",
      }));
      const commitmentId = str(payload.commitmentId);
      if (commitmentId) await deps.resources.release(workspaceId, commitmentId, "launch failed").catch(report);
      await drainQueue(workspaceId);
    }
  };

  const drainQueue = async (workspaceId: string): Promise<void> => {
    const pending = queued.get(workspaceId);
    if (!pending || pending.size === 0) return;
    for (const attemptId of [...pending]) {
      try {
        const scanCtx = await context({ workspaceId, executionWorkspaceId: workspaceId });
        const record = await getAttemptRecord(scanCtx, workspaceId, attemptId);
        const attempt = record ? attemptView(record) : null;
        if (!attempt || !record || attempt.state !== "queued") {
          pending.delete(attemptId);
          continue;
        }
        const payload = payloadOf(record);
        const caller = recordCaller(workspaceId, record);
        const ctx = await context(caller);
        const resources = (payload.resources ?? {}) as ExperimentResourceRequest;
        const admission = await deps.resources.admit(workspaceId, attempt.machineId ?? LOCAL_MACHINE_ID, resources, attemptId);
        if (admission.status !== "confirmed") continue;
        pending.delete(attemptId);
        const admitted = await updateAttempt(ctx, workspaceId, caller, attemptId, "submitted", (p) => ({
          ...p, commitmentId: admission.commitmentId, queueReason: undefined,
        }));
        await launch(ctx, workspaceId, caller, admitted);
      } catch (error) {
        report(error);
      }
    }
  };

  const resolveCwd = async (
    canonicalRoot: string,
    cwd: string | undefined,
    scope: readonly string[] | undefined,
  ): Promise<string> => {
    if (cwd === undefined) return "";
    const absolute = await canonicalizePathIdentity(cwd);
    if (absolute !== canonicalRoot && !absolute.startsWith(`${canonicalRoot}${path.sep}`)) {
      throw new HarnessServiceError("forbidden", `Experiment cwd is outside the workspace root: ${cwd}`);
    }
    const relative = path.relative(canonicalRoot, absolute).replaceAll("\\", "/");
    if (scope?.length) {
      const allowed = scope.some((entry) => relative === "" || relative === entry || relative.startsWith(`${entry}/`));
      if (!allowed) throw new HarnessServiceError("forbidden", `Experiment cwd is outside the actor scope: ${cwd}`);
    }
    return relative;
  };

  const resolveInputs = async (
    caller: ExperimentCaller,
    inputs: readonly ExperimentInputRef[] | undefined,
  ): Promise<ExperimentInputRef[]> => {
    const resolved: ExperimentInputRef[] = [];
    for (const input of inputs ?? []) {
      const entry: ExperimentInputRef = { ...(input.role ? { role: input.role } : {}) };
      if (input.sourceId) {
        if (!deps.sources) throw new HarnessServiceError("unavailable", "Research source records are unavailable");
        const source = await deps.sources.get(caller.workspaceId, input.sourceId);
        if (!source || source.state !== "available") {
          throw new HarnessServiceError("not-found", `Unknown or retired research source: ${input.sourceId}`);
        }
        entry.sourceId = source.sourceId;
      }
      if (input.path) {
        if (path.isAbsolute(input.path) || input.path.includes("..") || input.path.includes("\0")) {
          throw new HarnessServiceError("invalid-params", `Input path must stay inside the workspace: ${input.path}`);
        }
        entry.path = input.path.replaceAll("\\", "/");
      }
      if (input.objectHash) {
        if (!input.objectHash.startsWith("sha256-")) {
          throw new HarnessServiceError("invalid-params", "Input objectHash must be a sha256- reference");
        }
        entry.objectHash = input.objectHash;
      }
      if (!entry.sourceId && !entry.path && !entry.objectHash) {
        throw new HarnessServiceError("invalid-params", "Experiment input requires a sourceId, path or objectHash");
      }
      resolved.push(entry);
    }
    return resolved;
  };

  const recordCaller = (workspaceId: string, record: KernelRecordResult): ExperimentCaller => {
    const payload = payloadOf(record);
    return {
      workspaceId,
      executionWorkspaceId: str(payload.executionWorkspaceId) ?? workspaceId,
      ...(record.sessionId ? { sessionId: record.sessionId } : {}),
      ...(record.threadId ? { threadId: record.threadId } : {}),
      ...(record.runId ? { runId: record.runId } : {}),
    };
  };

  const ensureReconciled = async (workspaceId: string): Promise<void> => {
    if (reconciled.has(workspaceId)) return;
    reconciled.add(workspaceId);
    try {
      const ctx = await context({ workspaceId, executionWorkspaceId: workspaceId });
      const all: KernelRecordResult[] = [];
      let cursor: number | undefined;
      do {
        const page = await ctx.scoped.listRecords({
          workspaceId, recordType: "experiment.attempt", pageSize: 128,
          ...(cursor === undefined ? {} : { cursor }),
        });
        all.push(...page.records);
        cursor = page.nextCursor === null ? undefined : page.nextCursor;
      } while (cursor !== undefined);
      for (const record of all) {
        const attempt = attemptView(record);
        if (!attempt || TERMINAL.has(attempt.state)) continue;
        const caller = recordCaller(workspaceId, record);
        const attemptCtx = await context(caller).catch(() => ctx);
        const payload = payloadOf(record);
        if (attempt.state === "queued") {
          const set = queued.get(workspaceId) ?? new Set<string>();
          set.add(attempt.attemptId);
          queued.set(workspaceId, set);
          continue;
        }
        if (attempt.state === "submitted") {
          // The launch may have been lost between the record write and spawn;
          // the derived process id makes a fresh spawn idempotent.
          await launch(attemptCtx, workspaceId, caller, record).catch(report);
          continue;
        }
        const processId = processIdFor(attempt.attemptId);
        try {
          const snapshot = await attemptCtx.scoped.processInspect({ workspaceId, processId });
          const running: RunningJob = {
            processId,
            cursor: 0,
            buffers: { stdout: [], stderr: [] },
            totals: { stdout: 0, stderr: 0 },
            truncated: { stdout: false, stderr: false },
            cancelRequested: attempt.state === "stopping" || payload.cancelRequested === true,
            poll: Promise.resolve(),
          };
          if (attempt.state === "stopping") {
            await attemptCtx.scoped.processKill({ workspaceId, processId, force: true }).catch(report);
          }
          running.poll = poll(attemptCtx, workspaceId, caller, attempt.attemptId, running).catch(report);
          jobs.set(attempt.attemptId, running);
        } catch (error) {
          await updateAttempt(attemptCtx, workspaceId, caller, attempt.attemptId, "lost", (p) => ({
            ...p,
            error: `backend process is unreachable after restart: ${errorMessage(error)}`,
            endedAt: now(),
          })).catch(report);
        }
      }
      void drainQueue(workspaceId).catch(report);
    } catch (error) {
      reconciled.delete(workspaceId);
      report(error);
    }
  };

  const submit = async (
    caller: ExperimentCaller,
    params: ExperimentSubmitParams,
  ): Promise<{ spec: ExperimentSpecView; attempt: ExperimentAttemptView; text: string }> => {
    await ensureReconciled(caller.workspaceId);
    const ctx = await context(caller);
    if (params.specId !== undefined) {
      if (params.command !== undefined || params.args !== undefined || params.inputs !== undefined
        || params.resources !== undefined || params.outputPaths !== undefined || params.env !== undefined
        || params.cwd !== undefined) {
        throw new HarnessServiceError("invalid-params", "specId cannot be combined with inline spec fields");
      }
    }
    let specRecord: KernelRecordResult;
    let spec: ExperimentSpecView | null;
    if (params.specId !== undefined) {
      const found = await ctx.scoped.getRecord(caller.workspaceId, recordIdFor.spec(params.specId));
      spec = found ? specView(found) : null;
      if (!spec || spec.state !== "active") {
        throw new HarnessServiceError("not-found", `Unknown or retired experiment spec: ${params.specId}`);
      }
      specRecord = found!;
    } else {
      const command = typeof params.command === "string" ? params.command.trim() : "";
      if (!command) throw new HarnessServiceError("invalid-params", "experiment submit requires a command");
      const args = params.args ?? [];
      if (!Array.isArray(args) || !args.every((arg) => typeof arg === "string")) {
        throw new HarnessServiceError("invalid-params", "experiment args must be a string array");
      }
      const env = params.env ?? {};
      if (!Object.values(env).every((value) => typeof value === "string")) {
        throw new HarnessServiceError("invalid-params", "experiment env values must be strings");
      }
      const cwd = await resolveCwd(ctx.canonicalRoot, params.cwd, caller.workspaceScope);
      const inputs = await resolveInputs(caller, params.inputs);
      const outputPaths = (params.outputPaths ?? []).map((entry) => {
        if (typeof entry !== "string" || !entry.trim() || path.isAbsolute(entry) || entry.includes("..")) {
          throw new HarnessServiceError("invalid-params", `Invalid experiment output path: ${String(entry)}`);
        }
        return entry.replaceAll("\\", "/");
      });
      const specId = `spec-${specDigest({
        command, args, cwd, env, inputs, outputPaths,
        ...(params.resources ? { resources: params.resources } : {}),
      })}`;
      const existing = await ctx.scoped.getRecord(caller.workspaceId, recordIdFor.spec(specId));
      if (existing) {
        spec = specView(existing);
        specRecord = existing;
      } else {
        specRecord = await putRecord(ctx, caller.workspaceId, caller, {
          recordId: recordIdFor.spec(specId),
          recordType: "experiment.spec",
          state: "active",
          payload: {
            id: specId,
            workspaceId: caller.workspaceId,
            ...(params.title?.trim() ? { title: params.title.trim() } : {}),
            command,
            args,
            ...(cwd ? { cwd } : {}),
            env,
            inputs,
            ...(params.resources ? { resources: params.resources } : {}),
            outputPaths,
            createdAt: now(),
          },
        });
        spec = specView(specRecord);
      }
      if (!spec) throw new HarnessServiceError("failed", "experiment spec record is unreadable");
    }
    const attemptId = params.requestId ? attemptIdForRequest(params.requestId) : `attempt-${randomUUID()}`;
    const existing = await getAttemptRecord(ctx, caller.workspaceId, attemptId);
    if (existing) {
      const recorded = attemptView(existing);
      if (recorded) {
        if (!TERMINAL.has(recorded.state) && !jobs.has(attemptId)) {
          const callerForRetry = recordCaller(caller.workspaceId, existing);
          await reconcileAttempt(await context(callerForRetry), caller.workspaceId, callerForRetry, existing);
        }
        const refreshed = await getAttemptRecord(ctx, caller.workspaceId, attemptId);
        const view = refreshed ? attemptView(refreshed) : recorded;
        return { spec, attempt: view ?? recorded, text: describeAttempt(spec, view ?? recorded) };
      }
    }
    const attemptRecord = await putRecord(ctx, caller.workspaceId, caller, {
      recordId: recordIdFor.attempt(attemptId),
      recordType: "experiment.attempt",
      state: "submitted",
      payload: {
        id: attemptId,
        specId: spec.specId,
        backend: "local",
        machineId: params.machineId ?? LOCAL_MACHINE_ID,
        executionWorkspaceId: caller.executionWorkspaceId,
        ...(params.requestId ? { requestId: params.requestId } : {}),
        ...(params.resources ? { resources: params.resources } : {}),
        createdAt: now(),
      },
    });
    const machineId = params.machineId ?? LOCAL_MACHINE_ID;
    if (machineId !== LOCAL_MACHINE_ID) {
      await updateAttempt(ctx, caller.workspaceId, caller, attemptId, "failed", (p) => ({
        ...p, error: `backend for machine ${machineId} is not available`, endedAt: now(),
      }));
      const failed = await getAttemptRecord(ctx, caller.workspaceId, attemptId);
      const view = failed ? attemptView(failed) : null;
      return { spec, attempt: view!, text: describeAttempt(spec, view) };
    }
    const requestedResources = params.resources ?? {};
    const needsAdmission = (["cpuCores", "memoryMb", "gpuCount", "gpuMemoryMb"] as const)
      .some((key) => (requestedResources[key] ?? 0) > 0);
    if (needsAdmission) {
      const admission = await deps.resources.admit(caller.workspaceId, machineId, requestedResources, attemptId);
      if (admission.status !== "confirmed") {
        const queuedRecord = await updateAttempt(ctx, caller.workspaceId, caller, attemptId, "queued", (p) => ({
          ...p,
          queueReason: admission.reason ?? "insufficient resources",
        }));
        const set = queued.get(caller.workspaceId) ?? new Set<string>();
        set.add(attemptId);
        queued.set(caller.workspaceId, set);
        const view = attemptView(queuedRecord);
        return { spec, attempt: view!, text: describeAttempt(spec, view) };
      }
      await updateAttempt(ctx, caller.workspaceId, caller, attemptId, "submitted", (p) => ({
        ...p, commitmentId: admission.commitmentId,
      }));
    }
    const fresh = await getAttemptRecord(ctx, caller.workspaceId, attemptId);
    await launch(ctx, caller.workspaceId, caller, fresh!);
    const view = await getAttemptRecord(ctx, caller.workspaceId, attemptId).then((r) => r ? attemptView(r) : null);
    return { spec, attempt: view!, text: describeAttempt(spec, view) };
  };

  const reconcileAttempt = async (
    ctx: ExperimentContext,
    workspaceId: string,
    caller: ExperimentCaller,
    record: KernelRecordResult,
  ): Promise<void> => {
    const attempt = attemptView(record);
    if (!attempt) return;
    if (attempt.state === "queued") {
      const set = queued.get(workspaceId) ?? new Set<string>();
      set.add(attempt.attemptId);
      queued.set(workspaceId, set);
      void drainQueue(workspaceId).catch(report);
      return;
    }
    if (attempt.state === "submitted") {
      await launch(ctx, workspaceId, caller, record);
      return;
    }
    const processId = processIdFor(attempt.attemptId);
    try {
      await ctx.scoped.processInspect({ workspaceId, processId });
      const running: RunningJob = {
        processId, cursor: 0,
        buffers: { stdout: [], stderr: [] },
        totals: { stdout: 0, stderr: 0 },
        truncated: { stdout: false, stderr: false },
        cancelRequested: attempt.state === "stopping",
        poll: Promise.resolve(),
      };
      if (attempt.state === "stopping") {
        await ctx.scoped.processKill({ workspaceId, processId, force: true }).catch(report);
      }
      running.poll = poll(ctx, workspaceId, caller, attempt.attemptId, running).catch(report);
      jobs.set(attempt.attemptId, running);
    } catch {
      await updateAttempt(ctx, workspaceId, caller, attempt.attemptId, "lost", (p) => ({
        ...p, error: "backend process is unreachable", endedAt: now(),
      })).catch(report);
    }
  };

  const describeAttempt = (spec: ExperimentSpecView, attempt: ExperimentAttemptView | null): string => {
    if (!attempt) return `spec ${spec.specId}: attempt record unreadable`;
    const command = [spec.command, ...spec.args].join(" ");
    const state = attempt.state;
    const suffix = attempt.state === "queued" ? ` (${attempt.queueReason ?? "queued"})`
      : attempt.exitCode !== undefined && attempt.exitCode !== null ? ` (exit ${attempt.exitCode})`
      : attempt.error ? ` (${attempt.error})`
      : "";
    return `attempt ${attempt.attemptId} [${spec.specId}] ${state}${suffix} — ${command}`;
  };

  const requireAttempt = async (
    caller: ExperimentCaller,
    attemptId: string,
  ): Promise<{ ctx: ExperimentContext; record: KernelRecordResult; view: ExperimentAttemptView }> => {
    await ensureReconciled(caller.workspaceId);
    const ctx = await context(caller);
    const record = await getAttemptRecord(ctx, caller.workspaceId, attemptId);
    const view = record ? attemptView(record) : null;
    if (!record || !view) throw new HarnessServiceError("not-found", `Unknown experiment attempt: ${attemptId}`);
    return { ctx, record, view };
  };

  const get = async (caller: ExperimentCaller, attemptId: string): Promise<ExperimentGetResult> => {
    const { ctx, view } = await requireAttempt(caller, attemptId);
    const specRecord = await ctx.scoped.getRecord(caller.workspaceId, recordIdFor.spec(view.specId));
    const spec = specRecord ? specView(specRecord) : null;
    const jobRecord = await ctx.scoped.getRecord(caller.workspaceId, recordIdFor.job(jobIdFor(attemptId)));
    const job = jobRecord ? jobView(jobRecord) : null;
    const artifacts: ExperimentArtifactView[] = [];
    let cursor: number | undefined;
    do {
      const page = await ctx.scoped.listRecords({
        workspaceId: caller.workspaceId, recordType: "experiment.artifact", pageSize: 128,
        ...(cursor === undefined ? {} : { cursor }),
      });
      for (const record of page.records) {
        const artifact = artifactView(record);
        if (artifact?.attemptId === attemptId) artifacts.push(artifact);
      }
      cursor = page.nextCursor === null ? undefined : page.nextCursor;
    } while (cursor !== undefined);
    return {
      attempt: view,
      ...(spec ? { spec } : {}),
      ...(job ? { job } : {}),
      artifacts,
    };
  };

  const list = async (
    caller: ExperimentCaller,
    params: { state?: ExperimentAttemptState; specId?: string; limit?: number },
  ): Promise<ExperimentListResult> => {
    await ensureReconciled(caller.workspaceId);
    const ctx = await context(caller);
    const attempts: ExperimentAttemptView[] = [];
    let cursor: number | undefined;
    do {
      const page = await ctx.scoped.listRecords({
        workspaceId: caller.workspaceId, recordType: "experiment.attempt", pageSize: 128,
        ...(cursor === undefined ? {} : { cursor }),
      });
      for (const record of page.records) {
        const view = attemptView(record);
        if (!view) continue;
        if (params.state && view.state !== params.state) continue;
        if (params.specId && view.specId !== params.specId) continue;
        attempts.push(view);
      }
      cursor = page.nextCursor === null ? undefined : page.nextCursor;
    } while (cursor !== undefined);
    const limited = params.limit !== undefined ? attempts.slice(0, Math.max(0, params.limit)) : attempts;
    const text = limited.length === 0
      ? "No experiments recorded."
      : limited.map((attempt) => {
          const detail = attempt.state === "queued" ? ` (${attempt.queueReason ?? "queued"})`
            : attempt.exitCode !== undefined && attempt.exitCode !== null ? ` exit=${attempt.exitCode}`
            : attempt.error ? ` (${attempt.error})`
            : "";
          return `${attempt.attemptId} · ${attempt.state}${detail} · spec ${attempt.specId}`;
        }).join("\n");
    return { attempts: limited, text };
  };

  const cancel = async (caller: ExperimentCaller, attemptId: string): Promise<ExperimentAttemptView> => {
    const { ctx, view } = await requireAttempt(caller, attemptId);
    if (TERMINAL.has(view.state)) return view;
    if (view.state === "queued") {
      queued.get(caller.workspaceId)?.delete(attemptId);
      const record = await updateAttempt(ctx, caller.workspaceId, caller, attemptId, "cancelled", (p) => ({
        ...p, endedAt: now(),
      }));
      return attemptView(record)!;
    }
    const running = jobs.get(attemptId);
    const processId = running?.processId ?? processIdFor(attemptId);
    await updateAttempt(ctx, caller.workspaceId, caller, attemptId, "stopping", (p) => ({
      ...p, cancelRequested: true,
    }));
    if (running) running.cancelRequested = true;
    await ctx.scoped.processKill({ workspaceId: caller.workspaceId, processId, force: true }).catch(report);
    if (!running) {
      try {
        const snapshot = await ctx.scoped.processInspect({ workspaceId: caller.workspaceId, processId });
        const job: RunningJob = {
          processId, cursor: 0,
          buffers: { stdout: [], stderr: [] },
          totals: { stdout: 0, stderr: 0 },
          truncated: { stdout: false, stderr: false },
          cancelRequested: true,
          poll: Promise.resolve(),
        };
        if (!snapshot.writerActive) {
          await finalize(ctx, caller.workspaceId, caller, attemptId, job, snapshot);
        } else {
          jobs.set(attemptId, job);
          job.poll = poll(ctx, caller.workspaceId, caller, attemptId, job).catch(report);
        }
      } catch {
        await updateAttempt(ctx, caller.workspaceId, caller, attemptId, "cancelled", (p) => ({
          ...p, endedAt: now(), collection: "none",
        })).catch(report);
      }
    }
    const updated = await getAttemptRecord(ctx, caller.workspaceId, attemptId);
    return attemptView(updated ?? null as unknown as KernelRecordResult) ?? view;
  };

  const wait = async (
    caller: ExperimentCaller,
    attemptId: string,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<{ attempt: ExperimentAttemptView; timedOut: boolean }> => {
    const { view } = await requireAttempt(caller, attemptId);
    if (TERMINAL.has(view.state)) return { attempt: view, timedOut: false };
    const deadline = timeoutMs === undefined ? 30_000 : Math.max(0, timeoutMs);
    if (signal?.aborted) return { attempt: view, timedOut: true };
    const waited = await new Promise<ExperimentAttemptView | null>((resolve) => {
      const set = waiters.get(attemptId) ?? new Set<(view: ExperimentAttemptView | null) => void>();
      const finish = (value: ExperimentAttemptView | null) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        set.delete(finish);
        resolve(value);
      };
      // Cancelling the wait must not cancel the job: abort only ends this
      // observation, the attempt keeps its reservation and lifecycle.
      const onAbort = () => finish(null);
      const timer = setTimeout(() => {
        set.delete(finish);
        signal?.removeEventListener("abort", onAbort);
        resolve(null);
      }, deadline);
      set.add(finish);
      waiters.set(attemptId, set);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    if (waited) return { attempt: waited, timedOut: false };
    const refreshed = await getAttemptRecord(await context(caller), caller.workspaceId, attemptId);
    const current = refreshed ? attemptView(refreshed) : null;
    return { attempt: current ?? view, timedOut: !current || !TERMINAL.has(current.state) };
  };

  const logs = async (
    caller: ExperimentCaller,
    params: { attemptId: string; stream?: "stdout" | "stderr"; offset?: number; maxBytes?: number },
  ): Promise<ExperimentLogsResult> => {
    const { ctx, view } = await requireAttempt(caller, params.attemptId);
    const stream = params.stream ?? "stdout";
    const offset = Math.max(0, params.offset ?? 0);
    const maxBytes = Math.min(Math.max(1, params.maxBytes ?? 64 * 1024), 256 * 1024);
    const running = jobs.get(params.attemptId);
    if (running) {
      const buffer = Buffer.concat(running.buffers[stream]);
      const slice = buffer.subarray(offset, offset + maxBytes);
      return {
        attemptId: params.attemptId,
        stream,
        offset,
        nextOffset: offset + slice.byteLength,
        eof: TERMINAL.has(view.state) && offset + slice.byteLength >= buffer.byteLength,
        text: slice.toString("utf8"),
        origin: "live",
      };
    }
    const artifactId = `${params.attemptId}:${stream}`;
    const record = await ctx.scoped.getRecord(caller.workspaceId, recordIdFor.artifact(artifactId));
    const artifact = record ? artifactView(record) : null;
    if (!artifact || artifact.state !== "available" || !artifact.objectHash) {
      return {
        attemptId: params.attemptId,
        stream, offset, nextOffset: offset, eof: true, text: "", origin: "artifact",
      };
    }
    const slice = await ctx.scoped.getBlob(artifact.objectHash, { recordId: record!.recordId, slot: "content" }, {
      offset, length: maxBytes,
    });
    const bytes = Buffer.from(slice.bytesBase64, "base64");
    return {
      attemptId: params.attemptId,
      stream,
      offset,
      nextOffset: slice.nextOffset,
      eof: slice.eof,
      text: bytes.toString("utf8"),
      origin: "artifact",
    };
  };

  const collect = async (caller: ExperimentCaller, attemptId: string): Promise<ExperimentCollectResult> => {
    const { ctx, view } = await requireAttempt(caller, attemptId);
    if (!TERMINAL.has(view.state)) {
      throw new HarnessServiceError("invalid-params", `Attempt ${attemptId} is still ${view.state}; collect after it finishes`);
    }
    if (view.state === "lost") {
      throw new HarnessServiceError("unavailable", `Attempt ${attemptId} is lost; its backend state is unknown`);
    }
    const specRecord = await ctx.scoped.getRecord(caller.workspaceId, recordIdFor.spec(view.specId));
    const spec = specRecord ? specView(specRecord) : null;
    if (!spec) throw new HarnessServiceError("unavailable", "experiment spec record is unavailable");
    const running = jobs.get(attemptId) ?? null;
    const artifacts = await persistArtifacts(ctx, caller.workspaceId, caller, attemptId, spec, running);
    const collection = artifacts.some((artifact) => artifact.state === "failed") ? "failed" : "done";
    const updated = await updateAttempt(ctx, caller.workspaceId, caller, attemptId, view.state, (p) => ({
      ...p, collection,
    }));
    return { attempt: attemptView(updated)!, artifacts };
  };

  return { submit, list, get, logs, cancel, wait, collect, ensureReconciled };
}

export type ExperimentService = ReturnType<typeof createExperimentService>;
