import { createHash, randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type {
  RecoveryApplyResult,
  RecoveryCheckpoint,
  RecoveryListResult,
  RecoveryMode,
  RecoveryPoint,
  RecoveryPreview,
  RecoveryTurn,
  SessionSnapshot,
} from "@piarium/protocol";
import { readJsonFile, writeJsonAtomic } from "./atomic.js";
import { FileLease } from "./lease.js";
import { ShadowGitStore } from "./shadow-git.js";

const STATE_VERSION = 1;
const PLAN_TTL_MS = 5 * 60_000;
const MAX_TURNS = 200;
const MAX_CHECKPOINTS = 50;
const MAX_HISTORY = 20;
const MAX_PREVIEW_CHANGES = 500;

interface RecoveryFrame {
  appliedAt: string;
  fromCommit: string;
  fromLeafId: string | null;
  id: string;
  mode: RecoveryMode;
  toCommit: string;
  toLeafId: string | null;
}

interface SessionRecoveryState {
  checkpoints: RecoveryCheckpoint[];
  redo: RecoveryFrame[];
  turns: RecoveryTurn[];
  undo: RecoveryFrame[];
}

interface RecoveryState {
  cwd: string;
  pending: Record<string, PendingTurn>;
  sessions: Record<string, SessionRecoveryState>;
  version: 1;
}

interface PendingTurn {
  beforeCommit: string;
  hasImages: boolean;
  id: string;
  parentLeafId: string | null;
  sessionId: string;
  startedAt: string;
}

interface RecoveryPlanInternal {
  currentCommit: string;
  currentLeafId: string | null;
  expiresAt: number;
  id: string;
  mode: RecoveryMode;
  point: RecoveryPoint;
  sessionId: string;
  targetCommit: string;
  targetId: string;
  targetKind: "checkpoint" | "turn";
  targetLeafId: string | null;
}

interface RecoveryJournal {
  action: "apply" | "redo" | "undo";
  frame: RecoveryFrame;
  historyFrame: RecoveryFrame;
  ownerPid: number;
  phase: "prepared" | "files-restored" | "conversation-restored";
  sessionId: string;
  version: 1;
}

export interface ConversationRestoreResult {
  cancelled: boolean;
  editorText?: string;
}

export interface RecoveryCoordinatorOptions {
  agentDir: string;
  cwd: string;
  gitPath?: string;
  onChanged?: (sessionId: string) => void;
  onStatus?: (sessionId: string, available: boolean, issue?: string) => void;
}

export interface FinishTurnInput {
  entries: unknown[];
  leafId: string | null;
  sessionId: string;
}

export interface ApplyRecoveryInput {
  currentLeafId: string | null;
  navigate(targetLeafId: string): Promise<ConversationRestoreResult>;
  planId: string;
  sessionId: string;
  snapshot(): SessionSnapshot;
}

function emptySessionState(): SessionRecoveryState {
  return { checkpoints: [], redo: [], turns: [], undo: [] };
}

function workspaceKey(cwd: string): string {
  const normalized = process.platform === "win32" ? resolve(cwd).toLowerCase() : resolve(cwd);
  return createHash("sha256").update(normalized).digest("hex").slice(0, 24);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function findUserEntry(entries: unknown[], parentLeafId: string | null): string | undefined {
  let start = 0;
  if (parentLeafId) {
    const parentIndex = entries.findIndex((entry) => asRecord(entry)?.id === parentLeafId);
    start = parentIndex === -1 ? 0 : parentIndex + 1;
  }
  for (let index = start; index < entries.length; index += 1) {
    const entry = asRecord(entries[index]);
    const message = asRecord(entry?.message);
    if (entry?.type === "message" && message?.role === "user" && typeof entry.id === "string") {
      return entry.id;
    }
  }
  return undefined;
}

function readRecoveryTurn(value: unknown, sessionId: string): RecoveryTurn | undefined {
  const turn = asRecord(value);
  if (
    typeof turn?.id !== "string" ||
    turn.sessionId !== sessionId ||
    typeof turn.beforeCommit !== "string" ||
    typeof turn.afterCommit !== "string" ||
    typeof turn.startedAt !== "string" ||
    typeof turn.completedAt !== "string" ||
    typeof turn.userEntryId !== "string" ||
    typeof turn.resultLeafId !== "string" ||
    typeof turn.hasImages !== "boolean" ||
    (turn.parentLeafId !== null && typeof turn.parentLeafId !== "string")
  ) {
    return undefined;
  }
  return turn as unknown as RecoveryTurn;
}

function normalizeState(value: RecoveryState | undefined, cwd: string): RecoveryState {
  if (
    value?.version !== STATE_VERSION ||
    value.cwd !== cwd ||
    typeof value.sessions !== "object" ||
    value.sessions === null
  ) {
    return { cwd, pending: {}, sessions: {}, version: STATE_VERSION };
  }
  return {
    ...value,
    pending: typeof value.pending === "object" && value.pending !== null ? value.pending : {},
  };
}

export class RecoveryCoordinator {
  readonly cwd: string;
  readonly root: string;
  readonly #journalPath: string;
  readonly #leasePath: string;
  readonly #onChanged: ((sessionId: string) => void) | undefined;
  readonly #onStatus: RecoveryCoordinatorOptions["onStatus"];
  readonly #plans = new Map<string, RecoveryPlanInternal>();
  readonly #statePath: string;
  readonly #store: ShadowGitStore;
  #issue: string | undefined;
  #pending: PendingTurn | undefined;

  constructor(options: RecoveryCoordinatorOptions) {
    this.cwd = resolve(options.cwd);
    this.root = join(
      resolve(options.agentDir),
      "piarium",
      "recovery",
      "v1",
      workspaceKey(this.cwd),
    );
    this.#statePath = join(this.root, "state.json");
    this.#journalPath = join(this.root, "transaction.json");
    this.#leasePath = join(this.root, "workspace.lock");
    this.#onChanged = options.onChanged;
    this.#onStatus = options.onStatus;
    this.#store = new ShadowGitStore({
      cwd: this.cwd,
      excludePaths: [resolve(options.agentDir)],
      root: join(this.root, "shadow"),
      ...(options.gitPath === undefined ? {} : { gitPath: options.gitPath }),
    });
  }

  async beginTurn(
    sessionId: string,
    parentLeafId: string | null,
    hasImages: boolean,
  ): Promise<void> {
    if (this.#pending) return;
    try {
      await this.#withLease(async () => {
        await this.#recoverInterruptedLocked(sessionId, parentLeafId);
        const pending: PendingTurn = {
          beforeCommit: await this.#store.snapshot("Piarium turn: before"),
          hasImages,
          id: randomUUID(),
          parentLeafId,
          sessionId,
          startedAt: new Date().toISOString(),
        };
        const state = await this.#readState();
        state.pending[sessionId] = pending;
        await this.#writeState(state);
        this.#pending = pending;
      });
      this.#setIssue(sessionId, undefined);
    } catch (error) {
      this.#pending = undefined;
      this.#setIssue(sessionId, error instanceof Error ? error.message : String(error));
    }
  }

  async finishTurn(input: FinishTurnInput): Promise<RecoveryTurn | undefined> {
    const pending = this.#pending;
    if (!pending || pending.sessionId !== input.sessionId) return undefined;
    this.#pending = undefined;
    try {
      const turn = await this.#withLease(async () => {
        const userEntryId = findUserEntry(input.entries, pending.parentLeafId);
        if (!userEntryId) throw new Error("Could not associate the settled run with a user entry");
        const afterCommit = await this.#store.snapshot("Piarium turn: after");
        const state = await this.#readState();
        delete state.pending[input.sessionId];
        const session = this.#sessionState(state, input.sessionId);
        const value: RecoveryTurn = {
          afterCommit,
          beforeCommit: pending.beforeCommit,
          completedAt: new Date().toISOString(),
          hasImages: pending.hasImages,
          id: pending.id,
          parentLeafId: pending.parentLeafId,
          resultLeafId: input.leafId ?? userEntryId,
          sessionId: input.sessionId,
          startedAt: pending.startedAt,
          userEntryId,
        };
        session.turns.push(value);
        session.turns = session.turns.slice(-MAX_TURNS);
        await this.#writeState(state);
        await this.#pruneSnapshots(state);
        return value;
      });
      this.#setIssue(input.sessionId, undefined);
      this.#onChanged?.(input.sessionId);
      return turn;
    } catch (error) {
      this.#setIssue(input.sessionId, error instanceof Error ? error.message : String(error));
      return undefined;
    }
  }

  async reconcileSession(sessionId: string, entries: unknown[]): Promise<void> {
    const recovered = entries.flatMap((entry) => {
      const record = asRecord(entry);
      if (record?.type !== "custom" || record.customType !== "piarium.recovery.turn/v1") return [];
      const turn = readRecoveryTurn(record.data, sessionId);
      return turn ? [turn] : [];
    });
    if (recovered.length === 0) return;
    await this.#withLease(async () => {
      const state = await this.#readState();
      const session = this.#sessionState(state, sessionId);
      const known = new Set(session.turns.map((turn) => turn.id));
      const additions = recovered.filter((turn) => !known.has(turn.id));
      if (additions.length === 0) return;
      session.turns.push(...additions);
      session.turns.sort((left, right) => left.completedAt.localeCompare(right.completedAt));
      session.turns = session.turns.slice(-MAX_TURNS);
      await this.#writeState(state);
      await this.#pruneSnapshots(state);
    });
  }

  async list(sessionId: string, currentLeafId: string | null): Promise<RecoveryListResult> {
    let gitPath: string | undefined;
    try {
      await this.#withLease(async () => {
        gitPath = await this.#store.ensure();
        await this.#recoverInterruptedLocked(sessionId, currentLeafId);
      });
      this.#setIssue(sessionId, undefined);
    } catch (error) {
      this.#setIssue(sessionId, error instanceof Error ? error.message : String(error));
    }
    const state = await this.#readState();
    const session = this.#sessionState(state, sessionId);
    return {
      available: this.#issue === undefined,
      canRedo: session.redo.length > 0,
      canUndo: session.undo.length > 0,
      checkpoints: structuredClone(session.checkpoints).reverse(),
      ...(gitPath === undefined ? {} : { gitPath }),
      ...(this.#issue === undefined ? {} : { issue: this.#issue }),
      root: this.root,
      turns: structuredClone(session.turns).reverse(),
    };
  }

  async createCheckpoint(
    sessionId: string,
    leafId: string | null,
    name: string,
  ): Promise<RecoveryCheckpoint> {
    const normalizedName = name.trim();
    if (!normalizedName || normalizedName.length > 120) {
      throw new Error("Checkpoint name must contain 1–120 characters");
    }
    const checkpoint = await this.#withLease(async () => {
      await this.#recoverInterruptedLocked(sessionId, leafId);
      const value: RecoveryCheckpoint = {
        commit: await this.#store.snapshot(`Piarium checkpoint: ${normalizedName}`),
        createdAt: new Date().toISOString(),
        id: randomUUID(),
        leafId,
        name: normalizedName,
        sessionId,
      };
      const state = await this.#readState();
      const session = this.#sessionState(state, sessionId);
      session.checkpoints.push(value);
      session.checkpoints = session.checkpoints.slice(-MAX_CHECKPOINTS);
      await this.#writeState(state);
      await this.#pruneSnapshots(state);
      return value;
    });
    this.#onChanged?.(sessionId);
    return checkpoint;
  }

  async preview(input: {
    currentLeafId: string | null;
    mode: RecoveryMode;
    point: RecoveryPoint;
    sessionId: string;
    targetId: string;
    targetKind: "checkpoint" | "turn";
  }): Promise<RecoveryPreview> {
    return this.#withLease(async () => {
      await this.#recoverInterruptedLocked(input.sessionId, input.currentLeafId);
      const state = await this.#readState();
      const session = this.#sessionState(state, input.sessionId);
      let targetCommit: string;
      let targetLeafId: string | null;
      if (input.targetKind === "turn") {
        const turn = session.turns.find((entry) => entry.id === input.targetId);
        if (!turn) throw new Error("Recovery turn was not found");
        targetCommit = input.point === "before" ? turn.beforeCommit : turn.afterCommit;
        targetLeafId =
          input.point === "before" ? (turn.parentLeafId ?? turn.userEntryId) : turn.resultLeafId;
      } else {
        const checkpoint = session.checkpoints.find((entry) => entry.id === input.targetId);
        if (!checkpoint) throw new Error("Recovery checkpoint was not found");
        targetCommit = checkpoint.commit;
        targetLeafId = checkpoint.leafId;
      }
      if (input.mode !== "files" && !targetLeafId) {
        throw new Error("This checkpoint has no conversation position; choose files-only recovery");
      }
      const currentCommit = await this.#store.snapshot("Piarium recovery preview");
      const allChanges =
        input.mode === "conversation" ? [] : await this.#store.diff(currentCommit, targetCommit);
      const id = randomUUID();
      const expiresAt = Date.now() + PLAN_TTL_MS;
      this.#plans.set(id, {
        currentCommit,
        currentLeafId: input.currentLeafId,
        expiresAt,
        id,
        mode: input.mode,
        point: input.point,
        sessionId: input.sessionId,
        targetCommit,
        targetId: input.targetId,
        targetKind: input.targetKind,
        targetLeafId,
      });
      return {
        changes: allChanges.slice(0, MAX_PREVIEW_CHANGES),
        currentLeafId: input.currentLeafId,
        expiresAt: new Date(expiresAt).toISOString(),
        mode: input.mode,
        planId: id,
        point: input.point,
        targetId: input.targetId,
        targetKind: input.targetKind,
        totalChanges: allChanges.length,
        truncated: allChanges.length > MAX_PREVIEW_CHANGES,
      };
    });
  }

  async apply(input: ApplyRecoveryInput): Promise<RecoveryApplyResult> {
    const plan = this.#plans.get(input.planId);
    if (!plan || plan.sessionId !== input.sessionId)
      throw new Error("Recovery preview is unavailable");
    if (plan.expiresAt < Date.now()) {
      this.#plans.delete(plan.id);
      throw new Error("Recovery preview expired; review the changes again");
    }
    const result = await this.#applyPlan(plan, input.currentLeafId, input.navigate, "apply");
    this.#plans.delete(plan.id);
    return { ...result, mode: plan.mode, snapshot: input.snapshot() };
  }

  async undo(input: Omit<ApplyRecoveryInput, "planId">): Promise<RecoveryApplyResult> {
    const result = await this.#applyHistory(
      input.sessionId,
      "undo",
      input.currentLeafId,
      input.navigate,
    );
    const state = await this.#readState();
    const frame = this.#sessionState(state, input.sessionId).redo.at(-1);
    if (!frame) throw new Error("Recovery undo did not produce a history entry");
    return { ...result, mode: frame.mode, snapshot: input.snapshot() };
  }

  async redo(input: Omit<ApplyRecoveryInput, "planId">): Promise<RecoveryApplyResult> {
    const result = await this.#applyHistory(
      input.sessionId,
      "redo",
      input.currentLeafId,
      input.navigate,
    );
    const state = await this.#readState();
    const frame = this.#sessionState(state, input.sessionId).undo.at(-1);
    if (!frame) throw new Error("Recovery redo did not produce a history entry");
    return { ...result, mode: frame.mode, snapshot: input.snapshot() };
  }

  async #applyPlan(
    plan: RecoveryPlanInternal,
    currentLeafId: string | null,
    navigate: ApplyRecoveryInput["navigate"],
    historyAction: "apply" | "redo" | "undo",
  ): Promise<ConversationRestoreResult> {
    return this.#withLease(async () => {
      await this.#recoverInterruptedLocked(plan.sessionId, currentLeafId);
      if (currentLeafId !== plan.currentLeafId)
        throw new Error("Conversation changed after preview");
      const safetyCommit = await this.#store.snapshot("Piarium recovery safety checkpoint");
      if (
        plan.mode !== "conversation" &&
        !(await this.#store.sameTree(safetyCommit, plan.currentCommit))
      ) {
        throw new Error("Workspace changed after preview; review the changes again");
      }
      const frame: RecoveryFrame = {
        appliedAt: new Date().toISOString(),
        fromCommit: safetyCommit,
        fromLeafId: currentLeafId,
        id: randomUUID(),
        mode: plan.mode,
        toCommit: plan.targetCommit,
        toLeafId: plan.targetLeafId,
      };
      return this.#executeFrame(plan.sessionId, frame, navigate, historyAction);
    });
  }

  async #applyHistory(
    sessionId: string,
    action: "undo" | "redo",
    currentLeafId: string | null,
    navigate: ApplyRecoveryInput["navigate"],
  ): Promise<ConversationRestoreResult> {
    return this.#withLease(async () => {
      await this.#recoverInterruptedLocked(sessionId, currentLeafId);
      const state = await this.#readState();
      const session = this.#sessionState(state, sessionId);
      const frame = (action === "undo" ? session.undo : session.redo).at(-1);
      if (!frame) {
        throw new Error(
          action === "undo"
            ? "There is no recovery operation to undo"
            : "There is no recovery operation to redo",
        );
      }
      const reversed = action === "undo";
      const expectedLeafId = reversed ? frame.toLeafId : frame.fromLeafId;
      const expectedCommit = reversed ? frame.toCommit : frame.fromCommit;
      if (currentLeafId !== expectedLeafId) {
        throw new Error("Conversation diverged from recovery history");
      }
      if (frame.mode !== "conversation") {
        const currentCommit = await this.#store.snapshot("Piarium recovery history check");
        if (!(await this.#store.sameTree(currentCommit, expectedCommit))) {
          throw new Error("Workspace diverged from recovery history");
        }
      }
      return this.#executeFrame(sessionId, frame, navigate, action);
    });
  }

  async #executeFrame(
    sessionId: string,
    originalFrame: RecoveryFrame,
    navigate: ApplyRecoveryInput["navigate"],
    action: "apply" | "redo" | "undo",
  ): Promise<ConversationRestoreResult> {
    const reversed = action === "undo";
    const targetCommit = reversed ? originalFrame.fromCommit : originalFrame.toCommit;
    const targetLeafId = reversed ? originalFrame.fromLeafId : originalFrame.toLeafId;
    const rollbackCommit = reversed ? originalFrame.toCommit : originalFrame.fromCommit;
    const rollbackLeafId = reversed ? originalFrame.toLeafId : originalFrame.fromLeafId;
    const frame: RecoveryFrame = {
      ...originalFrame,
      fromCommit: rollbackCommit,
      fromLeafId: rollbackLeafId,
      toCommit: targetCommit,
      toLeafId: targetLeafId,
    };
    const journal: RecoveryJournal = {
      action,
      frame,
      historyFrame: originalFrame,
      ownerPid: process.pid,
      phase: "prepared",
      sessionId,
      version: 1,
    };
    await writeJsonAtomic(this.#journalPath, journal);
    let conversation: ConversationRestoreResult = { cancelled: false };
    let conversationMoved = false;
    try {
      if (frame.mode !== "conversation") {
        await this.#store.restore(targetCommit);
        journal.phase = "files-restored";
        await writeJsonAtomic(this.#journalPath, journal);
      }
      if (frame.mode !== "files" && targetLeafId !== rollbackLeafId) {
        if (!targetLeafId) throw new Error("Recovery target has no conversation position");
        conversation = await navigate(targetLeafId);
        if (conversation.cancelled) throw new Error("Conversation recovery was cancelled");
        conversationMoved = true;
        journal.phase = "conversation-restored";
        await writeJsonAtomic(this.#journalPath, journal);
      }
      const state = await this.#readState();
      const session = this.#sessionState(state, sessionId);
      this.#recordHistory(session, originalFrame, action);
      await this.#writeState(state);
      await this.#pruneSnapshots(state);
      await rm(this.#journalPath, { force: true });
      this.#onChanged?.(sessionId);
      return conversation;
    } catch (error) {
      const rollbackErrors: unknown[] = [];
      if (conversationMoved && rollbackLeafId && rollbackLeafId !== targetLeafId) {
        try {
          await navigate(rollbackLeafId);
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
      if (frame.mode !== "conversation") {
        try {
          await this.#store.restore(rollbackCommit);
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
      await rm(this.#journalPath, { force: true });
      if (conversation.cancelled) return conversation;
      if (rollbackErrors.length > 0) {
        throw new AggregateError(
          [error, ...rollbackErrors],
          "Recovery failed and rollback was incomplete",
        );
      }
      throw error;
    }
  }

  async #recoverInterruptedLocked(sessionId: string, currentLeafId: string | null): Promise<void> {
    const journal = await readJsonFile<RecoveryJournal>(this.#journalPath);
    if (journal?.version !== 1) return;
    const targetReached =
      journal.sessionId === sessionId && currentLeafId === journal.frame.toLeafId;
    if (targetReached) {
      if (journal.frame.mode !== "conversation") await this.#store.restore(journal.frame.toCommit);
      const state = await this.#readState();
      const session = this.#sessionState(state, journal.sessionId);
      this.#recordHistory(session, journal.historyFrame, journal.action);
      await this.#writeState(state);
      await this.#pruneSnapshots(state);
    } else if (journal.frame.mode !== "conversation") {
      await this.#store.restore(journal.frame.fromCommit);
    }
    await rm(this.#journalPath, { force: true });
  }

  #recordHistory(
    session: SessionRecoveryState,
    frame: RecoveryFrame,
    action: "apply" | "redo" | "undo",
  ): void {
    if (action === "apply") {
      session.undo.push(frame);
      session.undo = session.undo.slice(-MAX_HISTORY);
      session.redo = [];
    } else if (action === "undo") {
      session.undo = session.undo.filter((candidate) => candidate.id !== frame.id);
      session.redo.push(frame);
      session.redo = session.redo.slice(-MAX_HISTORY);
    } else {
      session.redo = session.redo.filter((candidate) => candidate.id !== frame.id);
      session.undo.push(frame);
      session.undo = session.undo.slice(-MAX_HISTORY);
    }
  }

  async #readState(): Promise<RecoveryState> {
    return normalizeState(await readJsonFile<RecoveryState>(this.#statePath), this.cwd);
  }

  async #writeState(state: RecoveryState): Promise<void> {
    await writeJsonAtomic(this.#statePath, state);
  }

  async #pruneSnapshots(state: RecoveryState): Promise<void> {
    const retained = new Set<string>();
    for (const pending of Object.values(state.pending)) retained.add(pending.beforeCommit);
    for (const session of Object.values(state.sessions)) {
      for (const turn of session.turns) {
        retained.add(turn.beforeCommit);
        retained.add(turn.afterCommit);
      }
      for (const checkpoint of session.checkpoints) retained.add(checkpoint.commit);
      for (const frame of [...session.undo, ...session.redo]) {
        retained.add(frame.fromCommit);
        retained.add(frame.toCommit);
      }
    }
    await this.#store.prune(retained);
  }

  #sessionState(state: RecoveryState, sessionId: string): SessionRecoveryState {
    state.sessions[sessionId] ??= emptySessionState();
    return state.sessions[sessionId];
  }

  async #withLease<T>(operation: () => Promise<T>): Promise<T> {
    const lease = await FileLease.acquire(this.#leasePath);
    try {
      return await operation();
    } finally {
      await lease.release();
    }
  }

  #setIssue(sessionId: string, issue: string | undefined): void {
    this.#issue = issue;
    this.#onStatus?.(sessionId, issue === undefined, issue);
  }
}
