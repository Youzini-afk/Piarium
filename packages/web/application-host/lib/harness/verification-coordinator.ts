import { randomUUID } from "node:crypto";
import type { ThreadVerificationProjection } from "@piarium/protocol";
import {
  bindCommandsToPublishedResult,
  cwdUnderRoot,
  inputChangedDuringCommand,
  projectThreadVerification,
} from "./working-state/verification-records.js";
import type {
  CommandVerificationRecord,
  ParentVerificationBundle,
  ResultReviewRecord,
} from "./working-state/types.js";
import type { WorkingStateStore } from "./working-state/working-state-store.js";

export interface PendingCommandObservation {
  id: string;
  sessionId: string;
  command: string;
  cwd: string;
  envSummary?: { PATH?: boolean; VIRTUAL_ENV?: string };
  commandRunId?: string;
  startedAt: number;
  endedAt: number;
  exitCode: number | null;
  cancelled: boolean;
  outputHandle?: string;
  outputPreview?: string;
  pending?: boolean;
}

interface ChildSessionBinding {
  scope: "child";
  workspaceId: string;
  threadId: string;
  runId: string;
  worktreePath?: string;
  branchId?: string;
  lastPublishedRevision?: number;
  lastHeadRevision?: number;
}

interface ParentSessionBinding {
  scope: "parent";
  workspaceId: string;
  parentRoot: string;
  parentSessionId: string;
}

type SessionBinding = ChildSessionBinding | ParentSessionBinding;

const previewOf = (text: string | undefined): string | undefined => {
  if (!text) return undefined;
  const trimmed = text.replace(/\s+/g, " ").trim();
  return trimmed.length > 240 ? `${trimmed.slice(0, 237)}…` : trimmed;
};

export function createVerificationCoordinator() {
  const sessions = new Map<string, SessionBinding>();
  const pendingBySession = new Map<string, PendingCommandObservation[]>();

  const pendingFor = (sessionId: string): PendingCommandObservation[] => {
    const current = pendingBySession.get(sessionId);
    if (current) return current;
    const created: PendingCommandObservation[] = [];
    pendingBySession.set(sessionId, created);
    return created;
  };

  const attachThreadSession = (sessionId: string, binding: Omit<ChildSessionBinding, "scope">): void => {
    sessions.set(sessionId, { scope: "child", ...binding });
  };

  const attachParentSession = (sessionId: string, binding: Omit<ParentSessionBinding, "scope">): void => {
    const existing = sessions.get(sessionId);
    if (existing?.scope === "child") return;
    sessions.set(sessionId, { scope: "parent", ...binding });
  };

  const detachSession = (sessionId: string): void => {
    sessions.delete(sessionId);
  };

  const updateChildHead = (
    sessionId: string,
    update: { lastPublishedRevision?: number; lastHeadRevision?: number; worktreePath?: string; branchId?: string },
  ): void => {
    const current = sessions.get(sessionId);
    if (!current || current.scope !== "child") return;
    sessions.set(sessionId, { ...current, ...update });
  };

  const recordCommand = (input: {
    sessionId: string;
    command: string;
    cwd: string;
    exitCode: number | null;
    cancelled?: boolean;
    commandRunId?: string;
    outputHandle?: string;
    outputPreview?: string;
    durationMs?: number;
    pending?: boolean;
    envSummary?: { PATH?: boolean; VIRTUAL_ENV?: string };
  }): PendingCommandObservation | null => {
    const binding = sessions.get(input.sessionId);
    if (!binding) return null;
    const endedAt = Date.now();
    const observation: PendingCommandObservation = {
      id: `cmd-${randomUUID().slice(0, 8)}`,
      sessionId: input.sessionId,
      command: input.command,
      cwd: input.cwd,
      startedAt: input.durationMs !== undefined ? endedAt - input.durationMs : endedAt,
      endedAt,
      exitCode: input.exitCode,
      cancelled: input.cancelled === true,
      ...(input.envSummary ? { envSummary: input.envSummary } : {}),
      ...(input.commandRunId ? { commandRunId: input.commandRunId } : {}),
      ...(input.outputHandle ? { outputHandle: input.outputHandle } : {}),
      ...(previewOf(input.outputPreview) ? { outputPreview: previewOf(input.outputPreview) } : {}),
      ...(input.pending ? { pending: true } : {}),
    };
    pendingFor(input.sessionId).push(observation);
    return observation;
  };

  const completeBackgroundCommand = (sessionId: string, commandRunId: string, exitCode: number): void => {
    const list = pendingBySession.get(sessionId);
    if (!list) return;
    const match = [...list].reverse().find((item) => item.commandRunId === commandRunId && item.pending);
    if (!match) return;
    match.pending = false;
    match.exitCode = exitCode;
    match.endedAt = Date.now();
  };

  const snapshotForBind = (
    observation: PendingCommandObservation,
    binding: ChildSessionBinding,
  ): Parameters<typeof bindCommandsToPublishedResult>[0]["commands"][number] => ({
    ...observation,
    runId: binding.runId,
    startPublishedRevision: binding.lastPublishedRevision,
    endPublishedRevision: binding.lastPublishedRevision,
    startHeadRevision: binding.lastHeadRevision,
    endHeadRevision: binding.lastHeadRevision,
    branchId: binding.branchId,
  });

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
    const commands: Parameters<typeof bindCommandsToPublishedResult>[0]["commands"] = [];
    for (const [sessionId, binding] of sessions) {
      if (binding.scope !== "child" || binding.threadId !== input.threadId || binding.runId !== input.runId) continue;
      for (const observation of pendingBySession.get(sessionId) ?? []) {
        if (observation.pending) continue;
        commands.push(snapshotForBind(observation, binding));
      }
    }
    const bundle = bindCommandsToPublishedResult({
      branchId: input.branchId,
      resultRevision: input.resultRevision,
      runId: input.runId,
      commands,
      ...(input.worktreePath ? { worktreePath: input.worktreePath } : {}),
    });
    await store.putChildVerification(input.threadId, bundle);
    for (const [sessionId, binding] of sessions) {
      if (binding.scope === "child" && binding.threadId === input.threadId) {
        updateChildHead(sessionId, {
          lastPublishedRevision: input.resultRevision,
          lastHeadRevision: input.resultRevision,
          ...(input.worktreePath ? { worktreePath: input.worktreePath } : {}),
          branchId: input.branchId,
        });
      }
    }
    return projectFromStore(store, input.threadId, input.resultRevision);
  };

  const recordParentMerge = async (
    store: WorkingStateStore,
    input: {
      threadId: string;
      mergedResultRevision: number;
      draftUnsaved: boolean;
    },
  ): Promise<ThreadVerificationProjection> => {
    const existing = store.getParentVerification(input.threadId, input.mergedResultRevision);
    const parentCommands: CommandVerificationRecord[] = [];
    if (!input.draftUnsaved) {
      for (const [sessionId, binding] of sessions) {
        if (binding.scope !== "parent") continue;
        for (const observation of pendingBySession.get(sessionId) ?? []) {
          if (observation.pending || !cwdUnderRoot(observation.cwd, binding.parentRoot)) continue;
          parentCommands.push({
            id: observation.id,
            runId: "parent",
            command: observation.command,
            cwd: observation.cwd,
            startedAt: observation.startedAt,
            endedAt: observation.endedAt,
            exitCode: observation.exitCode,
            cancelled: observation.cancelled,
            ...(observation.envSummary ? { envSummary: observation.envSummary } : {}),
            ...(observation.commandRunId ? { commandRunId: observation.commandRunId } : {}),
            ...(observation.outputHandle ? { outputHandle: observation.outputHandle } : {}),
            ...(observation.outputPreview ? { outputPreview: observation.outputPreview } : {}),
            inputIdentity: {
              kind: "published-revision",
              startPublishedRevision: input.mergedResultRevision,
              endPublishedRevision: input.mergedResultRevision,
            },
            inputChangedDuringRun: inputChangedDuringCommand({}),
            relationToPublished: "uncertain",
          });
        }
      }
    }
    const bundle: ParentVerificationBundle = input.draftUnsaved
      ? {
          mergedResultRevision: input.mergedResultRevision,
          recordedAt: Date.now(),
          draftUnsaved: true,
          binding: "cannot-verify-unsaved-draft",
          note: "Draft merge did not save; disk commands cannot verify unsaved buffers",
          checks: existing?.checks ?? [],
        }
      : parentCommands.length > 0
        ? {
            mergedResultRevision: input.mergedResultRevision,
            recordedAt: Date.now(),
            draftUnsaved: false,
            binding: "uncertain",
            note: "Parent-session commands observed the live parent tree after merge; they are not a child-result check",
            checks: parentCommands,
          }
        : {
            mergedResultRevision: input.mergedResultRevision,
            recordedAt: Date.now(),
            draftUnsaved: false,
            binding: "not-recorded",
            note: "No parent-session command has been recorded against this merged revision",
            checks: existing?.checks ?? [],
          };
    await store.putParentVerification(input.threadId, bundle);
    const child = store.getChildVerification(input.threadId, input.mergedResultRevision)
      ?? store.listChildVerifications(input.threadId).at(-1);
    const review = store.getReviewRecord(input.threadId, child?.resultRevision ?? input.mergedResultRevision);
    return projectThreadVerification({
      currentResultRevision: child?.resultRevision ?? input.mergedResultRevision,
      ...(child ? { child } : {}),
      parent: bundle,
      ...(review ? { review } : {}),
    });
  };

  const projectFromStore = (
    store: WorkingStateStore,
    threadId: string,
    currentResultRevision?: number,
  ): ThreadVerificationProjection => {
    const child = currentResultRevision === undefined
      ? store.listChildVerifications(threadId).at(-1)
      : store.getChildVerification(threadId, currentResultRevision) ?? undefined;
    const parent = store.getParentVerification(threadId) ?? undefined;
    const review = currentResultRevision === undefined
      ? store.listReviewRecords(threadId).at(-1)
      : store.getReviewRecord(threadId, currentResultRevision) ?? undefined;
    return projectThreadVerification({
      ...(currentResultRevision !== undefined ? { currentResultRevision } : {}),
      ...(child ? { child } : {}),
      ...(parent ? { parent } : {}),
      ...(review ? { review } : {}),
    });
  };

  const putReview = async (
    store: WorkingStateStore,
    threadId: string,
    record: ResultReviewRecord,
    currentResultRevision?: number,
  ): Promise<ThreadVerificationProjection> => {
    const existing = store.getReviewRecord(threadId, record.resultRevision);
    if (existing?.status === "completed") {
      if (record.status !== "completed") {
        return projectFromStore(store, threadId, currentResultRevision);
      }
      if (existing.reviewThreadId !== record.reviewThreadId || existing.recordedAt > record.recordedAt) {
        return projectFromStore(store, threadId, currentResultRevision);
      }
    }
    await store.putReviewRecord(threadId, record);
    return projectFromStore(store, threadId, currentResultRevision);
  };

  return {
    attachThreadSession,
    attachParentSession,
    detachSession,
    updateChildHead,
    recordCommand,
    completeBackgroundCommand,
    bindPublishedResult,
    recordParentMerge,
    projectFromStore,
    putReview,
    sessionBinding(sessionId: string): SessionBinding | undefined {
      return sessions.get(sessionId);
    },
  };
}

export type VerificationCoordinator = ReturnType<typeof createVerificationCoordinator>;
