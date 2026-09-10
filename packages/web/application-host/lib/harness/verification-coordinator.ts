import path from "node:path";
import type { HarnessActorIdentity, ThreadParent, ThreadVerificationProjection } from "@piarium/protocol";
import {
  bindCommandsToPublishedResult,
  cwdUnderRoot,
  projectThreadVerification,
} from "./working-state/verification-records.js";
import type {
  CommandVerificationRecord,
  ParentVerificationBundle,
  ResultReviewRecord,
  VerificationActorIdentity,
} from "./working-state/types.js";
import type {
  WorkingStateStore,
  WorkspaceWorkingStateAccess,
} from "./working-state/working-state-store.js";

export interface CapturedVerificationIdentity {
  treeHash: string | null;
  reason?: string;
}

export interface VerificationCommandStarted {
  actor: HarnessActorIdentity;
  executionId: string;
  commandRunId: string;
  command: string;
  cwd: string;
  startedAt: number;
}

export interface VerificationCommandCompleted {
  actor: HarnessActorIdentity;
  executionId: string;
  commandRunId: string;
  command: string;
  cwd: string;
  startedAt: number;
  endedAt: number;
  exitCode: number;
  cancelled: boolean;
  outputHandle?: string;
  outputPreview?: string;
}

interface CommonSessionBinding {
  workspaceId: string;
  generation: number;
  actor?: VerificationActorIdentity;
}

interface ChildSessionBinding extends CommonSessionBinding {
  scope: "child";
  threadId: string;
  runId: string;
  worktreePath?: string;
  branchId?: string;
  captureIdentity?: () => Promise<CapturedVerificationIdentity>;
}

interface ParentSessionBinding extends CommonSessionBinding {
  scope: "parent";
  parentRoot: string;
  parentSessionId: string;
}

type SessionBinding = ChildSessionBinding | ParentSessionBinding;

interface PendingCommandObservation {
  executionId: string;
  sessionId: string;
  binding: SessionBinding;
  actor: VerificationActorIdentity;
  command: string;
  commandRunId: string;
  cwd: string;
  startedAt: number;
  endedAt?: number;
  exitCode?: number;
  cancelled?: boolean;
  outputHandle?: string;
  outputPreview?: string;
  startTreeHash?: string;
  endTreeHash?: string;
  identityReason?: string;
}

interface ParentMergeWindow {
  key: string;
  workspaceId: string;
  parent: ThreadParent;
  parentRoot: string;
  parentSessionId: string;
  threadId: string;
  mergedResultRevision: number;
  mergeOperationId: string;
  windowOpenedAt: number;
  parentTreeHash: string;
}

export interface VerificationCoordinatorRuntime {
  workingStates: WorkspaceWorkingStateAccess;
  captureParentIdentity(workspaceId: string, parentRoot: string): Promise<CapturedVerificationIdentity>;
  loadParentWindows?(workspaceId: string, parentSessionId: string, parentRoot: string): Promise<Array<{
    parent: ThreadParent;
    threadId: string;
    bundle: ParentVerificationBundle;
  }>>;
  onProjection?(workspaceId: string, threadId: string, projection: ThreadVerificationProjection): Promise<void> | void;
}

const previewOf = (text: string | undefined): string | undefined => {
  if (!text) return undefined;
  const trimmed = text.replace(/\s+/g, " ").trim();
  return trimmed.length > 240 ? `${trimmed.slice(0, 237)}…` : trimmed;
};

const actorOf = (actor: HarnessActorIdentity): VerificationActorIdentity => ({
  authorityInstanceId: actor.authorityInstanceId,
  sessionId: actor.sessionId,
  workerId: actor.workerId,
  workerGeneration: actor.workerGeneration,
  ...(actor.runId ? { runId: actor.runId } : {}),
});

const sameActor = (left: VerificationActorIdentity | undefined, right: VerificationActorIdentity): boolean => Boolean(
  left
  && left.authorityInstanceId === right.authorityInstanceId
  && left.sessionId === right.sessionId
  && left.workerId === right.workerId
  && left.workerGeneration === right.workerGeneration
  && (left.runId ?? "") === (right.runId ?? ""),
);

const normalizedRoot = (value: string): string => path.resolve(value).replace(/\\/g, "/").toLowerCase();
const sameRoot = (left: string, right: string): boolean => normalizedRoot(left) === normalizedRoot(right);

const reviewIdentityMatches = (left: ResultReviewRecord, right: ResultReviewRecord): boolean => (
  left.reviewThreadId !== undefined
  && right.reviewThreadId === left.reviewThreadId
  && left.reviewRunId !== undefined
  && right.reviewRunId === left.reviewRunId
);

export function createVerificationCoordinator(initialRuntime?: VerificationCoordinatorRuntime) {
  const sessions = new Map<string, SessionBinding>();
  const observations = new Map<string, Map<string, PendingCommandObservation>>();
  const parentWindows = new Map<string, ParentMergeWindow>();
  const loadedParentWindowScopes = new Set<string>();
  let nextBindingGeneration = 0;
  let runtime = initialRuntime;

  const configureRuntime = (next: VerificationCoordinatorRuntime): void => {
    runtime = next;
  };

  const clearObservations = (sessionId: string): void => {
    observations.delete(sessionId);
  };

  const attachThreadSession = (
    sessionId: string,
    binding: Omit<ChildSessionBinding, "scope" | "generation" | "actor">,
  ): void => {
    const existing = sessions.get(sessionId);
    clearObservations(sessionId);
    sessions.set(sessionId, {
      scope: "child",
      ...binding,
      generation: ++nextBindingGeneration,
      ...(existing?.actor ? { actor: existing.actor } : {}),
    });
  };

  const attachParentSession = (
    sessionId: string,
    binding: Omit<ParentSessionBinding, "scope" | "generation" | "actor"> & { actor: HarnessActorIdentity },
  ): void => {
    const existing = sessions.get(sessionId);
    const actor = actorOf(binding.actor);
    if (existing?.scope === "child") {
      if (!sameActor(existing.actor, actor)) {
        clearObservations(sessionId);
        sessions.set(sessionId, { ...existing, actor, generation: ++nextBindingGeneration });
      } else if (!existing.actor) {
        sessions.set(sessionId, { ...existing, actor });
      }
      return;
    }
    clearObservations(sessionId);
    sessions.set(sessionId, {
      scope: "parent",
      workspaceId: binding.workspaceId,
      parentRoot: binding.parentRoot,
      parentSessionId: binding.parentSessionId,
      actor,
      generation: ++nextBindingGeneration,
    });
  };

  const detachSession = (sessionId: string): void => {
    sessions.delete(sessionId);
    clearObservations(sessionId);
  };

  const revokeSessionActor = (sessionId: string): void => {
    const current = sessions.get(sessionId);
    clearObservations(sessionId);
    if (!current || current.scope === "parent") {
      sessions.delete(sessionId);
      return;
    }
    const { actor: _actor, ...binding } = current;
    sessions.set(sessionId, { ...binding, generation: ++nextBindingGeneration });
  };

  const updateChildBinding = (
    sessionId: string,
    update: Pick<Partial<ChildSessionBinding>, "worktreePath" | "branchId" | "captureIdentity">,
  ): void => {
    const current = sessions.get(sessionId);
    if (!current || current.scope !== "child") return;
    sessions.set(sessionId, { ...current, ...update });
  };

  const captureForBinding = async (binding: SessionBinding, cwd: string): Promise<CapturedVerificationIdentity> => {
    const root = binding.scope === "child" ? binding.worktreePath : binding.parentRoot;
    if (!root || !cwdUnderRoot(cwd, root)) return { treeHash: null, reason: "command cwd is outside the materialized result root" };
    try {
      if (binding.scope === "child") {
        return binding.captureIdentity
          ? await binding.captureIdentity()
          : { treeHash: null, reason: "child result identity capture is unavailable" };
      }
      return runtime
        ? await runtime.captureParentIdentity(binding.workspaceId, binding.parentRoot)
        : { treeHash: null, reason: "parent Git identity capture is unavailable" };
    } catch (error) {
      return { treeHash: null, reason: error instanceof Error ? error.message : String(error) };
    }
  };

  const beginCommand = async (input: VerificationCommandStarted): Promise<void> => {
    const binding = sessions.get(input.actor.sessionId);
    const actor = actorOf(input.actor);
    if (!binding || !sameActor(binding.actor, actor)) return;
    if (binding.scope === "child" && actor.runId && actor.runId !== binding.runId) return;
    const captured = await captureForBinding(binding, input.cwd);
    if (sessions.get(input.actor.sessionId)?.generation !== binding.generation) return;
    let current = observations.get(input.actor.sessionId);
    if (!current) {
      current = new Map();
      observations.set(input.actor.sessionId, current);
    }
    current.set(input.executionId, {
      executionId: input.executionId,
      sessionId: input.actor.sessionId,
      binding,
      actor,
      command: input.command,
      commandRunId: input.commandRunId,
      cwd: input.cwd,
      startedAt: input.startedAt,
      ...(captured.treeHash ? { startTreeHash: captured.treeHash } : {}),
      ...(captured.reason ? { identityReason: captured.reason } : {}),
    });
  };

  const commandRecord = (observation: PendingCommandObservation): CommandVerificationRecord | null => {
    if (observation.endedAt === undefined || observation.exitCode === undefined) return null;
    const binding = observation.binding;
    const root = binding.scope === "child" ? binding.worktreePath : binding.parentRoot;
    const insideRoot = Boolean(root && cwdUnderRoot(observation.cwd, root));
    return {
      id: observation.executionId,
      runId: binding.scope === "child"
        ? binding.runId
        : observation.actor.runId ?? `session:${observation.sessionId}@${observation.actor.workerGeneration}`,
      command: observation.command,
      cwd: observation.cwd,
      commandRunId: observation.commandRunId,
      startedAt: observation.startedAt,
      endedAt: observation.endedAt,
      exitCode: observation.exitCode,
      cancelled: observation.cancelled === true,
      ...(observation.outputHandle ? { outputHandle: observation.outputHandle } : {}),
      ...(observation.outputPreview ? { outputPreview: observation.outputPreview } : {}),
      actor: observation.actor,
      bindingGeneration: binding.generation,
      inputIdentity: insideRoot
        ? {
            kind: "tree",
            ...(binding.scope === "child" && binding.branchId ? { branchId: binding.branchId } : {}),
            ...(root ? { root } : {}),
            ...(observation.startTreeHash ? { startTreeHash: observation.startTreeHash } : {}),
            ...(observation.endTreeHash ? { endTreeHash: observation.endTreeHash } : {}),
            ...(observation.identityReason ? { reason: observation.identityReason } : {}),
          }
        : { kind: "unbound", reason: observation.identityReason ?? "command cwd is outside the materialized result root" },
      inputChangedDuringRun: observation.startTreeHash && observation.endTreeHash
        ? observation.startTreeHash !== observation.endTreeHash
        : null,
      relationToPublished: "uncertain",
    };
  };

  const projectFromStore = (
    store: WorkingStateStore,
    threadId: string,
    currentResultRevision?: number,
  ): ThreadVerificationProjection => {
    const latestChild = store.listChildVerifications(threadId).at(-1);
    const effectiveRevision = currentResultRevision ?? latestChild?.resultRevision;
    const child = effectiveRevision === undefined
      ? undefined
      : store.getChildVerification(threadId, effectiveRevision) ?? undefined;
    const parent = store.getParentVerification(threadId) ?? undefined;
    const review = effectiveRevision === undefined
      ? store.listReviewRecords(threadId).at(-1)
      : store.getReviewRecord(threadId, effectiveRevision) ?? undefined;
    return projectThreadVerification({
      ...(effectiveRevision !== undefined ? { currentResultRevision: effectiveRevision } : {}),
      ...(child ? { child } : {}),
      ...(parent ? { parent } : {}),
      ...(review ? { review } : {}),
    });
  };

  const projectParentCompletion = async (window: ParentMergeWindow, record: CommandVerificationRecord): Promise<void> => {
    if (!runtime) return;
    const projection = await runtime.workingStates.withStore(
      window.workspaceId,
      "thread-parent-verification-complete",
      async (store) => {
        const existing = store.getParentVerification(window.threadId, window.mergedResultRevision);
        if (!existing || existing.mergeOperationId !== window.mergeOperationId) {
          return projectFromStore(store, window.threadId);
        }
        if (existing.checks.some((check) => check.id === record.id)) return projectFromStore(store, window.threadId);
        const checks = [...existing.checks, { ...record, relationToPublished: "post-merge-matching-tree" as const }];
        await store.putParentVerification(window.threadId, {
          ...existing,
          recordedAt: Date.now(),
          binding: "bound",
          note: "Observed command boundaries matched the post-merge Git identity (HEAD plus tracked, staged, unstaged, and non-ignored untracked paths)",
          checks,
        });
        return projectFromStore(store, window.threadId);
      },
    );
    await runtime.onProjection?.(window.workspaceId, window.threadId, projection);
  };

  const completeCommand = async (input: VerificationCommandCompleted): Promise<void> => {
    const current = observations.get(input.actor.sessionId);
    const observation = current?.get(input.executionId);
    if (!observation || !sameActor(observation.actor, actorOf(input.actor))) return;
    const activeBinding = sessions.get(input.actor.sessionId);
    if (!activeBinding || activeBinding.generation !== observation.binding.generation) {
      current?.delete(input.executionId);
      return;
    }
    const captured = await captureForBinding(observation.binding, observation.cwd);
    if (sessions.get(input.actor.sessionId)?.generation !== observation.binding.generation) {
      current?.delete(input.executionId);
      return;
    }
    observation.endedAt = input.endedAt;
    observation.exitCode = input.exitCode;
    observation.cancelled = input.cancelled;
    if (input.outputHandle !== undefined) observation.outputHandle = input.outputHandle;
    const outputPreview = previewOf(input.outputPreview);
    if (outputPreview !== undefined) observation.outputPreview = outputPreview;
    if (captured.treeHash) observation.endTreeHash = captured.treeHash;
    if (captured.reason) observation.identityReason = [observation.identityReason, captured.reason].filter(Boolean).join("; ");
    const parentSessionId = observation.sessionId;
    const parentRoot = observation.binding.scope === "parent"
      ? observation.binding.parentRoot
      : observation.binding.worktreePath;
    if (!parentRoot) return;
    const parentWindowScope = `${observation.binding.workspaceId}\0${parentSessionId}\0${normalizedRoot(parentRoot)}`;
    if (!loadedParentWindowScopes.has(parentWindowScope) && runtime?.loadParentWindows) {
      const persisted = await runtime.loadParentWindows(observation.binding.workspaceId, parentSessionId, parentRoot);
      for (const item of persisted) {
        const bundle = item.bundle;
        if (!bundle.mergeOperationId || !bundle.parentTreeHash || bundle.windowOpenedAt === undefined
          || bundle.draftUnsaved || bundle.binding === "not-integrated") continue;
        const key = `${observation.binding.workspaceId}\0${item.threadId}\0${bundle.mergedResultRevision}\0${bundle.mergeOperationId}\0${parentSessionId}`;
        if (!parentWindows.has(key)) parentWindows.set(key, {
          key,
          workspaceId: observation.binding.workspaceId,
          parent: item.parent,
          parentRoot,
          parentSessionId,
          threadId: item.threadId,
          mergedResultRevision: bundle.mergedResultRevision,
          mergeOperationId: bundle.mergeOperationId,
          windowOpenedAt: bundle.windowOpenedAt,
          parentTreeHash: bundle.parentTreeHash,
        });
      }
      loadedParentWindowScopes.add(parentWindowScope);
    }
    const currentBinding = sessions.get(input.actor.sessionId);
    if (!currentBinding
      || currentBinding.generation !== observation.binding.generation
      || !sameActor(currentBinding.actor, observation.actor)) {
      current?.delete(input.executionId);
      return;
    }
    if (observation.binding.scope === "parent") current?.delete(input.executionId);
    const record = commandRecord(observation);
    if (!record || !observation.startTreeHash || !observation.endTreeHash
      || observation.startTreeHash !== observation.endTreeHash) return;
    const matches = [...parentWindows.values()].filter((window) => (
      window.workspaceId === observation.binding.workspaceId
      && window.parentSessionId === parentSessionId
      && sameRoot(window.parentRoot, parentRoot)
      && observation.startedAt >= window.windowOpenedAt
      && observation.startTreeHash === window.parentTreeHash
    ));
    for (const window of matches) await projectParentCompletion(window, record);
  };

  const bindPublishedResult = async (
    store: WorkingStateStore,
    input: {
      workspaceId: string;
      threadId: string;
      runId: string;
      branchId: string;
      resultRevision: number;
      worktreePath?: string;
    },
  ): Promise<ThreadVerificationProjection> => {
    const published = store.getResult(input.branchId, input.resultRevision);
    const createdAt = published ? Date.parse(published.createdAt) : Number.NaN;
    const publishedAt = Number.isFinite(createdAt) ? createdAt : Date.now();
    const hasPublicationBoundary = Number.isFinite(createdAt);
    const resultTreeHash = store.resultTreeIdentity(input.branchId, input.resultRevision) ?? undefined;
    const selected: Array<{ sessionId: string; executionId: string; record: CommandVerificationRecord }> = [];
    for (const [sessionId, binding] of sessions) {
      if (binding.scope !== "child" || binding.workspaceId !== input.workspaceId || binding.threadId !== input.threadId
        || binding.runId !== input.runId || (binding.branchId && binding.branchId !== input.branchId)) continue;
      for (const observation of observations.get(sessionId)?.values() ?? []) {
        if (!hasPublicationBoundary || observation.binding.generation !== binding.generation || observation.endedAt === undefined
          || observation.endedAt > publishedAt) continue;
        const record = commandRecord(observation);
        if (record) selected.push({ sessionId, executionId: observation.executionId, record });
      }
    }
    const bundle = bindCommandsToPublishedResult({
      branchId: input.branchId,
      resultRevision: input.resultRevision,
      runId: input.runId,
      publishedAt,
      commands: selected.map((item) => item.record),
      ...(resultTreeHash ? { resultTreeHash } : {}),
      ...(input.worktreePath ? { worktreePath: input.worktreePath } : {}),
    });
    await store.putChildVerification(input.threadId, bundle);
    for (const item of selected) observations.get(item.sessionId)?.delete(item.executionId);
    return projectFromStore(store, input.threadId, input.resultRevision);
  };

  const captureParentInput = async (workspaceId: string, parentRoot: string): Promise<CapturedVerificationIdentity> => {
    if (!runtime) return { treeHash: null, reason: "parent Git identity capture is unavailable" };
    try {
      return await runtime.captureParentIdentity(workspaceId, parentRoot);
    } catch (error) {
      return { treeHash: null, reason: error instanceof Error ? error.message : String(error) };
    }
  };

  const recordParentMerge = async (
    store: WorkingStateStore,
    input: {
      workspaceId: string;
      parent: ThreadParent;
      parentRoot: string;
      parentSessionId: string | null;
      threadId: string;
      mergedResultRevision: number;
      mergeOperationId: string;
      integrated: boolean;
      draftUnsaved: boolean;
      parentIdentity: CapturedVerificationIdentity;
    },
  ): Promise<ThreadVerificationProjection> => {
    const windowOpenedAt = Date.now();
    for (const [key, window] of parentWindows) {
      if (window.workspaceId === input.workspaceId && window.threadId === input.threadId
        && window.mergedResultRevision === input.mergedResultRevision) parentWindows.delete(key);
    }
    const bundle: ParentVerificationBundle = input.draftUnsaved
      ? {
          mergedResultRevision: input.mergedResultRevision,
          mergeOperationId: input.mergeOperationId,
          windowOpenedAt,
          recordedAt: windowOpenedAt,
          draftUnsaved: true,
          binding: "cannot-verify-unsaved-draft",
          note: "Draft merge did not save; disk commands cannot verify unsaved buffers",
          checks: [],
        }
      : !input.integrated
        ? {
            mergedResultRevision: input.mergedResultRevision,
            mergeOperationId: input.mergeOperationId,
            windowOpenedAt,
            recordedAt: windowOpenedAt,
            draftUnsaved: false,
            binding: "not-integrated",
            note: "Integration did not completely apply this result revision; no post-merge verification window was opened",
            checks: [],
          }
      : {
          mergedResultRevision: input.mergedResultRevision,
          mergeOperationId: input.mergeOperationId,
          windowOpenedAt,
          ...(input.parentIdentity.treeHash ? { parentTreeHash: input.parentIdentity.treeHash } : {}),
          recordedAt: windowOpenedAt,
          draftUnsaved: false,
          binding: "not-recorded",
          note: input.parentIdentity.treeHash
            ? "Waiting for a parent command whose observed boundaries match this merge operation's Git identity (HEAD plus tracked, staged, unstaged, and non-ignored untracked paths)"
            : `Post-merge Git identity is unavailable; parent commands remain uncertain${input.parentIdentity.reason ? `: ${input.parentIdentity.reason}` : ""}`,
          checks: [],
        };
    await store.putParentVerification(input.threadId, bundle);
    if (!input.draftUnsaved && input.integrated && input.parentIdentity.treeHash && input.parentSessionId) {
      const key = `${input.workspaceId}\0${input.threadId}\0${input.mergedResultRevision}\0${input.mergeOperationId}\0${input.parentSessionId}`;
      parentWindows.set(key, {
        key,
        workspaceId: input.workspaceId,
        parent: input.parent,
        parentRoot: input.parentRoot,
        parentSessionId: input.parentSessionId,
        threadId: input.threadId,
        mergedResultRevision: input.mergedResultRevision,
        mergeOperationId: input.mergeOperationId,
        windowOpenedAt,
        parentTreeHash: input.parentIdentity.treeHash,
      });
    }
    return projectFromStore(store, input.threadId, input.mergedResultRevision);
  };

  const putReview = async (
    store: WorkingStateStore,
    threadId: string,
    record: ResultReviewRecord,
    currentResultRevision?: number,
  ): Promise<ThreadVerificationProjection> => {
    const existing = store.getReviewRecord(threadId, record.resultRevision);
    if (existing) {
      if (existing.status === "completed") return projectFromStore(store, threadId, currentResultRevision);
      if (record.status === "running") {
        if (existing.status === "running") return projectFromStore(store, threadId, currentResultRevision);
      } else if (existing.status !== "running") {
        return projectFromStore(store, threadId, currentResultRevision);
      } else if (existing.reviewThreadId || existing.reviewRunId) {
        if (!reviewIdentityMatches(existing, record)) return projectFromStore(store, threadId, currentResultRevision);
        if (record.recordedAt < existing.recordedAt) return projectFromStore(store, threadId, currentResultRevision);
      }
    }
    await store.putReviewRecord(threadId, record);
    return projectFromStore(store, threadId, currentResultRevision);
  };

  return {
    configureRuntime,
    attachThreadSession,
    attachParentSession,
    detachSession,
    revokeSessionActor,
    updateChildBinding,
    beginCommand,
    completeCommand,
    bindPublishedResult,
    captureParentInput,
    recordParentMerge,
    projectFromStore,
    putReview,
    sessionBinding(sessionId: string): SessionBinding | undefined {
      return sessions.get(sessionId);
    },
  };
}

export type VerificationCoordinator = ReturnType<typeof createVerificationCoordinator>;
