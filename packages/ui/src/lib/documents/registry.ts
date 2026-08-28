import type {
  DocumentsAPI,
  PiariumDocumentReadResult,
  PiariumResourceReference,
  PiariumWorkspaceFileEvent,
  Subscription,
} from '@/lib/api/types';
import { DocumentsError } from '@/lib/api/documents-errors';
import { peekAgentFileChangeHint } from '@/lib/agent-editor/hints';
import { getRuntimeEndpointGeneration } from '@/lib/runtime-switch';
import { detectLineEnding, normalizeEditorLineEndings, serializeEditorContent } from './line-ending';
import { requireWorkspaceEpoch } from './mutation-token';
import { getDocumentRecoverySessionId } from './recovery-session';
import {
  documentKey,
  toDocumentMeta,
  type DocumentChange,
  type DocumentEditResult,
  type DocumentIdentity,
  type DocumentMeta,
  type DocumentRecord,
  type DocumentTextPosition,
  type DocumentWorkspaceEditApplyResult,
  type DocumentWorkspaceEditFailure,
  type DocumentWorkspaceEditInput,
  type DocumentWorkspaceEditPrepareResult,
  type DocumentWorkspaceEditPreview,
  type DocumentWorkspaceEditUndoResult,
  type DocumentWorkspaceTextEdit,
} from './types';

export type DocumentListener = (record: DocumentRecord) => void;

const EMPTY_RESOURCE_IDS: ReadonlySet<string> = new Set();

const replacementBetween = (previous: string, next: string): DocumentChange | null => {
  if (previous === next) return null;
  let from = 0;
  const sharedLength = Math.min(previous.length, next.length);
  while (from < sharedLength && previous.charCodeAt(from) === next.charCodeAt(from)) from += 1;
  let previousEnd = previous.length;
  let nextEnd = next.length;
  while (
    previousEnd > from
    && nextEnd > from
    && previous.charCodeAt(previousEnd - 1) === next.charCodeAt(nextEnd - 1)
  ) {
    previousEnd -= 1;
    nextEnd -= 1;
  }
  return { from, to: previousEnd, insert: next.slice(from, nextEnd) };
};

type PreparedWorkspaceDocument = {
  before: DocumentRecord;
  afterBuffer: string;
  changes: DocumentChange[];
  editCount: number;
  wasOpen: boolean;
};

type PreparedWorkspaceEdit = {
  generation: number;
  preview: DocumentWorkspaceEditPreview;
  documents: PreparedWorkspaceDocument[];
};

type WorkspaceEditUndoGroup = {
  groupId: string;
  documents: Array<{
    identity: DocumentIdentity;
    beforeBuffer: string;
    appliedBuffer: string;
    appliedRevision: number;
  }>;
};

const offsetAtPosition = (buffer: string, position: DocumentTextPosition): number | null => {
  if (!Number.isSafeInteger(position.line) || !Number.isSafeInteger(position.character)
    || position.line < 0 || position.character < 0) return null;
  let line = 0;
  let lineStart = 0;
  while (line < position.line) {
    const newline = buffer.indexOf('\n', lineStart);
    if (newline < 0) return null;
    lineStart = newline + 1;
    line += 1;
  }
  const newline = buffer.indexOf('\n', lineStart);
  const lineEnd = newline < 0 ? buffer.length : newline;
  if (position.character > lineEnd - lineStart) return null;
  return lineStart + position.character;
};

const prepareTextChanges = (
  buffer: string,
  edits: readonly DocumentWorkspaceTextEdit[],
): { status: 'ready'; buffer: string; changes: DocumentChange[] } | { status: 'invalid-range' | 'overlapping-ranges' } => {
  const changes: Array<DocumentChange & { index: number }> = [];
  for (const [index, edit] of edits.entries()) {
    const from = offsetAtPosition(buffer, edit.range.start);
    const to = offsetAtPosition(buffer, edit.range.end);
    if (from === null || to === null || to < from) return { status: 'invalid-range' };
    changes.push({ from, to, insert: edit.newText, index });
  }
  const ascending = [...changes].sort((left, right) => (
    left.from - right.from || left.to - right.to || left.index - right.index
  ));
  for (let index = 1; index < ascending.length; index += 1) {
    if (ascending[index - 1].to > ascending[index].from) return { status: 'overlapping-ranges' };
  }
  const descending = [...changes]
    .sort((left, right) => right.from - left.from || right.to - left.to || right.index - left.index)
    .map(({ from, to, insert }) => ({ from, to, insert }));
  let next = buffer;
  for (const edit of descending) next = `${next.slice(0, edit.from)}${edit.insert}${next.slice(edit.to)}`;
  return { status: 'ready', buffer: next, changes: descending };
};

const sameResourceSet = (left: ReadonlySet<string>, right: ReadonlySet<string>): boolean => (
  left.size === right.size && [...left].every((value) => right.has(value))
);

type RegistryOptions = {
  documents: DocumentsAPI;
  getGeneration?: () => number;
  recoverySessionId?: string;
  journalDebounceMs?: number;
  now?: () => number;
  createDocumentInstanceId?: () => string;
};

const emptyRecord = (
  identity: DocumentIdentity,
  generation: number,
  documentInstanceId: string,
): DocumentRecord => ({
  identity,
  documentInstanceId,
  connectionGeneration: generation,
  workspaceEpoch: 0,
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
  externalSource: null,
});

const applyRead = (record: DocumentRecord, result: PiariumDocumentReadResult): DocumentRecord => {
  if (result.status === 'missing') {
    if (record.baseRevision !== null) {
      const ancestorContent = record.conflict?.ancestorContent ?? record.baseContent;
      const ancestorRevision = record.conflict?.ancestorRevision ?? record.baseRevision;
      return {
        ...record,
        status: 'deleted',
        workspaceEpoch: result.epoch,
        byteLength: 0,
        errorMessage: null,
        conflict: record.dirty
          ? {
              diskRevision: 'missing',
              ancestorContent,
              ancestorRevision,
              diskContent: '',
            }
          : null,
      };
    }
    return {
      ...record,
      status: 'missing',
      workspaceEpoch: result.epoch,
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
      workspaceEpoch: result.epoch,
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
      workspaceEpoch: result.epoch,
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
      workspaceEpoch: result.epoch,
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
    const ancestorContent = record.conflict?.ancestorContent ?? record.baseContent;
    const ancestorRevision = record.conflict?.ancestorRevision ?? record.baseRevision;
    return {
      ...record,
      status: 'conflict',
      workspaceEpoch: result.epoch,
      baseContent: normalized,
      baseRevision: result.revision,
      encoding: result.encoding,
      bom: result.bom,
      lineEnding,
      byteLength: result.byteLength,
      conflict: {
        diskRevision: result.revision,
        ancestorContent,
        ancestorRevision,
        diskContent: normalized,
      },
      errorMessage: null,
    };
  }
  const externalChange = record.baseRevision !== null
    ? replacementBetween(record.buffer, normalized)
    : null;
  return {
    ...record,
    status: 'ready',
    workspaceEpoch: result.epoch,
    dirty: false,
    baseContent: normalized,
    buffer: normalized,
    localEditRevision: record.localEditRevision + (externalChange ? 1 : 0),
    baseRevision: result.revision,
    encoding: result.encoding,
    bom: result.bom,
    lineEnding,
    byteLength: result.byteLength,
    conflict: null,
    errorMessage: null,
    lastOrigin: externalChange ? 'disk' : record.lastOrigin,
    lastChanges: externalChange ? [externalChange] : record.lastChanges,
  };
};

export class DocumentRegistry {
  readonly recoverySessionId: string;
  private readonly documents: DocumentsAPI;
  private readonly getGeneration: () => number;
  private readonly journalDebounceMs: number;
  private readonly createDocumentInstanceId: () => string;
  private readonly records = new Map<string, DocumentRecord>();
  private readonly openOperations = new Map<string, Promise<DocumentRecord>>();
  private readonly listeners = new Map<string, Set<DocumentListener>>();
  private readonly dirtyIdsByWorkspace = new Map<string, Set<string>>();
  private readonly dirtyListenersByWorkspace = new Map<string, Set<() => void>>();
  private readonly workspaceListeners = new Map<string, Set<() => void>>();
  private readonly workspaceVersions = new Map<string, number>();
  private readonly watches = new Map<string, Subscription>();
  private readonly journalTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly journalOperations = new Map<string, Promise<void>>();
  private readonly preparedWorkspaceEdits = new Map<string, PreparedWorkspaceEdit>();
  private readonly workspaceEditUndoGroups = new Map<string, WorkspaceEditUndoGroup>();
  private disposed = false;

  constructor(options: RegistryOptions) {
    this.documents = options.documents;
    this.getGeneration = options.getGeneration ?? getRuntimeEndpointGeneration;
    this.recoverySessionId = options.recoverySessionId ?? getDocumentRecoverySessionId();
    this.journalDebounceMs = options.journalDebounceMs ?? 750;
    this.createDocumentInstanceId = options.createDocumentInstanceId ?? (() => crypto.randomUUID());
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

  subscribeDirty(workspaceId: string, listener: () => void): () => void {
    const listeners = this.dirtyListenersByWorkspace.get(workspaceId) ?? new Set();
    listeners.add(listener);
    this.dirtyListenersByWorkspace.set(workspaceId, listeners);
    return () => {
      const current = this.dirtyListenersByWorkspace.get(workspaceId);
      current?.delete(listener);
      if (current?.size === 0) this.dirtyListenersByWorkspace.delete(workspaceId);
    };
  }

  subscribeWorkspace(workspaceId: string, listener: () => void): () => void {
    const listeners = this.workspaceListeners.get(workspaceId) ?? new Set();
    listeners.add(listener);
    this.workspaceListeners.set(workspaceId, listeners);
    return () => {
      const current = this.workspaceListeners.get(workspaceId);
      current?.delete(listener);
      if (current?.size === 0) this.workspaceListeners.delete(workspaceId);
    };
  }

  workspaceVersion(workspaceId: string): number {
    return this.workspaceVersions.get(workspaceId) ?? 0;
  }

  dirtyResourceIds(workspaceId: string): ReadonlySet<string> {
    return this.dirtyIdsByWorkspace.get(workspaceId) ?? EMPTY_RESOURCE_IDS;
  }

  open(identity: DocumentIdentity, options?: { reload?: boolean }): Promise<DocumentRecord> {
    const key = documentKey(identity);
    if (!options?.reload) {
      const pending = this.openOperations.get(key);
      if (pending) return pending;
    }
    const operation = this.performOpen(identity, options);
    if (options?.reload) return operation;
    this.openOperations.set(key, operation);
    void operation.finally(() => {
      if (this.openOperations.get(key) === operation) this.openOperations.delete(key);
    }).catch(() => undefined);
    return operation;
  }

  private async performOpen(identity: DocumentIdentity, options?: { reload?: boolean }): Promise<DocumentRecord> {
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
      ...(existing ?? emptyRecord(identity, generation, this.createDocumentInstanceId())),
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
    const current = this.records.get(documentKey(identity))
      ?? emptyRecord(identity, this.getGeneration(), this.createDocumentInstanceId());
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

  applyEdits(
    identity: DocumentIdentity,
    input: {
      expectedLocalEditRevision: number;
      edits: DocumentChange[];
      origin: string;
    },
  ): DocumentEditResult {
    this.assertActive();
    const current = this.records.get(documentKey(identity))
      ?? emptyRecord(identity, this.getGeneration(), this.createDocumentInstanceId());
    if (current.status === 'binary' || current.status === 'unsupported-encoding') {
      return { status: 'unsupported', record: current };
    }
    if (input.expectedLocalEditRevision !== current.localEditRevision) {
      return {
        status: 'stale',
        record: current,
        expectedLocalEditRevision: input.expectedLocalEditRevision,
        actualLocalEditRevision: current.localEditRevision,
      };
    }

    const indexed = input.edits.map((edit, index) => ({ ...edit, index }));
    if (indexed.some((edit) => (
      !Number.isSafeInteger(edit.from)
      || !Number.isSafeInteger(edit.to)
      || edit.from < 0
      || edit.to < edit.from
      || edit.to > current.buffer.length
    ))) {
      return { status: 'invalid', reason: 'invalid-range', record: current };
    }
    const ascending = [...indexed].sort((left, right) => (
      left.from - right.from || left.to - right.to || left.index - right.index
    ));
    for (let index = 1; index < ascending.length; index += 1) {
      const previous = ascending[index - 1];
      const candidate = ascending[index];
      if (previous.to > candidate.from) {
        return { status: 'invalid', reason: 'overlapping-ranges', record: current };
      }
    }
    if (indexed.length === 0) return { status: 'applied', record: current };

    const changes = [...indexed]
      .sort((left, right) => right.from - left.from || right.to - left.to || right.index - left.index)
      .map(({ from, to, insert }) => ({ from, to, insert }));
    let buffer = current.buffer;
    for (const edit of changes) {
      buffer = `${buffer.slice(0, edit.from)}${edit.insert}${buffer.slice(edit.to)}`;
    }
    const next = this.applyTransaction(identity, buffer, { origin: input.origin, changes });
    return { status: 'applied', record: next };
  }

  async prepareWorkspaceEdit(input: DocumentWorkspaceEditInput): Promise<DocumentWorkspaceEditPrepareResult> {
    this.assertActive();
    const generation = this.getGeneration();
    const failures: DocumentWorkspaceEditFailure[] = [];
    if (input.resourceOperations && input.resourceOperations.length > 0) {
      failures.push({
        reason: 'resource-operation-unsupported',
        message: 'Workspace resource create, rename, and delete operations require a Host batch mutation contract',
      });
    }
    const grouped = new Map<string, {
      identity: DocumentIdentity;
      edits: DocumentWorkspaceTextEdit[];
      versions: Set<number>;
    }>();
    for (const change of input.textEdits) {
      if (change.identity.workspaceId !== input.workspaceId) {
        failures.push({
          identity: change.identity,
          reason: 'workspace-mismatch',
          message: 'Workspace edit targets another workspace',
        });
        continue;
      }
      const key = documentKey(change.identity);
      const item = grouped.get(key) ?? { identity: change.identity, edits: [], versions: new Set<number>() };
      item.edits.push(...change.edits);
      if (change.version !== null) item.versions.add(change.version);
      grouped.set(key, item);
    }
    for (const item of grouped.values()) {
      if (item.versions.size > 1) {
        failures.push({
          identity: item.identity,
          reason: 'stale-version',
          message: 'Workspace edit contains conflicting document versions',
        });
      }
    }
    if (failures.length > 0) return { status: 'rejected', failures };

    const loaded = await Promise.all([...grouped.values()].map(async (item) => {
      const existing = this.records.get(documentKey(item.identity));
      if (existing) return { item, record: existing, wasOpen: true };
      try {
        const result = await this.documents.read(item.identity);
        const record = applyRead(
          emptyRecord(item.identity, generation, this.createDocumentInstanceId()),
          result,
        );
        return { item, record, wasOpen: false };
      } catch (error) {
        failures.push({
          identity: item.identity,
          reason: 'not-ready',
          message: error instanceof Error ? error.message : 'Document could not be loaded',
        });
        return null;
      }
    }));
    if (this.disposed || generation !== this.getGeneration()) {
      return {
        status: 'rejected',
        failures: [{ reason: 'stale-plan', message: 'Application Host changed while preparing the workspace edit' }],
      };
    }
    const documents: PreparedWorkspaceDocument[] = [];
    for (const loadedItem of loaded) {
      if (!loadedItem) continue;
      const { item, record, wasOpen } = loadedItem;
      if (record.saving) {
        failures.push({ identity: item.identity, reason: 'saving', message: 'Document is currently being saved' });
        continue;
      }
      if (record.status === 'binary') {
        failures.push({ identity: item.identity, reason: 'binary', message: 'Binary documents cannot receive text edits' });
        continue;
      }
      if (record.status === 'unsupported-encoding') {
        failures.push({ identity: item.identity, reason: 'unsupported-encoding', message: 'Document encoding is not editable' });
        continue;
      }
      if (record.status === 'conflict') {
        failures.push({ identity: item.identity, reason: 'conflict', message: 'Document already has an unresolved disk conflict' });
        continue;
      }
      if (record.status === 'missing' || record.status === 'deleted') {
        failures.push({ identity: item.identity, reason: 'missing', message: 'Document does not exist' });
        continue;
      }
      if (record.status !== 'ready') {
        failures.push({ identity: item.identity, reason: 'not-ready', message: 'Document is not ready for editing' });
        continue;
      }
      const expectedVersion = item.versions.values().next().value as number | undefined;
      if (expectedVersion !== undefined && expectedVersion !== record.localEditRevision) {
        failures.push({
          identity: item.identity,
          reason: 'stale-version',
          message: `Document version changed from ${expectedVersion} to ${record.localEditRevision}`,
        });
        continue;
      }
      const prepared = prepareTextChanges(record.buffer, item.edits);
      if (prepared.status !== 'ready') {
        failures.push({
          identity: item.identity,
          reason: prepared.status,
          message: prepared.status === 'invalid-range'
            ? 'Workspace edit contains a range outside the current document'
            : 'Workspace edit contains overlapping ranges',
        });
        continue;
      }
      if (prepared.buffer === record.buffer) continue;
      documents.push({
        before: structuredClone(record),
        afterBuffer: prepared.buffer,
        changes: prepared.changes,
        editCount: item.edits.length,
        wasOpen,
      });
    }
    if (failures.length > 0) return { status: 'rejected', failures };
    const groupId = crypto.randomUUID();
    const annotationIds = new Set(input.textEdits.flatMap((change) => (
      change.edits.map((edit) => edit.annotationId).filter((value): value is string => Boolean(value))
    )));
    const requiresConfirmation = [...annotationIds].some((annotationId) => (
      input.changeAnnotations?.[annotationId]?.needsConfirmation === true
    ));
    const preview: DocumentWorkspaceEditPreview = {
      status: 'ready',
      groupId,
      workspaceId: input.workspaceId,
      origin: input.origin,
      files: documents.map((document) => ({
        identity: document.before.identity,
        beforeContent: document.before.buffer,
        afterContent: document.afterBuffer,
        editCount: document.editCount,
      })),
      requiresConfirmation,
    };
    this.preparedWorkspaceEdits.set(groupId, { generation, preview, documents });
    return preview;
  }

  async applyWorkspaceEdit(groupId: string): Promise<DocumentWorkspaceEditApplyResult> {
    this.assertActive();
    const prepared = this.preparedWorkspaceEdits.get(groupId);
    if (!prepared) {
      return {
        status: 'rejected',
        failures: [{ reason: 'stale-plan', message: 'Workspace edit preview is no longer available' }],
      };
    }
    const failures: DocumentWorkspaceEditFailure[] = [];
    if (prepared.generation !== this.getGeneration()) {
      failures.push({ reason: 'stale-plan', message: 'Application Host changed after the workspace edit was previewed' });
    }
    const diskSnapshots = new Map<string, DocumentRecord>();
    await Promise.all(prepared.documents.filter((document) => !document.wasOpen).map(async (document) => {
      try {
        const read = await this.documents.read(document.before.identity);
        diskSnapshots.set(
          documentKey(document.before.identity),
          applyRead(
            emptyRecord(document.before.identity, prepared.generation, document.before.documentInstanceId),
            read,
          ),
        );
      } catch (error) {
        failures.push({
          identity: document.before.identity,
          reason: 'not-ready',
          message: error instanceof Error ? error.message : 'Document could not be revalidated',
        });
      }
    }));
    for (const document of prepared.documents) {
      const current = this.records.get(documentKey(document.before.identity))
        ?? diskSnapshots.get(documentKey(document.before.identity));
      if (!current
        || current.localEditRevision !== document.before.localEditRevision
        || current.buffer !== document.before.buffer
        || current.status !== document.before.status
        || current.saving) {
        failures.push({
          identity: document.before.identity,
          reason: 'stale-plan',
          message: 'Document changed after the workspace edit was previewed',
        });
        continue;
      }
      if (!document.wasOpen && current.baseRevision !== document.before.baseRevision) {
        failures.push({
          identity: document.before.identity,
          reason: 'stale-plan',
          message: 'Document changed on disk after the workspace edit was previewed',
        });
      }
    }
    if (failures.length > 0) {
      this.preparedWorkspaceEdits.delete(groupId);
      return { status: 'rejected', failures };
    }

    const records = prepared.documents.map((document) => {
      const current = this.records.get(documentKey(document.before.identity)) ?? document.before;
      return {
        ...current,
        buffer: document.afterBuffer,
        dirty: document.afterBuffer !== current.baseContent,
        localEditRevision: current.localEditRevision + 1,
        status: 'ready' as const,
        lastOrigin: prepared.preview.origin,
        lastChanges: document.changes,
        errorMessage: null,
      };
    });
    this.preparedWorkspaceEdits.delete(groupId);
    this.invalidateWorkspaceEditUndoGroups(records.map((record) => record.identity));
    this.commitAtomic(records, prepared.preview.workspaceId);
    this.workspaceEditUndoGroups.set(groupId, {
      groupId,
      documents: records.map((record, index) => ({
        identity: record.identity,
        beforeBuffer: prepared.documents[index].before.buffer,
        appliedBuffer: record.buffer,
        appliedRevision: record.localEditRevision,
      })),
    });
    return { status: 'applied', groupId, records };
  }

  discardWorkspaceEdit(groupId: string): void {
    this.preparedWorkspaceEdits.delete(groupId);
  }

  undoWorkspaceEdit(groupId: string): DocumentWorkspaceEditUndoResult {
    this.assertActive();
    const group = this.workspaceEditUndoGroups.get(groupId);
    if (!group) return { status: 'unavailable', groupId };
    const failures: DocumentWorkspaceEditFailure[] = [];
    for (const document of group.documents) {
      const current = this.records.get(documentKey(document.identity));
      if (!current
        || current.localEditRevision !== document.appliedRevision
        || current.buffer !== document.appliedBuffer
        || current.saving
        || current.status === 'conflict') {
        failures.push({
          identity: document.identity,
          reason: 'stale-plan',
          message: 'Document changed after the workspace edit was applied',
        });
      }
    }
    if (failures.length > 0) {
      this.workspaceEditUndoGroups.delete(groupId);
      return { status: 'rejected', groupId, failures };
    }
    this.workspaceEditUndoGroups.delete(groupId);
    const records = group.documents.map((document) => {
      const current = this.records.get(documentKey(document.identity))!;
      const change = replacementBetween(current.buffer, document.beforeBuffer);
      return {
        ...current,
        buffer: document.beforeBuffer,
        dirty: document.beforeBuffer !== current.baseContent,
        localEditRevision: current.localEditRevision + 1,
        status: 'ready' as const,
        lastOrigin: `workspace-edit-undo:${groupId}`,
        lastChanges: change ? [change] : [],
        errorMessage: null,
      };
    });
    this.commitAtomic(records, records[0]?.identity.workspaceId ?? '');
    return { status: 'undone', groupId, records };
  }

  async save(
    identity: DocumentIdentity,
    options: { overwriteConflict?: boolean; recreateDeleted?: boolean } = {},
  ): Promise<DocumentRecord> {
    this.assertActive();
    const generation = this.getGeneration();
    const current = this.records.get(documentKey(identity));
    if (!current) throw new DocumentsError('Document is not open', { reason: 'failed' });
    if (!current.dirty) return current;
    if (current.saving) return current;
    if (current.status === 'binary' || current.status === 'unsupported-encoding') return current;
    if (current.status === 'conflict' && !options.overwriteConflict) return current;
    if (current.status === 'deleted' && !options.recreateDeleted) return current;
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
        token: {
          workspaceId: identity.workspaceId,
          epoch: requireWorkspaceEpoch(current.workspaceEpoch),
          owner: {
            kind: 'document-surface',
            id: this.recoverySessionId,
            generation: current.connectionGeneration,
          },
        },
        resource: identity,
        content,
        encoding: current.encoding,
        bom: current.bom,
        expectedRevision: options.recreateDeleted || current.baseRevision === null ? null : current.baseRevision,
        operationId,
      });
      if (this.disposed || generation !== this.getGeneration()) return current;
      const latest = this.records.get(documentKey(identity)) ?? current;
      if (result.status === 'stale-epoch') {
        this.commit({
          ...latest,
          saving: false,
          saveOperationId: null,
          saveCapturedEditRevision: null,
          errorMessage: `Workspace epoch changed to ${result.currentEpoch}; reload before saving`,
        });
        return this.records.get(documentKey(identity)) ?? latest;
      }
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
            ancestorContent: latest.conflict?.ancestorContent ?? latest.baseContent,
            ancestorRevision: latest.conflict?.ancestorRevision ?? latest.baseRevision,
            diskContent: disk.status === 'ready' ? normalizeEditorLineEndings(disk.content) : '',
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
      if (saved.dirty) this.scheduleJournal(saved);
      else await this.clearJournal(saved);
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
    const current = this.records.get(documentKey(identity));
    const snapshot = current ?? applyRead(
      emptyRecord(identity, generation, this.createDocumentInstanceId()),
      await this.documents.read(identity),
    );
    if (snapshot.status !== 'missing') return this.open(identity);
    const result = await this.documents.write({
      token: {
        workspaceId: identity.workspaceId,
        epoch: requireWorkspaceEpoch(snapshot.workspaceEpoch),
        owner: { kind: 'document-surface', id: this.recoverySessionId, generation },
      },
      resource: identity,
      content,
      encoding: 'utf-8',
      bom: false,
      expectedRevision: null,
      operationId: crypto.randomUUID(),
    });
    if (result.status === 'conflict' || result.status === 'stale-epoch') {
      return this.open(identity);
    }
    if (this.disposed || generation !== this.getGeneration()) {
      return emptyRecord(identity, generation, this.createDocumentInstanceId());
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

  async applyMerged(identity: DocumentIdentity, merged: string): Promise<DocumentRecord> {
    this.applyTransaction(identity, merged, { origin: 'merge' });
    return this.save(identity, { overwriteConflict: true });
  }

  handleWatchEvent(event: PiariumWorkspaceFileEvent, resetWorkspaceId?: string): void {
    if (event.kind === 'reset') {
      const records = [...this.records.values()].filter((record) => (
        !resetWorkspaceId || record.identity.workspaceId === resetWorkspaceId
      ));
      for (const record of records) {
        if (record.status === 'loading') continue;
        void this.open(record.identity, { reload: true });
      }
      return;
    }
    const identity = event.kind === 'moved' ? event.from : event.resource;
    const current = this.records.get(documentKey(identity));
    if (!current) return;
    if (event.kind === 'deleted') {
      const deleted = applyRead(current, {
        status: 'missing',
        epoch: requireWorkspaceEpoch(current.workspaceEpoch),
        resource: current.identity,
      });
      const externalSource = peekAgentFileChangeHint(current.identity) ? 'agent' : 'disk';
      this.commit({ ...deleted, externalSource });
      return;
    }
    if (event.kind === 'moved') {
      const previousKey = documentKey(identity);
      this.removeRecord(current);
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
      void this.open(current.identity, { reload: true }).then((record) => {
        if (this.disposed) return;
        const latest = this.records.get(documentKey(record.identity));
        if (!latest) return;
        const externalSource = peekAgentFileChangeHint(record.identity) ? 'agent' : 'disk';
        if (latest.externalSource === externalSource) return;
        this.commit({ ...latest, externalSource });
      });
    }
  }

  async flushRecoveryJournals(): Promise<void> {
    if (this.disposed) return;
    const dirtyRecords = [...this.records.values()].filter((record) => record.dirty);
    for (const record of dirtyRecords) {
      const key = documentKey(record.identity);
      const timer = this.journalTimers.get(key);
      if (timer) clearTimeout(timer);
      this.journalTimers.delete(key);
    }
    const results = await Promise.allSettled(dirtyRecords.map((record) => (
      this.enqueueJournal(record.identity, () => this.writeJournalRecord(record, true))
    )));
    const failures: unknown[] = [];
    for (const result of results) {
      if (result.status === 'rejected') {
        failures.push(result.reason);
        this.reportJournalFailure(result.reason);
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, 'Failed to persist document recovery journals');
  }

  dispose(): void {
    if (this.disposed) return;
    const dirtyRecords = [...this.records.values()].filter((record) => record.dirty);
    this.disposed = true;
    for (const timer of this.journalTimers.values()) clearTimeout(timer);
    this.journalTimers.clear();
    for (const watch of this.watches.values()) watch.close();
    this.watches.clear();
    this.listeners.clear();
    this.dirtyListenersByWorkspace.clear();
    this.workspaceListeners.clear();
    for (const record of dirtyRecords) {
      void this.enqueueJournal(record.identity, () => this.writeJournalRecord(record, false))
        .catch((error) => this.reportJournalFailure(error));
    }
    this.records.clear();
    this.openOperations.clear();
    this.dirtyIdsByWorkspace.clear();
    this.workspaceVersions.clear();
    this.preparedWorkspaceEdits.clear();
    this.workspaceEditUndoGroups.clear();
  }

  private commit(record: DocumentRecord): void {
    const key = documentKey(record.identity);
    const previous = this.records.get(key);
    if (previous && (
      previous.buffer !== record.buffer
      || previous.localEditRevision !== record.localEditRevision
      || previous.status !== record.status
      || previous.conflict !== record.conflict
    )) {
      this.invalidateWorkspaceEditUndoGroups([record.identity]);
    }
    this.records.set(key, record);
    if (previous?.dirty !== record.dirty) {
      this.updateDirtyIndex(record.identity, record.dirty);
    } else if (!previous && record.dirty) {
      this.updateDirtyIndex(record.identity, true);
    }
    const set = this.listeners.get(key);
    if (set) {
      for (const listener of set) listener(record);
    }
    if (
      !previous
      || previous.status !== record.status
      || previous.dirty !== record.dirty
      || previous.saving !== record.saving
      || previous.baseRevision !== record.baseRevision
      || previous.errorMessage !== record.errorMessage
      || previous.externalSource !== record.externalSource
      || previous.conflict !== record.conflict
    ) {
      this.notifyWorkspace(record.identity.workspaceId);
    }
  }

  private removeRecord(record: DocumentRecord): void {
    this.invalidateWorkspaceEditUndoGroups([record.identity]);
    this.records.delete(documentKey(record.identity));
    if (record.dirty) this.updateDirtyIndex(record.identity, false);
    this.notifyWorkspace(record.identity.workspaceId);
  }

  private updateDirtyIndex(identity: DocumentIdentity, dirty: boolean): void {
    const previous = this.dirtyIdsByWorkspace.get(identity.workspaceId) ?? EMPTY_RESOURCE_IDS;
    const next = new Set(previous);
    if (dirty) next.add(identity.resourceId);
    else next.delete(identity.resourceId);
    if (previous.size === next.size && [...previous].every((resourceId) => next.has(resourceId))) return;
    this.dirtyIdsByWorkspace.set(identity.workspaceId, next);
    const listeners = this.dirtyListenersByWorkspace.get(identity.workspaceId);
    if (listeners) {
      for (const listener of listeners) listener();
    }
  }

  private commitAtomic(records: DocumentRecord[], workspaceId: string): void {
    if (records.length === 0) return;
    this.ensureWatch(workspaceId);
    const previousDirty = this.dirtyIdsByWorkspace.get(workspaceId) ?? EMPTY_RESOURCE_IDS;
    const nextDirty = new Set(previousDirty);
    for (const record of records) {
      this.records.set(documentKey(record.identity), record);
      if (record.dirty) nextDirty.add(record.identity.resourceId);
      else nextDirty.delete(record.identity.resourceId);
    }
    this.dirtyIdsByWorkspace.set(workspaceId, nextDirty);
    this.workspaceVersions.set(workspaceId, (this.workspaceVersions.get(workspaceId) ?? 0) + 1);
    this.ensureWatch(workspaceId);
    for (const record of records) {
      const listeners = this.listeners.get(documentKey(record.identity));
      if (listeners) for (const listener of listeners) listener(record);
    }
    if (!sameResourceSet(previousDirty, nextDirty)) {
      const listeners = this.dirtyListenersByWorkspace.get(workspaceId);
      if (listeners) for (const listener of listeners) listener();
    }
    const workspaceListeners = this.workspaceListeners.get(workspaceId);
    if (workspaceListeners) for (const listener of workspaceListeners) listener();
    for (const record of records) this.scheduleJournal(record);
  }

  private invalidateWorkspaceEditUndoGroups(identities: readonly DocumentIdentity[]): void {
    const keys = new Set(identities.map(documentKey));
    for (const [groupId, group] of this.workspaceEditUndoGroups) {
      if (group.documents.some((document) => keys.has(documentKey(document.identity)))) {
        this.workspaceEditUndoGroups.delete(groupId);
      }
    }
  }

  private notifyWorkspace(workspaceId: string): void {
    this.workspaceVersions.set(workspaceId, (this.workspaceVersions.get(workspaceId) ?? 0) + 1);
    const listeners = this.workspaceListeners.get(workspaceId);
    if (listeners) {
      for (const listener of listeners) listener();
    }
  }

  private ensureWatch(workspaceId: string): void {
    if (this.watches.has(workspaceId)) return;
    const subscription = this.documents.watch(workspaceId, (event) => {
      this.handleWatchEvent(event, workspaceId);
    });
    this.watches.set(workspaceId, subscription);
  }

  private scheduleJournal(record: DocumentRecord): void {
    const key = documentKey(record.identity);
    const existing = this.journalTimers.get(key);
    if (existing) clearTimeout(existing);
    if (!record.dirty) {
      void this.clearJournal(record).catch((error) => this.reportJournalFailure(error));
      return;
    }
    const generation = record.connectionGeneration;
    this.journalTimers.set(key, setTimeout(() => {
      this.journalTimers.delete(key);
      void this.enqueueJournal(record.identity, () => this.flushJournal(record.identity, generation))
        .catch((error) => this.reportJournalFailure(error));
    }, this.journalDebounceMs));
  }

  private async flushJournal(identity: DocumentIdentity, generation: number): Promise<void> {
    if (this.disposed || generation !== this.getGeneration()) return;
    const record = this.records.get(documentKey(identity));
    if (!record?.dirty) return;
    await this.writeJournalRecord(record, true);
  }

  private async writeJournalRecord(record: DocumentRecord, updateRegistry: boolean): Promise<void> {
    const request = {
      token: {
        workspaceId: record.identity.workspaceId,
        epoch: requireWorkspaceEpoch(record.workspaceEpoch),
        owner: {
          kind: 'document-recovery',
          id: this.recoverySessionId,
          generation: record.connectionGeneration,
        },
      },
      workspaceId: record.identity.workspaceId,
      recoverySessionId: this.recoverySessionId,
      resource: record.identity,
      content: serializeEditorContent(record.buffer, record.lineEnding),
      encoding: record.encoding,
      bom: record.bom,
      baseRevision: record.baseRevision,
      expectedRevision: record.recoveryJournalRevision,
    };
    let written = await this.documents.writeRecoveryJournal(request);
    if (written.status === 'stale-epoch') {
      throw new Error(`Workspace epoch changed to ${written.currentEpoch}; recovery journal was not written`);
    }
    if (written.status === 'conflict') {
      written = await this.documents.writeRecoveryJournal({
        ...request,
        expectedRevision: written.journal.revision,
      });
    } else if (written.status === 'missing' && request.expectedRevision !== null) {
      written = await this.documents.writeRecoveryJournal({ ...request, expectedRevision: null });
    }
    if (written.status !== 'written' || !updateRegistry || this.disposed) return;
    const latest = this.records.get(documentKey(record.identity));
    if (!latest) return;
    this.commit({
      ...latest,
      recoveryJournalId: written.journal.journalId,
      recoveryJournalRevision: written.journal.revision,
    });
  }

  private async clearJournal(record: DocumentRecord): Promise<void> {
    const timer = this.journalTimers.get(documentKey(record.identity));
    if (timer) clearTimeout(timer);
    this.journalTimers.delete(documentKey(record.identity));
    await this.enqueueJournal(record.identity, async () => {
      const latest = this.records.get(documentKey(record.identity));
      if (!latest?.recoveryJournalId || latest.recoveryJournalRevision === null) return;
      const result = await this.documents.deleteRecoveryJournal({
        token: {
          workspaceId: latest.identity.workspaceId,
          epoch: requireWorkspaceEpoch(latest.workspaceEpoch),
          owner: {
            kind: 'document-recovery',
            id: this.recoverySessionId,
            generation: latest.connectionGeneration,
          },
        },
        journalId: latest.recoveryJournalId,
        expectedRevision: latest.recoveryJournalRevision,
      });
      const current = this.records.get(documentKey(record.identity));
      if (!current) return;
      if (result.status === 'stale-epoch') {
        throw new Error(`Workspace epoch changed to ${result.currentEpoch}; recovery journal was not deleted`);
      }
      if (result.status === 'conflict') {
        this.commit({
          ...current,
          recoveryJournalId: result.journal.journalId,
          recoveryJournalRevision: result.journal.revision,
        });
        return;
      }
      this.commit({
        ...current,
        recoveryJournalId: null,
        recoveryJournalRevision: null,
      });
    });
  }

  private enqueueJournal(identity: DocumentIdentity, operation: () => Promise<void>): Promise<void> {
    const key = documentKey(identity);
    const previous = this.journalOperations.get(key) ?? Promise.resolve();
    const current = previous.catch((error) => {
      this.reportJournalFailure(error);
    }).then(operation);
    this.journalOperations.set(key, current);
    void current.finally(() => {
      if (this.journalOperations.get(key) === current) this.journalOperations.delete(key);
    }).catch(() => undefined);
    return current;
  }

  private reportJournalFailure(error: unknown): void {
    console.error('[Documents] Failed to persist recovery journal:', error);
  }

  private async restoreJournalIfNeeded(record: DocumentRecord): Promise<void> {
    if (record.dirty) return;
    const runtimeGeneration = this.getGeneration();
    if (runtimeGeneration !== record.connectionGeneration) return;
    const captured = {
      identity: { ...record.identity },
      workspaceEpoch: record.workspaceEpoch,
      documentInstanceId: record.documentInstanceId,
      connectionGeneration: record.connectionGeneration,
      runtimeGeneration,
    };
    const journals = await this.documents.listRecoveryJournals({
      workspaceId: record.identity.workspaceId,
      recoverySessionId: this.recoverySessionId,
    });
    const match = journals.find((journal) => (
      journal.resource.workspaceId === record.identity.workspaceId
      && journal.resource.resourceId === record.identity.resourceId
      && journal.epoch === record.workspaceEpoch
    ));
    if (!match) return;
    const loaded = await this.documents.readRecoveryJournal(match.journalId);
    if (loaded.status !== 'ready') return;
    const latest = this.records.get(documentKey(record.identity));
    if (!latest || latest.dirty) return;
    // Journal reads can outlive the document load that started them. A newer
    // epoch, host generation, or document instance must never receive the old
    // buffer; leave that journal available for explicit recovery/history.
    if (
      this.disposed
      || this.getGeneration() !== captured.runtimeGeneration
      || loaded.journal.epoch !== captured.workspaceEpoch
      || latest.workspaceEpoch !== captured.workspaceEpoch
      || latest.documentInstanceId !== captured.documentInstanceId
      || latest.connectionGeneration !== captured.connectionGeneration
      || latest.identity.workspaceId !== captured.identity.workspaceId
      || latest.identity.resourceId !== captured.identity.resourceId
      || loaded.journal.journalId !== match.journalId
      || loaded.journal.resource.workspaceId !== captured.identity.workspaceId
      || loaded.journal.resource.resourceId !== captured.identity.resourceId
    ) return;
    const buffer = normalizeEditorLineEndings(loaded.content);
    const withJournal: DocumentRecord = {
      ...latest,
      recoveryJournalId: loaded.journal.journalId,
      recoveryJournalRevision: loaded.journal.revision,
    };
    if (buffer === latest.baseContent) {
      this.commit(withJournal);
      await this.clearJournal(withJournal);
      return;
    }
    this.commit({
      ...withJournal,
      buffer,
      dirty: true,
      localEditRevision: latest.localEditRevision + 1,
      lastOrigin: 'recovery',
      lastChanges: null,
    });
  }

  private assertActive(): void {
    if (this.disposed) throw new DocumentsError('Document registry is disposed', { reason: 'failed' });
  }
}

export const asResource = (identity: DocumentIdentity): PiariumResourceReference => identity;
