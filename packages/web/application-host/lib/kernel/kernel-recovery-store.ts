import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  WorkspaceRecoveryCheckpointSummary,
  WorkspaceRecoveryEntryBindingResult,
  WorkspaceRecoveryEntryTarget,
  WorkspaceRecoveryMutationAfterInput,
  WorkspaceRecoveryMutationBeforeInput,
  WorkspaceRecoveryTurnBinding,
  WorkspaceRecoveryTurnSettledInput,
  WorkspaceRecoveryTurnStartInput,
} from "@piarium/extension-contract";
import type {
  CapturedState,
  CaptureStateOptions,
  RecoveryFileStore,
  RecoveryIdentity,
  RecoveryState,
} from "../recovery/journal-files.js";
import { createRecoveryFileStore, sameState } from "../recovery/journal-files.js";
import { objectPath } from "../recovery/object-path.js";
import type { WorkspaceRecoveryEngine } from "../recovery/engine.js";
import type { KernelStorageAdapter, KernelStorageReference } from "./storage-adapter.js";

const asObject = (value: unknown): Record<string, unknown> => (
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
);

const recoveryIdentity = (workspaceId: string, canonicalRoot: string): RecoveryIdentity => ({
  authorityId: "kernel",
  canonicalRoot,
  filesystemProfile: process.platform === "win32" ? "windows-local" : `${process.platform}-local`,
  workspaceId,
});

export class KernelRecoveryContentStore implements RecoveryFileStore {
  private readonly delegate = createRecoveryFileStore();
  private readonly owners = new Map<string, Set<string>>();
  private readonly sources = new Map<string, Array<{ workspaceId: string; recordId: string; slot: string }>>();

  constructor(
    private readonly adapter: KernelStorageAdapter,
    private readonly cacheRoot: string,
  ) {}

  private key(workspaceId: string, hash: string): string {
    return `${workspaceId}\0${hash}`;
  }

  registerRecord(workspaceId: string, recordId: string, reference: KernelStorageReference): void {
    const key = this.key(workspaceId, reference.objectHash);
    const sources = this.sources.get(key) ?? [];
    if (!sources.some((source) => source.recordId === recordId && source.slot === reference.slot)) {
      sources.push({ workspaceId, recordId, slot: reference.slot });
      this.sources.set(key, sources);
    }
  }

  ownerIdForHash(workspaceId: string, hash: string): string | undefined {
    return this.owners.get(this.key(workspaceId, hash))?.values().next().value;
  }

  consumeOwner(ownerId: string): void {
    for (const [key, owners] of this.owners) {
      if (!owners.delete(ownerId)) continue;
      if (owners.size === 0) this.owners.delete(key);
      return;
    }
  }

  private async objectBytes(workspaceId: string, hash: string, sessionId?: string): Promise<Buffer> {
    const context = await this.adapter.context(
      workspaceId,
      sessionId ? "recovery-actor" : "recovery-maintenance",
      sessionId
        ? { owningWorkspace: workspaceId, executionWorkspace: workspaceId, sessionId, pathScopes: [""] }
        : { owningWorkspace: workspaceId, executionWorkspace: workspaceId, pathScopes: [""], capabilities: ["recovery.maintenance"] },
    );
    const candidates: Array<{ ownerId: string } | { recordId: string; slot: string }> = [
      ...[...(this.owners.get(this.key(workspaceId, hash)) ?? [])].map((ownerId) => ({ ownerId })),
      ...(this.sources.get(this.key(workspaceId, hash)) ?? []).map(({ recordId, slot }) => ({ recordId, slot })),
    ];
    let lastError: unknown;
    for (const source of candidates) {
      try {
        const chunks: Buffer[] = [];
        let offset = 0;
        for (;;) {
          const slice = await context.client.getBlob(hash, source, { offset, length: 256 * 1024 });
          chunks.push(Buffer.from(slice.bytesBase64, "base64"));
          if (slice.eof) return Buffer.concat(chunks);
          if (slice.nextOffset <= offset) throw new Error(`Kernel recovery object cursor did not advance: ${hash}`);
          offset = slice.nextOffset;
        }
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError ?? new Error(`Kernel recovery object source is unknown: ${hash}`);
  }

  private async cache(workspaceId: string, state: RecoveryState, sessionId?: string): Promise<void> {
    if (state.kind !== "regular-file") return;
    const target = objectPath(this.cacheRoot, state.objectHash);
    try {
      const actual = await this.delegate.hashFile(target);
      if (actual.objectHash === state.objectHash && actual.byteLength === state.byteLength) return;
    } catch {
      // Cache miss or corrupt cache: replace it from the authoritative kernel object.
    }
    const bytes = await this.objectBytes(workspaceId, state.objectHash, sessionId);
    if (bytes.byteLength !== state.byteLength) {
      throw new Error(`Kernel recovery object length mismatch: ${state.objectHash}`);
    }
    await fs.promises.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const temporary = `${target}.tmp-${randomUUID()}`;
    await fs.promises.writeFile(temporary, bytes, { mode: 0o600 });
    try {
      await fs.promises.rename(temporary, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await fs.promises.rm(temporary, { force: true });
      const actual = await this.delegate.hashFile(target);
      if (actual.objectHash !== state.objectHash || actual.byteLength !== state.byteLength) throw error;
    }
  }

  async captureState(
    identity: RecoveryIdentity,
    root: string,
    inputPath: string,
    options: CaptureStateOptions = {},
    sessionId?: string,
  ): Promise<CapturedState> {
    const captured = await this.delegate.captureState(identity, root, inputPath, { store: false });
    if (options.store === false || captured.state.kind !== "regular-file") return captured;
    const resolved = await this.delegate.relativePathFor(identity, inputPath);
    const bytes = await fs.promises.readFile(resolved.absolute);
    const context = await this.adapter.context(
      identity.workspaceId,
      sessionId ? "recovery-actor" : "recovery-maintenance",
      sessionId
        ? { owningWorkspace: identity.workspaceId, executionWorkspace: identity.workspaceId, sessionId, pathScopes: [""] }
        : { owningWorkspace: identity.workspaceId, executionWorkspace: identity.workspaceId, pathScopes: [""], capabilities: ["recovery.maintenance"] },
    );
    const stored = await context.client.putBlob(
      bytes,
      `recovery-object:${identity.workspaceId}:${captured.state.objectHash}:${randomUUID()}`,
    );
    if (stored.hash !== captured.state.objectHash || stored.byteLength !== bytes.byteLength) {
      throw new Error(`Kernel recovery object identity mismatch: ${captured.state.objectHash}`);
    }
    const key = this.key(identity.workspaceId, stored.hash);
    const owners = this.owners.get(key) ?? new Set<string>();
    owners.add(stored.ownerId);
    this.owners.set(key, owners);
    await this.cache(identity.workspaceId, captured.state, sessionId);
    return captured;
  }

  async applyState(identity: RecoveryIdentity, _root: string, relativePath: string, state: RecoveryState): Promise<void> {
    await this.cache(identity.workspaceId, state);
    await this.delegate.applyState(identity, this.cacheRoot, relativePath, state);
  }

  hashFile(filePath: string) {
    return this.delegate.hashFile(filePath);
  }

  relativePathFor(identity: RecoveryIdentity, inputPath: string) {
    return this.delegate.relativePathFor(identity, inputPath);
  }

  async verifyObject(_root: string, state: RecoveryState): Promise<void> {
    if (state.kind !== "regular-file") return;
    const suffix = `\0${state.objectHash}`;
    const workspaces = new Set<string>();
    for (const [key, sources] of this.sources) {
      if (key.endsWith(suffix)) for (const source of sources) workspaces.add(source.workspaceId);
    }
    for (const key of this.owners.keys()) {
      if (key.endsWith(suffix)) workspaces.add(key.slice(0, key.indexOf("\0")));
    }
    let lastError: unknown;
    for (const workspaceId of workspaces) {
      try {
        await this.cache(workspaceId, state);
        await this.delegate.verifyObject(this.cacheRoot, state);
        return;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError ?? new Error(`Kernel recovery object source is unknown: ${state.objectHash}`);
  }
}

export interface KernelRecoveryContentStoreLike {
  captureState(
    identity: RecoveryIdentity,
    root: string,
    inputPath: string,
    options?: CaptureStateOptions,
    sessionId?: string,
  ): Promise<CapturedState>;
  registerRecord(workspaceId: string, recordId: string, reference: KernelStorageReference): void;
  ownerIdForHash(workspaceId: string, hash: string): string | undefined;
  consumeOwner(ownerId: string): void;
}

export class KernelRecoveryStore {
  constructor(
    private readonly adapter: KernelStorageAdapter,
    readonly content: KernelRecoveryContentStoreLike,
  ) {}

  private context(workspaceId: string, sessionId?: string, maintenance = false) {
    return this.adapter.context(
      workspaceId,
      maintenance ? "recovery-maintenance" : "recovery-actor",
      maintenance
        ? { owningWorkspace: workspaceId, executionWorkspace: workspaceId, pathScopes: [""], capabilities: ["recovery.maintenance", "storage.gc"] }
        : { owningWorkspace: workspaceId, executionWorkspace: workspaceId, ...(sessionId ? { sessionId } : {}), pathScopes: [""] },
    );
  }

  private summary(value: Record<string, unknown>): WorkspaceRecoveryCheckpointSummary {
    return {
      id: String(value.id),
      workspaceId: String(value.workspaceId),
      sequence: Number(value.sequence),
      source: value.source as WorkspaceRecoveryCheckpointSummary["source"],
      state: value.state as WorkspaceRecoveryCheckpointSummary["state"],
      createdAt: String(value.createdAt),
      ...(typeof value.label === "string" ? { label: value.label } : {}),
      ...(typeof value.sessionId === "string" ? { sessionId: value.sessionId } : {}),
      ...(typeof value.entryId === "string" ? { entryId: value.entryId } : {}),
      ...(typeof value.executionId === "string" ? { executionId: value.executionId } : {}),
      changedPathCount: Number(value.changedPathCount ?? 0),
      byteLength: Number(value.byteLength ?? 0),
    };
  }

  private turn(payload: Record<string, unknown>): WorkspaceRecoveryTurnBinding {
    return {
      activeWriterScopes: Array.isArray(payload.activeWriterScopes) ? payload.activeWriterScopes as string[] : [],
      checkpointId: String(payload.checkpointId),
      executionId: String(payload.executionId),
      provenance: payload.provenance as WorkspaceRecoveryTurnBinding["provenance"],
      runtimeGeneration: Number(payload.runtimeGeneration),
      runtimeKey: String(payload.runtimeKey),
      sessionId: String(payload.sessionId),
      startedAt: String(payload.startedAt),
      status: payload.status as WorkspaceRecoveryTurnBinding["status"],
      unrecordedResourceIds: Array.isArray(payload.unrecordedResourceIds) ? payload.unrecordedResourceIds as string[] : [],
      userEntryId: String(payload.userEntryId),
      workerId: String(payload.workerId),
      workspaceId: String(payload.workspaceId),
      ...(typeof payload.assistantEntryId === "string" ? { assistantEntryId: payload.assistantEntryId } : {}),
      ...(typeof payload.settledAt === "string" ? { settledAt: payload.settledAt } : {}),
    };
  }

  async recordTurnStart(input: WorkspaceRecoveryTurnStartInput): Promise<WorkspaceRecoveryTurnBinding> {
    const context = await this.context(input.workspaceId, input.sessionId);
    const value = await context.client.recoveryTurnStart({
      operationId: `recovery-turn-start:${input.workspaceId}:${input.executionId}`,
      workspaceId: input.workspaceId,
      executionId: input.executionId,
      sessionId: input.sessionId,
      userEntryId: input.userEntryId,
      workerId: input.workerId,
      runtimeGeneration: input.runtimeGeneration,
      activeWriterScopes: [...input.activeWriterScopes],
      provenance: input.provenance,
      ...(input.failure === undefined ? {} : { failure: Boolean(input.failure) }),
    });
    return this.turn(value);
  }

  async listCheckpoints(workspaceId: string): Promise<WorkspaceRecoveryCheckpointSummary[]> {
    const context = await this.context(workspaceId, undefined, true);
    const result: WorkspaceRecoveryCheckpointSummary[] = [];
    let cursor: number | undefined;
    do {
      const value = await context.client.recoveryCheckpointList({
        workspaceId,
        pageSize: 512,
        ...(cursor === undefined ? {} : { cursor }),
      });
      if (Array.isArray(value.checkpoints)) {
        result.push(...value.checkpoints.map((item) => this.summary(asObject(item))));
      }
      cursor = typeof value.nextCursor === "number" ? value.nextCursor : undefined;
    } while (cursor !== undefined);
    return result.sort((a, b) => b.sequence - a.sequence);
  }

  async createNamedCheckpoint(workspaceId: string, name: string): Promise<WorkspaceRecoveryCheckpointSummary> {
    const context = await this.context(workspaceId, undefined, true);
    return this.summary(await context.client.recoveryCheckpointCreate({
      operationId: `recovery-checkpoint:${workspaceId}:${randomUUID()}`,
      workspaceId,
      label: name,
    }));
  }

  async resolveEntry(input: WorkspaceRecoveryEntryTarget): Promise<WorkspaceRecoveryEntryBindingResult> {
    const context = await this.context(input.workspaceId, input.sessionId);
    const value = await context.client.recoveryEntryResolve({
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      entryId: input.entryId,
    });
    if (typeof value.executionId !== "string") return value as unknown as WorkspaceRecoveryEntryBindingResult;
    const turn = await context.client.recoveryTurnGet({
      workspaceId: input.workspaceId,
      executionId: value.executionId,
      sessionId: input.sessionId,
    });
    const binding = turn ? this.turn(turn) : undefined;
    const checkpointValue = value.checkpoint;
    const checkpoint = checkpointValue && typeof checkpointValue === "object"
      ? this.summary(asObject(checkpointValue))
      : undefined;
    return { ...value, ...(binding ? { binding } : {}), ...(checkpoint ? { checkpoint } : {}) } as WorkspaceRecoveryEntryBindingResult;
  }

  async recordMutationBefore(input: WorkspaceRecoveryMutationBeforeInput): Promise<boolean> {
    const lookup = await this.context(input.workspaceId, undefined, true);
    const turn = await lookup.client.recoveryTurnGet({ workspaceId: input.workspaceId, executionId: input.executionId });
    if (!turn || typeof turn.sessionId !== "string") return false;
    const context = await this.context(input.workspaceId, turn.sessionId);
    const captured = await this.content.captureState(
      recoveryIdentity(input.workspaceId, context.identity.canonicalRoot),
      context.root,
      input.path,
      { store: true },
      turn.sessionId,
    );
    const ownerId = captured.state.kind === "regular-file"
      ? this.content.ownerIdForHash(input.workspaceId, captured.state.objectHash)
      : undefined;
    const references = captured.state.kind === "regular-file"
      ? [{ slot: "before", objectHash: captured.state.objectHash, ...(ownerId ? { ownerId } : {}) }]
      : [];
    try {
      await context.client.recoveryChangeBefore({
        operationId: `recovery-before:${input.executionId}:${captured.path}`,
        workspaceId: input.workspaceId,
        sessionId: turn.sessionId,
        executionId: input.executionId,
        checkpointId: String(turn.checkpointId),
        path: captured.path,
        toolName: input.toolName,
        mutationId: input.mutationId,
        beforeJson: JSON.stringify(captured.state),
        references,
      });
    } catch (error) {
      if (ownerId) await context.client.releaseBlob(ownerId).catch(() => undefined);
      if (ownerId) this.content.consumeOwner(ownerId);
      throw error;
    }
    if (ownerId) this.content.consumeOwner(ownerId);
    for (const reference of references) {
      this.content.registerRecord(input.workspaceId, `change:${String(turn.checkpointId)}:${captured.path}`, reference);
    }
    return true;
  }

  async recordMutationAfter(input: WorkspaceRecoveryMutationAfterInput): Promise<boolean> {
    const lookup = await this.context(input.workspaceId, undefined, true);
    const turn = await lookup.client.recoveryTurnGet({ workspaceId: input.workspaceId, executionId: input.executionId });
    if (!turn || typeof turn.sessionId !== "string") return false;
    const context = await this.context(input.workspaceId, turn.sessionId);
    const checkpointId = String(turn.checkpointId);
    const captured = await this.content.captureState(
      recoveryIdentity(input.workspaceId, context.identity.canonicalRoot),
      context.root,
      input.path,
      { store: true },
      turn.sessionId,
    );
    const capturedOwner = captured.state.kind === "regular-file"
      ? this.content.ownerIdForHash(input.workspaceId, captured.state.objectHash)
      : undefined;
    const prior = await context.client.recoveryChangeGet({
      workspaceId: input.workspaceId,
      checkpointId,
      path: captured.path,
    });
    if (!prior) {
      if (capturedOwner) await context.client.releaseBlob(capturedOwner).catch(() => undefined);
      if (capturedOwner) this.content.consumeOwner(capturedOwner);
      return false;
    }
    const before = asObject(prior.before) as unknown as RecoveryState;
    const operationId = `recovery-after:${input.executionId}:${captured.path}`;
    if (sameState(before, captured.state)) {
      await context.client.recoveryChangeAfter({
        operationId,
        workspaceId: input.workspaceId,
        sessionId: turn.sessionId,
        executionId: input.executionId,
        checkpointId,
        path: captured.path,
        afterJson: JSON.stringify(captured.state),
        succeeded: false,
        expectedRevision: Number(prior.revision),
        references: [],
      });
      if (capturedOwner) await context.client.releaseBlob(capturedOwner).catch(() => undefined);
      if (capturedOwner) this.content.consumeOwner(capturedOwner);
      return false;
    }
    const references = [
      ...(before.kind === "regular-file" ? [{ slot: "before", objectHash: before.objectHash }] : []),
      ...(captured.state.kind === "regular-file"
        ? [{ slot: "after", objectHash: captured.state.objectHash, ...(capturedOwner ? { ownerId: capturedOwner } : {}) }]
        : []),
    ];
    try {
      await context.client.recoveryChangeAfter({
        operationId,
        workspaceId: input.workspaceId,
        sessionId: turn.sessionId,
        executionId: input.executionId,
        checkpointId,
        path: captured.path,
        afterJson: JSON.stringify(captured.state),
        succeeded: input.succeeded,
        expectedRevision: Number(prior.revision),
        references,
      });
    } catch (error) {
      if (capturedOwner) await context.client.releaseBlob(capturedOwner).catch(() => undefined);
      if (capturedOwner) this.content.consumeOwner(capturedOwner);
      throw error;
    }
    if (capturedOwner) this.content.consumeOwner(capturedOwner);
    for (const reference of references) {
      this.content.registerRecord(input.workspaceId, `change:${checkpointId}:${captured.path}`, reference);
    }
    return true;
  }

  async recordTurnSettled(input: WorkspaceRecoveryTurnSettledInput): Promise<WorkspaceRecoveryTurnBinding> {
    const lookup = await this.context(input.workspaceId, undefined, true);
    const row = await lookup.client.recoveryTurnGet({ workspaceId: input.workspaceId, executionId: input.executionId });
    if (!row || typeof row.sessionId !== "string") throw new Error("checkpoint-missing");
    const context = await this.context(input.workspaceId, row.sessionId);
    const settled = await context.client.recoveryTurnSettle({
      operationId: `recovery-settle:${input.executionId}`,
      workspaceId: input.workspaceId,
      executionId: input.executionId,
      expectedRevision: Number(row.revision),
      status: input.failure || !input.observationComplete ? "incomplete" : "ready",
      observedResourceIds: [...new Set(input.observedResourceIds)],
      observationComplete: input.observationComplete,
      ...(input.assistantEntryId ? { assistantEntryId: input.assistantEntryId } : {}),
      ...(input.failure ? { failureJson: JSON.stringify(input.failure) } : {}),
    });
    return this.turn(settled);
  }

  private stateReferences(
    workspaceId: string,
    value: unknown,
    prefix: string,
  ): Array<{ slot: string; objectHash: string; ownerId?: string }> {
    const output: Array<{ slot: string; objectHash: string; ownerId?: string }> = [];
    const visit = (entry: unknown, slot: string): void => {
      if (!entry || typeof entry !== "object") return;
      if (Array.isArray(entry)) {
        entry.forEach((child, index) => visit(child, `${slot}[${index}]`));
        return;
      }
      const record = entry as Record<string, unknown>;
      if (typeof record.objectHash === "string" && /^sha256-[0-9a-f]{64}$/u.test(record.objectHash)) {
        const ownerId = this.content.ownerIdForHash(workspaceId, record.objectHash);
        output.push({ slot, objectHash: record.objectHash, ...(ownerId ? { ownerId } : {}) });
      }
      for (const [key, child] of Object.entries(record)) {
        if (key !== "objectHash") visit(child, slot ? `${slot}.${key}` : key);
      }
    };
    visit(value, prefix);
    return output;
  }

  async createOperation(input: {
    operationId: string;
    workspaceId: string;
    kind: string;
    state: string;
    data: Record<string, unknown>;
    targets: Record<string, { expected?: RecoveryState; target?: RecoveryState; safety?: RecoveryState }>;
    sessionId?: string;
    threadId?: string;
    runId?: string;
  }): Promise<Record<string, unknown>> {
    const maintenance = !input.sessionId && !input.threadId && !input.runId;
    const context = await this.context(input.workspaceId, input.sessionId, maintenance);
    const files = Object.entries(input.targets).map(([filePath, states]) => ({
      path: filePath,
      ...(states.expected ? { expectedJson: JSON.stringify(states.expected) } : {}),
      ...(states.target ? { targetJson: JSON.stringify(states.target) } : {}),
      ...(states.safety ? { safetyJson: JSON.stringify(states.safety) } : {}),
      phase: "pending",
      references: this.stateReferences(input.workspaceId, states, filePath),
    }));
    const result = await context.client.recoveryOperationCreate({
      operationId: input.operationId,
      workspaceId: input.workspaceId,
      kind: input.kind,
      state: input.state,
      dataJson: JSON.stringify(input.data),
      files,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.threadId ? { threadId: input.threadId } : {}),
      ...(input.runId ? { runId: input.runId } : {}),
    });
    for (const file of files) {
      for (const reference of file.references) {
        if (reference.ownerId) this.content.consumeOwner(reference.ownerId);
        this.content.registerRecord(input.workspaceId, `operation-file:${input.operationId}:${file.path}`, reference);
      }
    }
    return result;
  }

  async updateOperationFile(input: {
    operationId: string;
    workspaceId: string;
    path: string;
    expectedRevision: number;
    expectedPhase: string;
    phase: string;
    observedFingerprint?: string;
    expected?: RecoveryState;
    target?: RecoveryState;
    safety?: RecoveryState;
    sessionId?: string;
  }): Promise<Record<string, unknown>> {
    const context = await this.context(input.workspaceId, input.sessionId, !input.sessionId);
    const current = await context.client.recoveryOperationGet({
      workspaceId: input.workspaceId,
      operationId: input.operationId,
    });
    if (!current) throw new Error(`Recovery operation not found: ${input.operationId}`);
    const currentFile = Array.isArray(current.files)
      ? current.files.find((entry) => asObject(entry).path === input.path)
      : undefined;
    if (!currentFile) throw new Error(`Recovery operation path not found: ${input.path}`);
    const row = asObject(currentFile);
    const parseState = (name: string): RecoveryState | undefined => (
      typeof row[name] === "string" ? JSON.parse(row[name] as string) as RecoveryState : undefined
    );
    const states = {
      expected: input.expected ?? parseState("expectedJson"),
      target: input.target ?? parseState("targetJson"),
      safety: input.safety ?? parseState("safetyJson"),
    };
    const references = this.stateReferences(input.workspaceId, states, input.path);
    const result = await context.client.recoveryOperationFileCas({
      transitionId: `recovery-file:${input.operationId}:${input.path}:${input.expectedRevision}:${input.expectedPhase}:${input.phase}`,
      operationId: input.operationId,
      workspaceId: input.workspaceId,
      path: input.path,
      expectedRevision: input.expectedRevision,
      expectedPhase: input.expectedPhase,
      phase: input.phase,
      ...(input.observedFingerprint ? { observedFingerprint: input.observedFingerprint } : {}),
      ...(input.expected ? { expectedJson: JSON.stringify(input.expected) } : {}),
      ...(input.target ? { targetJson: JSON.stringify(input.target) } : {}),
      ...(input.safety ? { safetyJson: JSON.stringify(input.safety) } : {}),
      references,
    });
    for (const reference of references) {
      if (reference.ownerId) this.content.consumeOwner(reference.ownerId);
      this.content.registerRecord(input.workspaceId, `operation-file:${input.operationId}:${input.path}`, reference);
    }
    return result;
  }

  async completeOperation(input: {
    operationId: string;
    workspaceId: string;
    expectedRevision: number;
    state: string;
    result?: Record<string, unknown>;
    failure?: Record<string, unknown>;
    sessionId?: string;
  }): Promise<Record<string, unknown>> {
    const context = await this.context(input.workspaceId, input.sessionId, !input.sessionId);
    return context.client.recoveryOperationComplete({
      transitionId: `recovery-complete:${input.operationId}:${input.expectedRevision}:${input.state}`,
      operationId: input.operationId,
      workspaceId: input.workspaceId,
      expectedRevision: input.expectedRevision,
      state: input.state,
      ...(input.result ? { resultJson: JSON.stringify(input.result) } : {}),
      ...(input.failure ? { failureJson: JSON.stringify(input.failure) } : {}),
    });
  }

  async getOperation(workspaceId: string, operationId: string, sessionId?: string): Promise<Record<string, unknown> | null> {
    const context = await this.context(workspaceId, sessionId, !sessionId);
    return context.client.recoveryOperationGet({ workspaceId, operationId });
  }

  async listOperations(workspaceId: string, kind?: string): Promise<Record<string, unknown>[]> {
    const context = await this.context(workspaceId, undefined, true);
    const output: Record<string, unknown>[] = [];
    let cursor: number | undefined;
    do {
      const value = await context.client.recoveryOperationList({
        workspaceId,
        ...(kind ? { kind } : {}),
        pageSize: 512,
        ...(cursor === undefined ? {} : { cursor }),
      });
      if (Array.isArray(value.operations)) {
        output.push(...value.operations.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object"));
      }
      cursor = typeof value.nextCursor === "number" ? value.nextCursor : undefined;
    } while (cursor !== undefined);
    return output;
  }

  async releaseOperation(workspaceId: string, operationId: string): Promise<Record<string, unknown>> {
    const context = await this.context(workspaceId, undefined, true);
    return context.client.recoveryOperationRelease({
      transitionId: `recovery-release:${workspaceId}:${operationId}`,
      operationId,
      workspaceId,
    });
  }
}

export const createKernelRecoveryDirectFacade = (
  base: WorkspaceRecoveryEngine,
  store: KernelRecoveryStore,
): WorkspaceRecoveryEngine => {
  const facade = { ...base } as WorkspaceRecoveryEngine;
  const withWorkspaceStorage = base.withWorkspaceStorage.bind(base);
  facade.withWorkspaceStorage = (workspaceId, options, operation) => withWorkspaceStorage(
    workspaceId,
    options,
    (context) => operation({ ...context, durableRecoveryStore: store }),
  );
  facade.recordTurnStart = async (input) => ({ binding: await store.recordTurnStart(input), status: "ready" });
  facade.recordMutationBefore = async (input) => ({ recorded: await store.recordMutationBefore(input), status: "ready" });
  facade.recordMutationAfter = async (input) => ({ recorded: await store.recordMutationAfter(input), status: "ready" });
  facade.recordTurnSettled = async (input) => ({ binding: await store.recordTurnSettled(input), status: "ready" });
  facade.createCheckpoint = async (input) => ({ checkpoint: await store.createNamedCheckpoint(input.workspaceId, input.name), status: "ready" });
  facade.listCheckpoints = async (input) => {
    const checkpoints = await store.listCheckpoints(input.workspaceId);
    const found = input.cursor === undefined
      ? 0
      : checkpoints.findIndex((item) => item.sequence < input.cursor!);
    const start = found < 0 ? checkpoints.length : found;
    const page = checkpoints.slice(start, input.limit === undefined ? undefined : start + input.limit);
    return {
      page: {
        checkpoints: page,
        nextCursor: input.limit !== undefined && start + page.length < checkpoints.length
          ? page.at(-1)?.sequence ?? null
          : null,
      },
      status: "ready",
    };
  };
  facade.resolveEntry = (input) => store.resolveEntry(input);
  return facade;
};
