import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import {
  createRecoveryMemoryCatalog,
  rebuildObjectReferences,
  objectPath,
  type SqliteDatabase,
} from "../recovery/journal-catalog.js";
import {
  createRecoveryFileStore,
  type CapturedState,
  type CaptureStateOptions,
  type RecoveryFileStore,
  type RecoveryFileStoreOptions,
  type RecoveryIdentity,
  type RecoveryState,
} from "../recovery/journal-files.js";
import type { KernelStorageAdapter, KernelStorageReference } from "./storage-adapter.js";

export interface RecoveryCatalogBackend {
  open(workspaceId: string, root: string, options: { create: boolean; purpose: string }): Promise<SqliteDatabase | null>;
  close(database: SqliteDatabase): Promise<void>;
  gc?(workspaceId: string, operationId: string): Promise<Record<string, unknown>>;
}

interface CatalogHandle {
  context: Awaited<ReturnType<KernelStorageAdapter["context"]>>;
  existing: Map<string, string>;
  root: string;
  workspaceId: string;
}

interface KernelRecordLike {
  recordId: string;
  recordType: string;
  payloadJson: string;
  references: KernelStorageReference[];
  state: string;
  workspaceId: string;
  sessionId?: string;
  threadId?: string;
  runId?: string;
}

const RECOVERY_RECORD_TYPES = new Set([
  "recovery.metadata",
  "recovery.checkpoint",
  "recovery.change",
  "recovery.turn",
  "recovery.operation",
  "recovery.operation-file",
]);

const asObject = (value: unknown): Record<string, unknown> => (
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
);

const parsePayload = (record: KernelRecordLike): Record<string, unknown> => {
  let value: unknown;
  try {
    value = JSON.parse(record.payloadJson);
  } catch (error) {
    throw new Error(`Kernel recovery record ${record.recordId} has malformed payload: ${String(error)}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Kernel recovery record ${record.recordId} payload is not an object`);
  }
  return value as Record<string, unknown>;
};

const field = <T>(payload: Record<string, unknown>, snake: string, camel?: string): T | undefined => {
  const value = payload[snake] ?? (camel ? payload[camel] : undefined);
  return value as T | undefined;
};

const stringField = (payload: Record<string, unknown>, snake: string, camel?: string): string | null => {
  const value = field<unknown>(payload, snake, camel);
  return typeof value === "string" ? value : null;
};

const numberField = (payload: Record<string, unknown>, snake: string, camel?: string): number => {
  const value = field<unknown>(payload, snake, camel);
  return typeof value === "number" && Number.isSafeInteger(value) ? value : 0;
};

const jsonText = (value: unknown): string | null => value === null || value === undefined ? null : JSON.stringify(value);

const recordIdFor = (type: string, payload: Record<string, unknown>): string => {
  switch (type) {
    case "recovery.metadata": return `recovery.metadata:${String(payload.key ?? "")}`;
    case "recovery.checkpoint": return `recovery.checkpoint:${String(payload.id ?? "")}`;
    case "recovery.change": return `recovery.change:${String(payload.checkpoint_id ?? payload.checkpointId ?? "")}:${String(payload.path ?? "")}`;
    case "recovery.turn": return `recovery.turn:${String(payload.execution_id ?? payload.executionId ?? "")}`;
    case "recovery.operation": return `recovery.operation:${String(payload.id ?? "")}`;
    case "recovery.operation-file": return `recovery.operation-file:${String(payload.operation_id ?? payload.operationId ?? "")}:${String(payload.path ?? "")}`;
    default: throw new Error(`Unknown kernel recovery record type: ${type}`);
  }
};

const addStateReferences = (value: unknown, slot: string, output: KernelStorageReference[], seen: Set<string>): void => {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => addStateReferences(entry, `${slot}[${index}]`, output, seen));
    return;
  }
  const object = value as Record<string, unknown>;
  if (typeof object.objectHash === "string" && /^sha256-[0-9a-f]{64}$/u.test(object.objectHash)) {
    const referenceSlot = slot || "state";
    if (!seen.has(referenceSlot)) {
      seen.add(referenceSlot);
      output.push({ objectHash: object.objectHash, slot: referenceSlot });
    }
  }
  for (const [key, child] of Object.entries(object)) {
    if (key === "objectHash") continue;
    addStateReferences(child, slot ? `${slot}.${key}` : key, output, seen);
  }
};

const referencesForRow = (type: string, payload: Record<string, unknown>): KernelStorageReference[] => {
  const references: KernelStorageReference[] = [];
  const seen = new Set<string>();
  if (type === "recovery.operation" && typeof payload.data_json === "string") {
    try { addStateReferences(JSON.parse(payload.data_json), "operation", references, seen); } catch { /* malformed data is rejected by the SQL parser */ }
  } else if (type === "recovery.change") {
    for (const key of ["before_json", "after_json"]) {
      const raw = payload[key];
      if (typeof raw === "string") {
        try { addStateReferences(JSON.parse(raw), key.replace("_json", ""), references, seen); } catch { /* parser reports malformed rows */ }
      }
    }
  } else if (type === "recovery.operation-file") {
    for (const key of ["expected_json", "target_json", "safety_json"]) {
      const raw = payload[key];
      if (typeof raw === "string") {
        try { addStateReferences(JSON.parse(raw), key.replace("_json", ""), references, seen); } catch { /* parser reports malformed rows */ }
      }
    }
  }
  return references;
};

const insertRecord = (database: SqliteDatabase, record: KernelRecordLike): void => {
  const payload = parsePayload(record);
  switch (record.recordType) {
    case "recovery.metadata":
      database.prepare("INSERT OR REPLACE INTO metadata(key, value) VALUES (?, ?)")
        .run(String(payload.key ?? ""), String(payload.value ?? ""));
      return;
    case "recovery.checkpoint":
      database.prepare(`INSERT OR REPLACE INTO checkpoints(
        id, workspace_id, sequence, source, state, created_at, label, session_id, entry_id, execution_id,
        changed_path_count, byte_length
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        String(payload.id ?? ""), String(payload.workspace_id ?? payload.workspaceId ?? record.workspaceId),
        numberField(payload, "sequence"), String(payload.source ?? "turn"), String(payload.state ?? record.state),
        String(payload.created_at ?? payload.createdAt ?? new Date().toISOString()), stringField(payload, "label"),
        stringField(payload, "session_id", "sessionId"), stringField(payload, "entry_id", "entryId"),
        stringField(payload, "execution_id", "executionId"), numberField(payload, "changed_path_count", "changedPathCount"),
        numberField(payload, "byte_length", "byteLength"),
      );
      return;
    case "recovery.change":
      database.prepare(`INSERT OR REPLACE INTO checkpoint_changes(
        checkpoint_id, path, tool_name, mutation_id, before_json, after_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
        String(payload.checkpoint_id ?? payload.checkpointId ?? ""), String(payload.path ?? ""),
        String(payload.tool_name ?? payload.toolName ?? ""), String(payload.mutation_id ?? payload.mutationId ?? ""),
        String(payload.before_json ?? payload.beforeJson ?? "{}"), payload.after_json ?? payload.afterJson ?? null,
        String(payload.created_at ?? payload.createdAt ?? new Date().toISOString()),
        String(payload.updated_at ?? payload.updatedAt ?? new Date().toISOString()),
      );
      return;
    case "recovery.turn":
      database.prepare(`INSERT OR REPLACE INTO turn_bindings(
        execution_id, runtime_key, runtime_generation, worker_id, session_id, workspace_id, user_entry_id,
        assistant_entry_id, checkpoint_id, active_writer_scopes_json, provenance, status,
        journaled_resource_ids_json, unrecorded_resource_ids_json, failure_json, started_at, settled_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        String(payload.execution_id ?? payload.executionId ?? ""), String(payload.runtime_key ?? payload.runtimeKey ?? ""),
        numberField(payload, "runtime_generation", "runtimeGeneration"), String(payload.worker_id ?? payload.workerId ?? ""),
        String(payload.session_id ?? payload.sessionId ?? record.sessionId ?? ""), String(payload.workspace_id ?? payload.workspaceId ?? record.workspaceId),
        String(payload.user_entry_id ?? payload.userEntryId ?? ""), stringField(payload, "assistant_entry_id", "assistantEntryId"),
        String(payload.checkpoint_id ?? payload.checkpointId ?? ""), String(payload.active_writer_scopes_json ?? JSON.stringify(payload.activeWriterScopes ?? [])),
        String(payload.provenance ?? "caused-by"), String(payload.status ?? record.state),
        String(payload.journaled_resource_ids_json ?? JSON.stringify(payload.journaledResourceIds ?? [])),
        String(payload.unrecorded_resource_ids_json ?? JSON.stringify(payload.unrecordedResourceIds ?? [])),
        payload.failure_json ?? (payload.failure ? JSON.stringify(payload.failure) : null),
        String(payload.started_at ?? payload.startedAt ?? new Date().toISOString()), stringField(payload, "settled_at", "settledAt"),
      );
      return;
    case "recovery.operation":
      database.prepare(`INSERT OR REPLACE INTO operations(
        id, workspace_id, kind, state, data_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
        String(payload.id ?? ""), String(payload.workspace_id ?? payload.workspaceId ?? record.workspaceId),
        String(payload.kind ?? "combined"), String(payload.state ?? record.state),
        String(payload.data_json ?? JSON.stringify(payload.data ?? payload)),
        String(payload.created_at ?? payload.createdAt ?? new Date().toISOString()),
        String(payload.updated_at ?? payload.updatedAt ?? new Date().toISOString()),
      );
      return;
    case "recovery.operation-file":
      database.prepare(`INSERT OR REPLACE INTO operation_files(
        operation_id, ordinal, path, expected_json, target_json, safety_json, phase, observed_fingerprint, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        String(payload.operation_id ?? payload.operationId ?? ""), numberField(payload, "ordinal"), String(payload.path ?? ""),
        payload.expected_json ?? payload.expectedJson ?? null, payload.target_json ?? payload.targetJson ?? null,
        payload.safety_json ?? payload.safetyJson ?? null, String(payload.phase ?? "pending"),
        payload.observed_fingerprint ?? payload.observedFingerprint ?? null,
        String(payload.updated_at ?? payload.updatedAt ?? new Date().toISOString()),
      );
      return;
    default:
      throw new Error(`Unknown kernel recovery record type: ${record.recordType}`);
  }
};

const rowsForFlush = (database: SqliteDatabase, workspaceId: string): Array<{
  recordId: string;
  recordType: string;
  state: string;
  payload: Record<string, unknown>;
  references: KernelStorageReference[];
  sessionId?: string;
}> => {
  const rows: Array<{ recordId: string; recordType: string; state: string; payload: Record<string, unknown>; references: KernelStorageReference[]; sessionId?: string }> = [];
  const add = (recordType: string, payload: Record<string, unknown>, state: string, sessionId?: string) => rows.push({ recordId: recordIdFor(recordType, payload), recordType, state, payload, references: referencesForRow(recordType, payload), ...(sessionId ? { sessionId } : {}) });
  for (const row of database.prepare("SELECT key, value FROM metadata").all() as Array<Record<string, unknown>>) add("recovery.metadata", row, "active");
  for (const row of database.prepare("SELECT * FROM checkpoints WHERE workspace_id = ?").all(workspaceId) as Array<Record<string, unknown>>) add("recovery.checkpoint", row, String(row.state ?? "ready"), typeof row.session_id === "string" ? row.session_id : undefined);
  for (const row of database.prepare(`SELECT c.workspace_id, cc.* FROM checkpoint_changes cc JOIN checkpoints c ON c.id = cc.checkpoint_id WHERE c.workspace_id = ?`).all(workspaceId) as Array<Record<string, unknown>>) add("recovery.change", row, "recorded");
  for (const row of database.prepare("SELECT * FROM turn_bindings WHERE workspace_id = ?").all(workspaceId) as Array<Record<string, unknown>>) add("recovery.turn", row, String(row.status ?? "pending"), typeof row.session_id === "string" ? row.session_id : undefined);
  for (const row of database.prepare("SELECT * FROM operations WHERE workspace_id = ?").all(workspaceId) as Array<Record<string, unknown>>) add("recovery.operation", row, String(row.state ?? "planned"));
  for (const row of database.prepare(`SELECT o.workspace_id, f.* FROM operation_files f JOIN operations o ON o.id = f.operation_id WHERE o.workspace_id = ?`).all(workspaceId) as Array<Record<string, unknown>>) add("recovery.operation-file", row, String(row.phase ?? "pending"));
  return rows;
};

export class KernelRecoveryCatalogBackend implements RecoveryCatalogBackend {
  private readonly handles = new Map<SqliteDatabase, CatalogHandle>();

  constructor(
    private readonly adapter: KernelStorageAdapter,
    private readonly content: KernelRecoveryContentStore,
  ) {}

  async open(workspaceId: string, root: string, options: { create: boolean; purpose: string }): Promise<SqliteDatabase | null> {
    // A recovery catalog and the blobs it references share one actor grant.
    // Rust binds temporary object owners to that grant, so using a new grant
    // for every SQL-shaped callback would make a valid before-image unusable.
    const context = await this.adapter.context(workspaceId, "recovery-catalog");
    const records = (await context.records.list({})).filter((record) => RECOVERY_RECORD_TYPES.has(record.recordType)) as unknown as KernelRecordLike[];
    if (!options.create && records.length === 0) return null;
    const database = createRecoveryMemoryCatalog();
    const order: Record<string, number> = {
      "recovery.metadata": 0,
      "recovery.checkpoint": 1,
      "recovery.operation": 2,
      "recovery.change": 3,
      "recovery.turn": 4,
      "recovery.operation-file": 5,
    };
    const ordered = [...records].sort((left, right) => (order[left.recordType] ?? 99) - (order[right.recordType] ?? 99));
    for (const record of ordered) {
      insertRecord(database, record);
      for (const reference of record.references) this.content.registerRecord(record.workspaceId, record.recordId, reference);
    }
    rebuildObjectReferences(database);
    this.handles.set(database, { context, existing: new Map(records.map((record) => [record.recordId, record.recordType])), root, workspaceId });
    return database;
  }

  async close(database: SqliteDatabase): Promise<void> {
    const handle = this.handles.get(database);
    if (!handle) {
      database.close();
      return;
    }
    try {
      const rows = rowsForFlush(database, handle.workspaceId);
      const current = new Set<string>();
      for (const row of rows) {
        current.add(row.recordId);
        const ownerIds = row.references.flatMap((reference) => {
          const owner = this.content.ownerIdForHash(reference.objectHash);
          return owner ? [owner] : [];
        });
        const payloadDigest = createHash("sha256")
          .update(JSON.stringify(row.payload))
          .update("\0")
          .update(ownerIds.join("\0"))
          .digest("hex");
        const stored = await handle.context.records.put({
          operationId: `recovery-record:${handle.workspaceId}:${row.recordId}:${payloadDigest}`,
          recordId: row.recordId,
          recordType: row.recordType,
          state: row.state,
          payloadJson: JSON.stringify(row.payload),
          references: row.references,
          ownerIds,
          ...(row.sessionId ? { sessionId: row.sessionId } : {}),
        });
        for (const reference of stored.references) this.content.registerRecord(handle.workspaceId, stored.recordId, reference);
        for (const ownerId of ownerIds) this.content.consumeOwner(ownerId);
      }
      for (const recordId of handle.existing.keys()) {
        if (!current.has(recordId)) await handle.context.records.release(`recovery-release:${handle.workspaceId}:${recordId}`, recordId);
      }
    } finally {
      this.handles.delete(database);
      database.close();
    }
  }

  async gc(workspaceId: string, operationId: string): Promise<Record<string, unknown>> {
    const context = await this.adapter.context(workspaceId, "recovery-catalog");
    return context.client.gc(operationId);
  }
}

export class KernelRecoveryContentStore implements RecoveryFileStore {
  private readonly delegate: RecoveryFileStore;
  private readonly owners = new Map<string, { ownerId: string; workspaceId: string }>();
  private readonly sources = new Map<string, { workspaceId: string; recordId: string; slot: string }>();

  constructor(
    private readonly adapter: KernelStorageAdapter,
    private readonly cacheRoot: string,
    options: RecoveryFileStoreOptions = {},
  ) {
    this.delegate = createRecoveryFileStore(options);
  }

  ownerIdForHash(hash: string): string | undefined { return this.owners.get(hash)?.ownerId; }
  consumeOwner(ownerId: string): void {
    for (const [hash, owner] of this.owners) if (owner.ownerId === ownerId) this.owners.delete(hash);
  }
  registerRecord(workspaceId: string, recordId: string, reference: KernelStorageReference): void {
    this.sources.set(reference.objectHash, { workspaceId, recordId, slot: reference.slot });
  }
  private async readObject(workspaceId: string, hash: string): Promise<Buffer> {
    const context = await this.adapter.context(workspaceId, "recovery-catalog");
    const owner = this.owners.get(hash);
    const source = owner ? { ownerId: owner.ownerId } : (() => {
      const record = this.sources.get(hash);
      if (!record) throw new Error(`Kernel recovery object source is unknown: ${hash}`);
      return { recordId: record.recordId, slot: record.slot };
    })();
    const chunks: Buffer[] = [];
    let offset = 0;
    for (;;) {
      const slice = await context.client.getBlob(hash, source, { offset, length: 256 * 1024 });
      chunks.push(Buffer.from(slice.bytesBase64, "base64"));
      if (slice.eof) break;
      if (slice.nextOffset <= offset) throw new Error(`Kernel recovery object cursor did not advance: ${hash}`);
      offset = slice.nextOffset;
    }
    return Buffer.concat(chunks);
  }
  private async ensureCached(workspaceId: string, state: RecoveryState): Promise<void> {
    if (state.kind !== "regular-file") return;
    const target = objectPath(this.cacheRoot, state.objectHash);
    try {
      const stat = await fs.promises.stat(target);
      if (stat.size === state.byteLength) return;
    } catch { /* cache miss */ }
    const bytes = await this.readObject(workspaceId, state.objectHash);
    if (bytes.byteLength !== state.byteLength) throw new Error(`Kernel recovery object length mismatch: ${state.objectHash}`);
    await fs.promises.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
    await fs.promises.writeFile(temporary, bytes, { mode: 0o600 });
    await fs.promises.rename(temporary, target).catch(async (error) => {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await fs.promises.rm(temporary, { force: true });
    });
  }
  async captureState(identity: RecoveryIdentity, root: string, inputPath: string, options: CaptureStateOptions = {}): Promise<CapturedState> {
    const captured = await this.delegate.captureState(identity, root, inputPath, { store: false });
    if (options.store !== false && captured.state.kind === "regular-file") {
      const resolved = await this.delegate.relativePathFor(identity, inputPath);
      const bytes = await fs.promises.readFile(resolved.absolute);
      const context = await this.adapter.context(identity.workspaceId, "recovery-catalog");
      const stored = await context.client.putBlob(bytes, `recovery-object:${identity.workspaceId}:${captured.state.objectHash}:${Date.now()}:${Math.random()}`);
      if (stored.hash !== captured.state.objectHash || stored.byteLength !== bytes.byteLength) throw new Error(`Kernel recovery object identity mismatch: ${captured.state.objectHash}`);
      this.owners.set(stored.hash, { ownerId: stored.ownerId, workspaceId: identity.workspaceId });
      await this.ensureCached(identity.workspaceId, captured.state);
    }
    return captured;
  }
  async applyState(identity: RecoveryIdentity, _root: string, relativePath: string, state: RecoveryState): Promise<void> {
    await this.ensureCached(identity.workspaceId, state);
    return this.delegate.applyState(identity, this.cacheRoot, relativePath, state);
  }
  hashFile(filePath: string) { return this.delegate.hashFile(filePath); }
  relativePathFor(identity: RecoveryIdentity, inputPath: string) { return this.delegate.relativePathFor(identity, inputPath); }
  async verifyObject(_root: string, state: RecoveryState): Promise<void> {
    if (state.kind !== "regular-file") return;
    const workspaceId = this.owners.get(state.kind === "regular-file" ? state.objectHash : "")?.workspaceId
      ?? this.sources.get(state.kind === "regular-file" ? state.objectHash : "")?.workspaceId;
    if (!workspaceId) throw new Error(`Kernel recovery object source is unknown: ${state.objectHash}`);
    await this.ensureCached(workspaceId, state);
    await this.delegate.verifyObject(this.cacheRoot, state);
  }
}
