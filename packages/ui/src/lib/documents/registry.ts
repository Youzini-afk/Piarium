import type {
  DocumentsAPI,
  PiariumDocumentReadResult,
  PiariumResourceReference,
  PiariumWorkspaceFileEvent,
  Subscription,
} from '@/lib/api/types';
import { DocumentsError } from '@/lib/api/documents-errors';
import { getRuntimeEndpointGeneration } from '@/lib/runtime-switch';
import { detectLineEnding, normalizeEditorLineEndings, serializeEditorContent } from './line-ending';
import { getDocumentRecoverySessionId } from './recovery-session';
import {
  documentKey,
  toDocumentMeta,
  type DocumentChange,
  type DocumentIdentity,
  type DocumentMeta,
  type DocumentRecord,
} from './types';

export type DocumentListener = (record: DocumentRecord) => void;

type RegistryOptions = {
  documents: DocumentsAPI;
  getGeneration?: () => number;
  recoverySessionId?: string;
  journalDebounceMs?: number;
  now?: () => number;
};

const emptyRecord = (identity: DocumentIdentity, generation: number): DocumentRecord => ({
  identity,
  connectionGeneration: generation,
  status: 'unloaded',
  dirty: false,
  saving: false,
  baseContent: '',
  buffer: '',
  baseRevision: null,
  localEditRevision: 0,
  encoding: 'utf-8',
  bom: false,
  lineEnding: 'lf',
  byteLength: 0,
  saveOperationId: null,
  saveCapturedEditRevision: null,
  conflict: null,
  errorMessage: null,
  recoveryJournalId: null,
  recoveryJournalRevision: null,
  lastOrigin: null,
  lastChanges: null,
});

const applyRead = (record: DocumentRecord, result: PiariumDocumentReadResult): DocumentRecord => {
  if (result.status === 'missing') {
    return {
      ...record,
      status: 'missing',
      baseContent: '',
      buffer: record.dirty ? record.buffer : '',
      baseRevision: null,
      byteLength: 0,
      errorMessage: null,
      conflict: null,
    };
  }
  if (result.status === 'binary') {
    return {
      ...record,
      status: 'binary',
      baseRevision: result.revision,
      byteLength: result.byteLength,
      errorMessage: null,
      conflict: null,
    };
  }
  if (result.status === 'unsupported-encoding') {
    return {
      ...record,
      status: 'unsupported-encoding',
      baseRevision: result.revision,
      byteLength: result.byteLength,
      errorMessage: null,
      conflict: null,
    };
  }
  const lineEnding = detectLineEnding(result.content);
  const normalized = normalizeEditorLineEndings(result.content);
  if (record.dirty && record.buffer === normalized) {
    return {
      ...record,
      status: 'ready',
      dirty: false,
      baseContent: normalized,
      baseRevision: result.revision,
      encoding: result.encoding,
      bom: result.bom,
      lineEnding,
      byteLength: result.byteLength,
      conflict: null,
      errorMessage: null,
    };
  }
  if (record.dirty && record.buffer !== normalized) {
    return {
      ...record,
      status: 'conflict',
      baseContent: normalized,
      baseRevision: result.revision,
      encoding: result.encoding,
      bom: result.bom,
      lineEnding,
      byteLength: result.byteLength,
      conflict: { diskRevision: result.revision },
      errorMessage: null,
    };
  }
  return {
    ...record,
    status: 'ready',
    dirty: false,
    baseContent: normalized,
    buffer: normalized,
    baseRevision: result.revision,
    encoding: result.encoding,
    bom: result.bom,
    lineEnding,
    byteLength: result.byteLength,
    conflict: null,
    errorMessage: null,
  };
};

export class DocumentRegistry {
  readonly recoverySessionId: string;
  private readonly documents: DocumentsAPI;
  private readonly getGeneration: () => number;
  private readonly journalDebounceMs: number;
  private readonly records = new Map<string, DocumentRecord>();
  private readonly listeners = new Map<string, Set<DocumentListener>>();
  private readonly globalListeners = new Set<() => void>();
  private readonly dirtyIdsByWorkspace = new Map<string, Set<string>>();
  private readonly watches = new Map<string, Subscription>();
  private readonly journalTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private disposed = false;

  constructor(options: RegistryOptions) {
    this.documents = options.documents;
    this.getGeneration = options.getGeneration ?? getRuntimeEndpointGeneration;
    this.recoverySessionId = options.recoverySessionId ?? getDocumentRecoverySessionId();
    this.journalDebounceMs = options.journalDebounceMs ?? 750;
  }

  get(identity: DocumentIdentity): DocumentRecord | undefined {
    return this.records.get(documentKey(identity));
  }

  meta(identity: DocumentIdentity): DocumentMeta | undefined {
    const record = this.get(identity);
    return record ? toDocumentMeta(record) : undefined;
  }

  subscribe(identity: DocumentIdentity, listener: DocumentListener): () => void {
    const key = documentKey(identity);
    const set = this.listeners.get(key) ?? new Set();
    set.add(listener);
    this.listeners.set(key, set);
    return () => {
      const current = this.listeners.get(key);
      current?.delete(listener);
      if (current && current.size === 0) this.listeners.delete(key);
    };
  }

  subscribeAll(listener: () => void): () => void {
    this.globalListeners.add(listener);
    return () => {
      this.globalListeners.delete(listener);
    };
  }

  dirtyResourceIds(workspaceId: string): ReadonlySet<string> {
    const next = new Set<string>();
    for (const record of this.records.values()) {
      if (record.identity.workspaceId === workspaceId && record.dirty) {
        next.add(record.identity.resourceId);
      }
    }
    const previous = this.dirtyIdsByWorkspace.get(workspaceId);
    if (previous && previous.size === next.size) {
      let same = true;
      for (const id of previous) {
        if (!next.has(id)) {
          same = false;
          break;
        }
      }
      if (same) return previous;
    }
    this.dirtyIdsByWorkspace.set(workspaceId, next);
    return next;
  }

  async open(identity: DocumentIdentity, options?: { reload?: boolean }): Promise<DocumentRecord> {
    this.assertActive();
    const key = documentKey(identity);
    const generation = this.getGeneration();
    const existing = this.records.get(key);
    if (
      !options?.reload
      && existing
      && existing.connectionGeneration === generation
      && existing.status !== 'unloaded'
      && existing.status !== 'loading'
    ) {
      this.ensureWatch(identity.workspaceId);
      return existing;
    }
    const capturedEdit = existing?.localEditRevision ?? 0;
    const loading: DocumentRecord = {
      ...(existing ?? emptyRecord(identity, generation)),
      identity,
      connectionGeneration: generation,
      status: 'loading',
    };
    this.commit(loading);
    this.ensureWatch(identity.workspaceId);
    try {
      const result = await this.documents.read(identity);
      if (this.disposed || generation !== this.getGeneration()) return loading;
      const current = this.records.get(key) ?? loading;
      if (current.localEditRevision !== capturedEdit) {
        const next = applyRead({ ...current, dirty: true }, result);
        this.commit({
          ...next,
          buffer: current.buffer,
          dirty: current.buffer !== next.baseContent,
          localEditRevision: current.localEditRevision,
        });
        return this.records.get(key) ?? current;
      }
      const next = applyRead(current, result);
      this.commit(next);
      await this.restoreJournalIfNeeded(this.records.get(key) ?? next);
      return this.records.get(key) ?? next;
    } catch (error) {
      if (this.disposed || generation !== this.getGeneration()) return loading;
      const current = this.records.get(key) ?? loading;
      if (current.dirty) {
        this.commit({
          ...current,
          status: current.status === 'loading' ? 'ready' : current.status,
          errorMessage: error instanceof Error ? error.message : String(error),
        });
        return this.records.get(key) ?? current;
      }
      this.commit({
        ...current,
        status: 'error',
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      return this.records.get(key) ?? current;
    }
  }

  applyTransaction(
    identity: DocumentIdentity,
    buffer: string,
    options: { origin: string; changes?: DocumentChange[] } ,
  ): DocumentRecord {
    this.assertActive();
    const current = this.records.get(documentKey(identity)) ?? emptyRecord(identity, this.getGeneration());
    if (current.status === 'binary' || current.status === 'unsupported-encoding') return current;
    const dirty = buffer !== current.baseContent;
    const next: DocumentRecord = {
      ...current,
      buffer,
      dirty,
      localEditRevision: current.localEditRevision + 1,
      status: current.status === 'deleted' || current.status === 'conflict' || current.status === 'missing'
        ? current.status
        : current.status === 'loading' || current.status === 'unloaded'
          ? current.status
          : 'ready',
      lastOrigin: options.origin,
      lastChanges: options.changes ?? null,
      errorMessage: current.status === 'error' ? current.errorMessage : null,
    };
    this.commit(next);
    this.scheduleJournal(next);
    return next;
  }

  async save(identity: DocumentIdentity): Promise<DocumentRecord> {
    this.assertActive();
    const generation = this.getGeneration();
    const current = this.records.get(documentKey(identity));
    if (!current) throw new DocumentsError('Document is not open', { reason: 'failed' });
    if (!current.dirty) return current;
    if (current.status === 'binary' || current.status === 'unsupported-encoding') return current;
    const operationId = crypto.randomUUID();
    const capturedEdit = current.localEditRevision;
    const content = serializeEditorContent(current.buffer, current.lineEnding);
    this.commit({
      ...current,
      saving: true,
      saveOperationId: operationId,
      saveCapturedEditRevision: capturedEdit,
    });
    try {
      const result = await this.documents.write({
        resource: identity,
        content,
        encoding: current.encoding,
        bom: current.bom,
        expectedRevision: current.status === 'deleted' || current.status === 'missing' || current.baseRevision === null
          ? null
          : current.baseRevision,
        operationId,
      });
      if (this.disposed || generation !== this.getGeneration()) return current;
      const latest = this.records.get(documentKey(identity)) ?? current;
      if (result.status === 'conflict') {
        const disk = await this.documents.read(identity);
        if (this.disposed || generation !== this.getGeneration()) return latest;
        const withDisk = applyRead(latest, disk);
        this.commit({
          ...withDisk,
          saving: false,
          saveOperationId: null,
          saveCapturedEditRevision: null,
          buffer: latest.buffer,
          dirty: true,
          localEditRevision: latest.localEditRevision,
          status: 'conflict',
          conflict: {
            diskRevision: disk.status === 'missing' ? 'missing' : disk.revision,
          },
        });
        return this.records.get(documentKey(identity)) ?? latest;
      }
      const stillDirty = latest.localEditRevision !== capturedEdit;
      const saved: DocumentRecord = {
        ...latest,
        saving: false,
        saveOperationId: null,
        saveCapturedEditRevision: null,
        baseContent: stillDirty ? latest.baseContent === latest.buffer ? latest.buffer : normalizeEditorLineEndings(content) : latest.buffer,
        buffer: latest.buffer,
        baseRevision: result.revision,
        dirty: stillDirty,
        byteLength: result.byteLength,
        status: 'ready',
        conflict: null,
        errorMessage: null,
      };
      if (stillDirty) {
        saved.baseContent = normalizeEditorLineEndings(content);
        saved.dirty = saved.buffer !== saved.baseContent;
      }
      this.commit(saved);
      await this.clearJournal(saved);
      return saved;
    } catch (error) {
      if (this.disposed || generation !== this.getGeneration()) return current;
      const latest = this.records.get(documentKey(identity)) ?? current;
      this.commit({
        ...latest,
        saving: false,
        saveOperationId: null,
        saveCapturedEditRevision: null,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async create(identity: DocumentIdentity, content = ''): Promise<DocumentRecord> {
    this.assertActive();
    const generation = this.getGeneration();
    const result = await this.documents.write({
      resource: identity,
      content,
      encoding: 'utf-8',
      bom: false,
      expectedRevision: null,
      operationId: crypto.randomUUID(),
    });
    if (result.status === 'conflict') {
      return this.open(identity);
    }
    if (this.disposed || generation !== this.getGeneration()) {
      return emptyRecord(identity, generation);
    }
    return this.open(identity);
  }

  async reload(identity: DocumentIdentity): Promise<DocumentRecord> {
    return this.open(identity, { reload: true });
  }

  discard(identity: DocumentIdentity): DocumentRecord | undefined {
    const current = this.records.get(documentKey(identity));
    if (!current) return undefined;
    const next: DocumentRecord = {
      ...current,
      buffer: current.baseContent,
      dirty: false,
      status: current.status === 'conflict' ? 'ready' : current.status === 'deleted' ? 'deleted' : current.status,
      conflict: current.status === 'conflict' ? null : current.conflict,
      lastChanges: null,
      lastOrigin: 'discard',
    };
    this.commit(next);
    void this.clearJournal(next);
    return next;
  }

  handleWatchEvent(event: PiariumWorkspaceFileEvent): void {
    if (event.kind === 'reset') return;
    const identity = event.kind === 'moved' ? event.from : event.resource;
    const current = this.records.get(documentKey(identity));
    if (!current) return;
    if (event.kind === 'deleted') {
      this.commit({
        ...current,
        status: 'deleted',
        baseRevision: current.dirty ? current.baseRevision : null,
      });
      return;
    }
    if (event.kind === 'moved') {
      const previousKey = documentKey(identity);
      this.records.delete(previousKey);
      const moved: DocumentRecord = {
        ...current,
        identity: event.resource,
      };
      this.commit(moved);
      const prevListeners = this.listeners.get(previousKey);
      if (prevListeners) {
        this.listeners.delete(previousKey);
        this.listeners.set(documentKey(event.resource), prevListeners);
        for (const listener of prevListeners) listener(moved);
      }
      return;
    }
    if (event.kind === 'changed' || event.kind === 'created') {
      if (current.saving || current.status === 'loading') return;
      if (event.revision && event.revision === current.baseRevision) return;
      void this.open(current.identity, { reload: true });
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const timer of this.journalTimers.values()) clearTimeout(timer);
    this.journalTimers.clear();
    for (const watch of this.watches.values()) watch.close();
    this.watches.clear();
    this.listeners.clear();
    this.records.clear();
  }

  private commit(record: DocumentRecord): void {
    const key = documentKey(record.identity);
    this.records.set(key, record);
    const set = this.listeners.get(key);
    if (set) {
      for (const listener of set) listener(record);
    }
    for (const listener of this.globalListeners) listener();
  }

  private ensureWatch(workspaceId: string): void {
    if (this.watches.has(workspaceId)) return;
    const subscription = this.documents.watch(workspaceId, (event) => {
      this.handleWatchEvent(event);
    });
    this.watches.set(workspaceId, subscription);
  }

  private scheduleJournal(record: DocumentRecord): void {
    const key = documentKey(record.identity);
    const existing = this.journalTimers.get(key);
    if (existing) clearTimeout(existing);
    if (!record.dirty) {
      void this.clearJournal(record);
      return;
    }
    const generation = record.connectionGeneration;
    this.journalTimers.set(key, setTimeout(() => {
      this.journalTimers.delete(key);
      void this.flushJournal(record.identity, generation);
    }, this.journalDebounceMs));
  }

  private async flushJournal(identity: DocumentIdentity, generation: number): Promise<void> {
    if (this.disposed || generation !== this.getGeneration()) return;
    const record = this.records.get(documentKey(identity));
    if (!record?.dirty) return;
    const written = await this.documents.writeRecoveryJournal({
      workspaceId: identity.workspaceId,
      recoverySessionId: this.recoverySessionId,
      resource: identity,
      content: serializeEditorContent(record.buffer, record.lineEnding),
      encoding: record.encoding,
      bom: record.bom,
      baseRevision: record.baseRevision,
      expectedRevision: record.recoveryJournalRevision,
    });
    if (written.status === 'written') {
      const latest = this.records.get(documentKey(identity));
      if (!latest) return;
      this.records.set(documentKey(identity), {
        ...latest,
        recoveryJournalId: written.journal.journalId,
        recoveryJournalRevision: written.journal.revision,
      });
    }
  }

  private async clearJournal(record: DocumentRecord): Promise<void> {
    if (!record.recoveryJournalId) return;
    await this.documents.deleteRecoveryJournal({
      journalId: record.recoveryJournalId,
      expectedRevision: 1,
    }).catch(() => undefined);
    const latest = this.records.get(documentKey(record.identity));
    if (latest) {
      this.records.set(documentKey(record.identity), {
        ...latest,
        recoveryJournalId: null,
        recoveryJournalRevision: null,
      });
    }
  }

  private async restoreJournalIfNeeded(record: DocumentRecord): Promise<void> {
    if (record.dirty) return;
    const journals = await this.documents.listRecoveryJournals({
      workspaceId: record.identity.workspaceId,
      recoverySessionId: this.recoverySessionId,
    });
    const match = journals.find((journal) => (
      journal.resource.workspaceId === record.identity.workspaceId
      && journal.resource.resourceId === record.identity.resourceId
    ));
    if (!match) return;
    const loaded = await this.documents.readRecoveryJournal(match.journalId);
    if (loaded.status !== 'ready') return;
    const latest = this.records.get(documentKey(record.identity));
    if (!latest || latest.dirty) return;
    const buffer = normalizeEditorLineEndings(loaded.content);
    if (buffer === latest.baseContent) {
      await this.clearJournal(latest);
      return;
    }
    this.commit({
      ...latest,
      buffer,
      dirty: true,
      localEditRevision: latest.localEditRevision + 1,
      recoveryJournalId: match.journalId,
      lastOrigin: 'recovery',
      lastChanges: null,
    });
  }

  private assertActive(): void {
    if (this.disposed) throw new DocumentsError('Document registry is disposed', { reason: 'failed' });
  }
}

export const asResource = (identity: DocumentIdentity): PiariumResourceReference => identity;
