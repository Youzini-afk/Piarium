import { describe, expect, test } from 'bun:test';
import type {
  DocumentsAPI,
  PiariumDocumentReadResult,
  PiariumDocumentRecoveryJournalSummary,
  PiariumResourceReference,
  PiariumWorkspaceFileEvent,
} from '@/lib/api/types';
import { DocumentRegistry } from './registry';
import { documentKey } from './types';

const resource = (resourceId = 'note.txt'): PiariumResourceReference => ({
  workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  resourceId,
});

const mutationToken = () => ({
  workspaceId: resource().workspaceId,
  epoch: 1,
  owner: { kind: 'test', id: 'document-registry' },
});

const createMemoryDocuments = () => {
  const files = new Map<string, { content: string; revision: string }>();
  const journals = new Map<string, {
    journalId: string;
    resource: PiariumResourceReference;
    content: string;
    epoch: number;
    revision: number;
    baseRevision: string | null;
  }>();
  const listeners = new Set<(event: PiariumWorkspaceFileEvent) => void>();
  const dirtyPublications: Array<Parameters<DocumentsAPI['publishDirtyBuffers']>[0]> = [];
  let revisionSeq = 1;
  let workspaceEpoch = 1;
  let watchSequence = 0;
  const keyOf = (ref: PiariumResourceReference) => `${ref.workspaceId}\0${ref.resourceId}`;
  const nextRevision = () => `d1_${revisionSeq++}`;
  const emit = (event: PiariumWorkspaceFileEvent) => {
    for (const listener of listeners) listener(event);
  };

  const api: DocumentsAPI = {
    clearDirtyBuffers: async () => ({ cleared: true }),
    publishDirtyBuffers: async (request) => {
      dirtyPublications.push(request);
      return { ...request, updatedAt: '2026-08-28T00:00:00.000Z' };
    },
    resolveWorkspace: async () => ({ workspaceId: resource().workspaceId, hostId: 'host-1', epoch: workspaceEpoch }),
    read: async (ref) => {
      const file = files.get(keyOf(ref));
      if (!file) return { status: 'missing', epoch: workspaceEpoch, resource: ref };
      return {
        status: 'ready',
        epoch: workspaceEpoch,
        resource: ref,
        revision: file.revision,
        content: file.content,
        encoding: 'utf-8',
        bom: false,
        byteLength: file.content.length,
      } satisfies PiariumDocumentReadResult;
    },
    write: async (request) => {
      const key = keyOf(request.resource);
      const current = files.get(key);
      if (request.expectedRevision === null) {
        if (current) {
          return { status: 'conflict', current: { status: 'ready', epoch: workspaceEpoch, resource: request.resource, revision: current.revision, encoding: 'utf-8', bom: false, byteLength: current.content.length } };
        }
      } else if (!current || current.revision !== request.expectedRevision) {
        return {
          status: 'conflict',
          current: current
            ? { status: 'ready', epoch: workspaceEpoch, resource: request.resource, revision: current.revision, encoding: 'utf-8', bom: false, byteLength: current.content.length }
            : { status: 'missing', epoch: workspaceEpoch, resource: request.resource },
        };
      }
      const revision = nextRevision();
      files.set(key, { content: request.content, revision });
      emit({ sourceId: 'memory-documents', generation: 1, kind: current ? 'changed' : 'created', sequence: ++watchSequence, resource: request.resource, revision });
      return { status: 'written', revision, byteLength: request.content.length };
    },
    move: async () => ({ status: 'missing', resource: resource() }),
    delete: async (request) => {
      files.delete(keyOf(request.resource));
      return { status: 'deleted', resource: request.resource };
    },
    watch: (_workspaceId, listener) => {
      listeners.add(listener);
      return { close: () => { listeners.delete(listener); } };
    },
    listRecoveryJournals: async () => [...journals.values()].map((entry) => ({
      journalId: entry.journalId,
      resource: entry.resource,
      revision: entry.revision,
      baseRevision: entry.baseRevision,
      epoch: entry.epoch,
      updatedAt: '2026-08-20T00:00:00.000Z',
      byteLength: entry.content.length,
    })) satisfies PiariumDocumentRecoveryJournalSummary[],
    readRecoveryJournal: async (journalId) => {
      const entry = journals.get(journalId);
      if (!entry) return { status: 'missing', journalId };
      return {
        status: 'ready',
        journal: {
          journalId: entry.journalId,
          resource: entry.resource,
          revision: entry.revision,
          baseRevision: entry.baseRevision,
          epoch: entry.epoch,
          updatedAt: '2026-08-20T00:00:00.000Z',
          byteLength: entry.content.length,
        },
        content: entry.content,
        encoding: 'utf-8',
        bom: false,
      };
    },
    writeRecoveryJournal: async (request) => {
      const existing = [...journals.values()].find((entry) => (
        entry.resource.resourceId === request.resource.resourceId
      ));
      if (existing) {
        if (request.expectedRevision !== existing.revision) {
          return { status: 'conflict', journal: {
            journalId: existing.journalId,
            resource: existing.resource,
            revision: existing.revision,
            baseRevision: existing.baseRevision,
            epoch: existing.epoch,
            updatedAt: '2026-08-20T00:00:00.000Z',
            byteLength: existing.content.length,
          } };
        }
        existing.content = request.content;
        existing.revision += 1;
        existing.baseRevision = request.baseRevision;
        return { status: 'written', journal: {
          journalId: existing.journalId,
          resource: existing.resource,
          revision: existing.revision,
          baseRevision: existing.baseRevision,
          epoch: existing.epoch,
          updatedAt: '2026-08-20T00:00:00.000Z',
          byteLength: existing.content.length,
        } };
      }
      if (request.expectedRevision !== null) return { status: 'missing', journalId: '' };
      const journalId = crypto.randomUUID();
      const created = {
        journalId,
        resource: request.resource,
        content: request.content,
        epoch: request.token.epoch,
        revision: 1,
        baseRevision: request.baseRevision,
      };
      journals.set(journalId, created);
      return { status: 'written', journal: {
        journalId,
        resource: request.resource,
        revision: 1,
        baseRevision: request.baseRevision,
        epoch: request.token.epoch,
        updatedAt: '2026-08-20T00:00:00.000Z',
        byteLength: request.content.length,
      } };
    },
    deleteRecoveryJournal: async (request) => {
      const current = journals.get(request.journalId);
      if (!current) return { status: 'missing' };
      if (current.revision !== request.expectedRevision) {
        return { status: 'conflict', journal: {
          journalId: current.journalId,
          resource: current.resource,
          revision: current.revision,
          baseRevision: current.baseRevision,
          epoch: current.epoch,
          updatedAt: '2026-08-20T00:00:00.000Z',
          byteLength: current.content.length,
        } };
      }
      journals.delete(request.journalId);
      return { status: 'deleted' };
    },
  };

  return { api, dirtyPublications, files, journals, emit, setEpoch: (epoch: number) => { workspaceEpoch = epoch; } };
};

describe('DocumentRegistry', () => {
  test('keeps independent dirty buffers when switching documents', async () => {
    const { api } = createMemoryDocuments();
    await api.write({ token: mutationToken(), resource: resource('a.txt'), content: 'A', encoding: 'utf-8', bom: false, expectedRevision: null, operationId: '1' });
    await api.write({ token: mutationToken(), resource: resource('b.txt'), content: 'B', encoding: 'utf-8', bom: false, expectedRevision: null, operationId: '2' });
    const registry = new DocumentRegistry({ documents: api, getGeneration: () => 1, recoverySessionId: 'session' });
    const a = await registry.open(resource('a.txt'));
    const b = await registry.open(resource('b.txt'));
    registry.applyTransaction(a.identity, 'A-edit', { origin: 'view-1' });
    registry.applyTransaction(b.identity, 'B-edit', { origin: 'view-1' });
    expect(registry.get(resource('a.txt'))?.buffer).toBe('A-edit');
    expect(registry.get(resource('b.txt'))?.buffer).toBe('B-edit');
    expect(registry.get(resource('a.txt'))?.dirty).toBe(true);
    registry.dispose();
  });

  test('coalesces concurrent first-open reads for the same document', async () => {
    const { api } = createMemoryDocuments();
    const identity = resource();
    await api.write({ token: mutationToken(), resource: identity, content: 'base', encoding: 'utf-8', bom: false, expectedRevision: null, operationId: '1' });
    let reads = 0;
    const counted: DocumentsAPI = {
      ...api,
      read: async (ref) => {
        reads += 1;
        await Promise.resolve();
        return api.read(ref);
      },
    };
    const registry = new DocumentRegistry({ documents: counted, getGeneration: () => 1, recoverySessionId: 'session' });
    const [first, second, third] = await Promise.all([
      registry.open(identity),
      registry.open(identity),
      registry.open(identity),
    ]);
    expect(reads).toBe(1);
    expect(first).toBe(second);
    expect(second).toBe(third);
    registry.dispose();
  });

  test('two views share one buffer and keep independent origins', async () => {
    const { api } = createMemoryDocuments();
    const identity = resource();
    await api.write({ token: mutationToken(), resource: identity, content: 'base', encoding: 'utf-8', bom: false, expectedRevision: null, operationId: '1' });
    const registry = new DocumentRegistry({ documents: api, getGeneration: () => 1, recoverySessionId: 'session' });
    await registry.open(identity);
    registry.applyTransaction(identity, 'from-a', { origin: 'view-a' });
    expect(registry.get(identity)?.buffer).toBe('from-a');
    expect(registry.get(identity)?.lastOrigin).toBe('view-a');
    registry.applyTransaction(identity, 'from-b', { origin: 'view-b' });
    expect(registry.get(identity)?.buffer).toBe('from-b');
    expect(registry.get(identity)?.lastOrigin).toBe('view-b');
    expect(registry.get(identity)?.dirty).toBe(true);
    registry.dispose();
  });

  test('applies incremental edits against one captured revision and advances it once', async () => {
    const { api } = createMemoryDocuments();
    const identity = resource();
    await api.write({ token: mutationToken(), resource: identity, content: 'alpha beta gamma', encoding: 'utf-8', bom: false, expectedRevision: null, operationId: '1' });
    const registry = new DocumentRegistry({ documents: api, getGeneration: () => 1, recoverySessionId: 'session' });
    const opened = await registry.open(identity);

    const result = registry.applyEdits(identity, {
      expectedLocalEditRevision: opened.localEditRevision,
      edits: [
        { from: 0, to: 5, insert: 'A' },
        { from: 11, to: 16, insert: 'G' },
      ],
      origin: 'monaco:view-a',
    });

    expect(result.status).toBe('applied');
    if (result.status === 'applied') {
      expect(result.record.buffer).toBe('A beta G');
      expect(result.record.localEditRevision).toBe(opened.localEditRevision + 1);
      expect(result.record.lastChanges).toEqual([
        { from: 11, to: 16, insert: 'G' },
        { from: 0, to: 5, insert: 'A' },
      ]);
    }
    registry.dispose();
  });

  test('rejects stale and invalid incremental edits without mutating the buffer', async () => {
    const { api } = createMemoryDocuments();
    const identity = resource();
    await api.write({ token: mutationToken(), resource: identity, content: 'abcdef', encoding: 'utf-8', bom: false, expectedRevision: null, operationId: '1' });
    const registry = new DocumentRegistry({ documents: api, getGeneration: () => 1, recoverySessionId: 'session' });
    const opened = await registry.open(identity);
    registry.applyTransaction(identity, 'abcdef!', { origin: 'other-view' });

    const stale = registry.applyEdits(identity, {
      expectedLocalEditRevision: opened.localEditRevision,
      edits: [{ from: 0, to: 1, insert: 'A' }],
      origin: 'monaco:view-a',
    });
    expect(stale.status).toBe('stale');
    if (stale.status === 'stale') {
      expect(stale.actualLocalEditRevision).toBe(opened.localEditRevision + 1);
    }
    const current = registry.get(identity);
    if (!current) throw new Error('expected current document');
    const invalidRange = registry.applyEdits(identity, {
      expectedLocalEditRevision: current.localEditRevision,
      edits: [{ from: 2, to: 99, insert: '' }],
      origin: 'monaco:view-a',
    });
    expect(invalidRange.status).toBe('invalid');
    if (invalidRange.status === 'invalid') expect(invalidRange.reason).toBe('invalid-range');
    const overlapping = registry.applyEdits(identity, {
      expectedLocalEditRevision: current.localEditRevision,
      edits: [
        { from: 1, to: 4, insert: '' },
        { from: 3, to: 5, insert: '' },
      ],
      origin: 'monaco:view-a',
    });
    expect(overlapping.status).toBe('invalid');
    if (overlapping.status === 'invalid') expect(overlapping.reason).toBe('overlapping-ranges');
    expect(registry.get(identity)?.buffer).toBe('abcdef!');
    expect(registry.get(identity)?.localEditRevision).toBe(current.localEditRevision);
    registry.dispose();
  });

  test('keeps document instance identity across reload and move within a registry', async () => {
    const { api } = createMemoryDocuments();
    const identity = resource('before.txt');
    const moved = resource('after.txt');
    await api.write({ token: mutationToken(), resource: identity, content: 'base', encoding: 'utf-8', bom: false, expectedRevision: null, operationId: '1' });
    let sequence = 0;
    const registry = new DocumentRegistry({
      documents: api,
      getGeneration: () => 1,
      recoverySessionId: 'session',
      createDocumentInstanceId: () => `document-${++sequence}`,
    });
    const opened = await registry.open(identity);
    const reloaded = await registry.reload(identity);
    expect(reloaded.documentInstanceId).toBe(opened.documentInstanceId);

    registry.handleWatchEvent({ sourceId: 'test', generation: 1, kind: 'moved', sequence: 1, from: identity, resource: moved });
    expect(registry.get(moved)?.documentInstanceId).toBe(opened.documentInstanceId);
    registry.dispose();
  });

  test('reloads clean documents and conflicts when dirty content differs', async () => {
    const { api, files } = createMemoryDocuments();
    const identity = resource();
    await api.write({ token: mutationToken(), resource: identity, content: 'one', encoding: 'utf-8', bom: false, expectedRevision: null, operationId: '1' });
    const registry = new DocumentRegistry({ documents: api, getGeneration: () => 1, recoverySessionId: 'session' });
    await registry.open(identity);
    const initialVersion = registry.get(identity)?.localEditRevision;
    files.set(documentKey(identity), { content: 'two', revision: 'd1_external' });
    await registry.reload(identity);
    expect(registry.get(identity)?.buffer).toBe('two');
    expect(registry.get(identity)?.dirty).toBe(false);
    expect(registry.get(identity)?.localEditRevision).toBe((initialVersion ?? 0) + 1);
    expect(registry.get(identity)?.lastChanges).toEqual([{ from: 0, to: 3, insert: 'two' }]);
    registry.applyTransaction(identity, 'local', { origin: 'view' });
    files.set(documentKey(identity), { content: 'disk', revision: 'd1_later' });
    await registry.reload(identity);
    expect(registry.get(identity)?.status).toBe('conflict');
    expect(registry.get(identity)?.buffer).toBe('local');
    expect(registry.get(identity)?.conflict?.ancestorContent).toBe('two');
    expect(registry.get(identity)?.conflict?.diskContent).toBe('disk');
    registry.dispose();
  });

  test('save in flight keeps later edits dirty', async () => {
    const { api } = createMemoryDocuments();
    const identity = resource();
    await api.write({ token: mutationToken(), resource: identity, content: 'base', encoding: 'utf-8', bom: false, expectedRevision: null, operationId: '1' });
    let releaseWrite: () => void = () => undefined;
    const hold = new Promise<void>((resolve) => {
      releaseWrite = () => resolve();
    });
    const slow: DocumentsAPI = {
      ...api,
      write: async (request) => {
        await hold;
        return api.write(request);
      },
    };
    const registry = new DocumentRegistry({ documents: slow, getGeneration: () => 1, recoverySessionId: 'session' });
    await registry.open(identity);
    registry.applyTransaction(identity, 'first', { origin: 'view' });
    const saving = registry.save(identity);
    registry.applyTransaction(identity, 'second', { origin: 'view' });
    releaseWrite();
    const saved = await saving;
    expect(saved.buffer).toBe('second');
    expect(saved.dirty).toBe(true);
    registry.dispose();
  });

  test('read failure preserves dirty buffers', async () => {
    const { api } = createMemoryDocuments();
    const identity = resource();
    await api.write({ token: mutationToken(), resource: identity, content: 'ok', encoding: 'utf-8', bom: false, expectedRevision: null, operationId: '1' });
    let failRead = false;
    const gated: DocumentsAPI = {
      ...api,
      read: async (ref) => {
        if (failRead) throw new Error('disk exploded');
        return api.read(ref);
      },
    };
    const registry = new DocumentRegistry({ documents: gated, getGeneration: () => 1, recoverySessionId: 'session' });
    await registry.open(identity);
    registry.applyTransaction(identity, 'draft', { origin: 'view' });
    failRead = true;
    const opened = await registry.open(identity, { reload: true });
    expect(opened.buffer).toBe('draft');
    expect(opened.dirty).toBe(true);
    registry.dispose();
  });

  test('deleted watch events keep dirty buffers and require explicit recreation', async () => {
    const { api, files } = createMemoryDocuments();
    const identity = resource();
    await api.write({ token: mutationToken(), resource: identity, content: 'keep', encoding: 'utf-8', bom: false, expectedRevision: null, operationId: '1' });
    const registry = new DocumentRegistry({ documents: api, getGeneration: () => 1, recoverySessionId: 'session' });
    await registry.open(identity);
    registry.applyTransaction(identity, 'kept', { origin: 'view' });
    files.delete(documentKey(identity));
    registry.handleWatchEvent({ sourceId: 'test', generation: 1, kind: 'deleted', sequence: 1, resource: identity });
    expect(registry.get(identity)?.status).toBe('deleted');
    expect(registry.get(identity)?.buffer).toBe('kept');
    const blocked = await registry.save(identity);
    expect(blocked.status).toBe('deleted');
    expect(blocked.dirty).toBe(true);
    expect(files.has(documentKey(identity))).toBe(false);
    const saved = await registry.save(identity, { recreateDeleted: true });
    expect(saved.status).toBe('ready');
    expect(saved.dirty).toBe(false);
    expect(files.get(documentKey(identity))?.content).toBe('kept');
    registry.dispose();
  });

  test('reset events re-read open documents and preserve dirty conflicts', async () => {
    const { api, files } = createMemoryDocuments();
    const clean = resource('clean.txt');
    const dirty = resource('dirty.txt');
    await api.write({ token: mutationToken(), resource: clean, content: 'one', encoding: 'utf-8', bom: false, expectedRevision: null, operationId: '1' });
    await api.write({ token: mutationToken(), resource: dirty, content: 'base', encoding: 'utf-8', bom: false, expectedRevision: null, operationId: '2' });
    const registry = new DocumentRegistry({ documents: api, getGeneration: () => 1, recoverySessionId: 'session' });
    await registry.open(clean);
    await registry.open(dirty);
    registry.applyTransaction(dirty, 'local', { origin: 'view' });
    files.set(documentKey(clean), { content: 'two', revision: 'external-clean' });
    files.set(documentKey(dirty), { content: 'disk', revision: 'external-dirty' });
    registry.handleWatchEvent({ sourceId: 'test', generation: 2, kind: 'reset', sequence: 1, reason: 'reconnected' }, clean.workspaceId);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(registry.get(clean)?.buffer).toBe('two');
    expect(registry.get(dirty)?.buffer).toBe('local');
    expect(registry.get(dirty)?.status).toBe('conflict');
    registry.dispose();
  });

  test('dirty subscriptions only publish dirty-set membership changes', async () => {
    const { api, dirtyPublications } = createMemoryDocuments();
    const identity = resource();
    await api.write({ token: mutationToken(), resource: identity, content: 'base', encoding: 'utf-8', bom: false, expectedRevision: null, operationId: '1' });
    const registry = new DocumentRegistry({ documents: api, getGeneration: () => 1, recoverySessionId: 'session' });
    await registry.open(identity);
    let updates = 0;
    const unsubscribe = registry.subscribeDirty(identity.workspaceId, () => { updates += 1; });
    registry.applyTransaction(identity, 'first', { origin: 'view' });
    registry.applyTransaction(identity, 'second', { origin: 'view' });
    expect(updates).toBe(1);
    expect(registry.dirtyResourceIds(identity.workspaceId)).toEqual(new Set([identity.resourceId]));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(dirtyPublications.at(-1)?.resources).toHaveLength(1);
    expect(dirtyPublications.at(-1)?.resources[0]?.resource).toEqual(identity);
    await registry.save(identity);
    expect(updates).toBe(2);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(dirtyPublications.at(-1)?.resources).toEqual([]);
    unsubscribe();
    registry.dispose();
  });

  test('stale generation completions do not replace newer buffers', async () => {
    const { api } = createMemoryDocuments();
    const identity = resource();
    await api.write({ token: mutationToken(), resource: identity, content: 'v1', encoding: 'utf-8', bom: false, expectedRevision: null, operationId: '1' });
    let generation = 1;
    let finishRead: ((value: PiariumDocumentReadResult) => void) | undefined;
    const gated: DocumentsAPI = {
      ...api,
      read: () => new Promise((resolve) => {
        finishRead = resolve;
      }),
    };
    const registry = new DocumentRegistry({ documents: gated, getGeneration: () => generation, recoverySessionId: 'session' });
    const pending = registry.open(identity);
    generation = 2;
    finishRead?.({
      status: 'ready',
      epoch: 1,
      resource: identity,
      revision: 'stale',
      content: 'old-host',
      encoding: 'utf-8',
      bom: false,
      byteLength: 8,
    });
    await pending;
    expect(registry.get(identity)?.buffer).not.toBe('old-host');
    registry.dispose();
  });

  test('restores a recovery journal into a dirty buffer without writing the file', async () => {
    const { api, files } = createMemoryDocuments();
    const identity = resource();
    await api.write({ token: mutationToken(), resource: identity, content: 'disk', encoding: 'utf-8', bom: false, expectedRevision: null, operationId: '1' });
    const registry = new DocumentRegistry({
      documents: api,
      getGeneration: () => 1,
      recoverySessionId: 'session',
      journalDebounceMs: 0,
    });
    await registry.open(identity);
    registry.applyTransaction(identity, 'recovered', { origin: 'view' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const restored = new DocumentRegistry({ documents: api, getGeneration: () => 1, recoverySessionId: 'session' });
    await restored.open(identity);
    expect(restored.get(identity)?.buffer).toBe('recovered');
    expect(restored.get(identity)?.dirty).toBe(true);
    expect(files.get(documentKey(identity))?.content).toBe('disk');
    registry.dispose();
    restored.dispose();
  });

  test('keeps a journal from an older workspace epoch as history instead of replaying it', async () => {
    const { api, files, setEpoch } = createMemoryDocuments();
    const identity = resource();
    await api.write({ token: mutationToken(), resource: identity, content: 'disk', encoding: 'utf-8', bom: false, expectedRevision: null, operationId: '1' });
    const first = new DocumentRegistry({ documents: api, getGeneration: () => 1, recoverySessionId: 'session', journalDebounceMs: 0 });
    await first.open(identity);
    first.applyTransaction(identity, 'old-epoch-draft', { origin: 'view' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    first.dispose();

    setEpoch(2);
    const restored = new DocumentRegistry({ documents: api, getGeneration: () => 1, recoverySessionId: 'session' });
    await restored.open(identity);
    expect(restored.get(identity)?.buffer).toBe('disk');
    expect(restored.get(identity)?.dirty).toBe(false);
    expect(files.get(documentKey(identity))?.content).toBe('disk');
    restored.dispose();
  });

  test('does not replay a journal when the workspace epoch changes while it is being read', async () => {
    const { api, journals, setEpoch } = createMemoryDocuments();
    const identity = resource();
    await api.write({ token: mutationToken(), resource: identity, content: 'disk', encoding: 'utf-8', bom: false, expectedRevision: null, operationId: '1' });
    await api.writeRecoveryJournal({
      token: mutationToken(),
      workspaceId: identity.workspaceId,
      recoverySessionId: 'session',
      resource: identity,
      content: 'old-epoch-draft',
      encoding: 'utf-8',
      bom: false,
      baseRevision: 'd1_1',
      expectedRevision: null,
    });

    let releaseJournal: () => void = () => undefined;
    const journalReadStarted = new Promise<void>((resolve) => {
      releaseJournal = () => resolve();
    });
    let signalReadStarted: () => void = () => undefined;
    const readStarted = new Promise<void>((resolve) => {
      signalReadStarted = resolve;
    });
    const delayed: DocumentsAPI = {
      ...api,
      readRecoveryJournal: async (journalId) => {
        signalReadStarted();
        await journalReadStarted;
        return api.readRecoveryJournal(journalId);
      },
    };
    const registry = new DocumentRegistry({ documents: delayed, getGeneration: () => 1, recoverySessionId: 'session' });
    const pending = registry.open(identity);
    await readStarted;

    setEpoch(2);
    await registry.reload(identity);
    releaseJournal();
    await pending;

    expect(registry.get(identity)?.buffer).toBe('disk');
    expect(registry.get(identity)?.dirty).toBe(false);
    expect(journals.size).toBe(1);
    registry.dispose();
  });

  test('does not replay a journal after the runtime generation changes while it is being read', async () => {
    const { api, journals } = createMemoryDocuments();
    const identity = resource();
    await api.write({ token: mutationToken(), resource: identity, content: 'disk', encoding: 'utf-8', bom: false, expectedRevision: null, operationId: '1' });
    await api.writeRecoveryJournal({
      token: mutationToken(),
      workspaceId: identity.workspaceId,
      recoverySessionId: 'session',
      resource: identity,
      content: 'stale-generation-draft',
      encoding: 'utf-8',
      bom: false,
      baseRevision: 'd1_1',
      expectedRevision: null,
    });

    let generation = 1;
    let releaseJournal: () => void = () => undefined;
    const journalReadStarted = new Promise<void>((resolve) => {
      releaseJournal = () => resolve();
    });
    let signalReadStarted: () => void = () => undefined;
    const readStarted = new Promise<void>((resolve) => {
      signalReadStarted = resolve;
    });
    const delayed: DocumentsAPI = {
      ...api,
      readRecoveryJournal: async (journalId) => {
        signalReadStarted();
        await journalReadStarted;
        return api.readRecoveryJournal(journalId);
      },
    };
    const registry = new DocumentRegistry({ documents: delayed, getGeneration: () => generation, recoverySessionId: 'session' });
    const pending = registry.open(identity);
    await readStarted;
    generation = 2;
    releaseJournal();
    await pending;

    expect(registry.get(identity)?.buffer).toBe('disk');
    expect(registry.get(identity)?.dirty).toBe(false);
    expect(journals.size).toBe(1);
    registry.dispose();
  });

  test('does not replay a journal into a moved document identity after an asynchronous read', async () => {
    const { api, journals } = createMemoryDocuments();
    const identity = resource();
    const moved = resource('renamed.txt');
    await api.write({ token: mutationToken(), resource: identity, content: 'disk', encoding: 'utf-8', bom: false, expectedRevision: null, operationId: '1' });
    await api.writeRecoveryJournal({
      token: mutationToken(),
      workspaceId: identity.workspaceId,
      recoverySessionId: 'session',
      resource: identity,
      content: 'moved-document-draft',
      encoding: 'utf-8',
      bom: false,
      baseRevision: 'd1_1',
      expectedRevision: null,
    });

    let releaseJournal: () => void = () => undefined;
    const journalReadStarted = new Promise<void>((resolve) => {
      releaseJournal = () => resolve();
    });
    let signalReadStarted: () => void = () => undefined;
    const readStarted = new Promise<void>((resolve) => {
      signalReadStarted = resolve;
    });
    const delayed: DocumentsAPI = {
      ...api,
      readRecoveryJournal: async (journalId) => {
        signalReadStarted();
        await journalReadStarted;
        return api.readRecoveryJournal(journalId);
      },
    };
    const registry = new DocumentRegistry({ documents: delayed, getGeneration: () => 1, recoverySessionId: 'session' });
    const pending = registry.open(identity);
    await readStarted;
    registry.handleWatchEvent({ sourceId: 'test', generation: 1, kind: 'moved', sequence: 1, from: identity, resource: moved });
    releaseJournal();
    await pending;

    expect(registry.get(identity)).toBeUndefined();
    expect(registry.get(moved)?.buffer).toBe('disk');
    expect(registry.get(moved)?.dirty).toBe(false);
    expect(journals.size).toBe(1);
    registry.dispose();
  });

  test('clears the current recovery revision after repeated journal writes', async () => {
    const { api, journals } = createMemoryDocuments();
    const identity = resource();
    await api.write({ token: mutationToken(), resource: identity, content: 'disk', encoding: 'utf-8', bom: false, expectedRevision: null, operationId: '1' });
    const registry = new DocumentRegistry({
      documents: api,
      getGeneration: () => 1,
      recoverySessionId: 'session',
      journalDebounceMs: 0,
    });
    await registry.open(identity);
    registry.applyTransaction(identity, 'draft-one', { origin: 'view' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    registry.applyTransaction(identity, 'draft-two', { origin: 'view' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect([...journals.values()][0]?.revision).toBe(2);
    await registry.save(identity);
    expect(journals.size).toBe(0);
    registry.dispose();
  });

  test('previews and atomically applies a multi-file workspace edit without writing disk', async () => {
    const { api, files } = createMemoryDocuments();
    const first = resource('first.ts');
    const second = resource('second.ts');
    await api.write({ token: mutationToken(), resource: first, content: 'const first = 1;\n', encoding: 'utf-8', bom: false, expectedRevision: null, operationId: '1' });
    await api.write({ token: mutationToken(), resource: second, content: 'const second = first;\n', encoding: 'utf-8', bom: false, expectedRevision: null, operationId: '2' });
    const registry = new DocumentRegistry({ documents: api, getGeneration: () => 1, recoverySessionId: 'session' });
    const opened = await registry.open(first);
    let listenerSawAtomicState = false;
    registry.subscribe(first, () => {
      listenerSawAtomicState = registry.get(second)?.buffer === 'const second = renamed;\n';
    });

    const preview = await registry.prepareWorkspaceEdit({
      workspaceId: first.workspaceId,
      origin: 'language:rename',
      textEdits: [
        {
          identity: first,
          version: opened.localEditRevision,
          edits: [{ range: { start: { line: 0, character: 6 }, end: { line: 0, character: 11 } }, newText: 'renamed' }],
        },
        {
          identity: second,
          version: null,
          edits: [{ range: { start: { line: 0, character: 15 }, end: { line: 0, character: 20 } }, newText: 'renamed' }],
        },
      ],
    });
    expect(preview.status).toBe('ready');
    if (preview.status !== 'ready') throw new Error('expected workspace edit preview');
    expect(preview.files.map((file) => file.identity.resourceId)).toEqual(['first.ts', 'second.ts']);
    expect(registry.get(first)?.buffer).toBe('const first = 1;\n');
    expect(registry.get(second)).toBeUndefined();

    const applied = await registry.applyWorkspaceEdit(preview.groupId);
    expect(applied.status).toBe('applied');
    expect(listenerSawAtomicState).toBe(true);
    expect(registry.get(first)?.buffer).toBe('const renamed = 1;\n');
    expect(registry.get(second)?.buffer).toBe('const second = renamed;\n');
    expect(files.get(documentKey(first))?.content).toBe('const first = 1;\n');
    expect(files.get(documentKey(second))?.content).toBe('const second = first;\n');

    const undone = registry.undoWorkspaceEdit(preview.groupId);
    expect(undone.status).toBe('undone');
    expect(registry.get(first)?.buffer).toBe('const first = 1;\n');
    expect(registry.get(second)?.buffer).toBe('const second = first;\n');
    registry.dispose();
  });

  test('rejects a stale workspace edit without partially updating other files', async () => {
    const { api } = createMemoryDocuments();
    const first = resource('first.ts');
    const second = resource('second.ts');
    await api.write({ token: mutationToken(), resource: first, content: 'first\n', encoding: 'utf-8', bom: false, expectedRevision: null, operationId: '1' });
    await api.write({ token: mutationToken(), resource: second, content: 'second\n', encoding: 'utf-8', bom: false, expectedRevision: null, operationId: '2' });
    const registry = new DocumentRegistry({ documents: api, getGeneration: () => 1, recoverySessionId: 'session' });
    const firstRecord = await registry.open(first);
    await registry.open(second);
    const preview = await registry.prepareWorkspaceEdit({
      workspaceId: first.workspaceId,
      origin: 'language:rename',
      textEdits: [
        { identity: first, version: firstRecord.localEditRevision, edits: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, newText: 'changed' }] },
        { identity: second, version: 0, edits: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } }, newText: 'changed' }] },
      ],
    });
    if (preview.status !== 'ready') throw new Error('expected workspace edit preview');
    registry.applyTransaction(first, 'user edit\n', { origin: 'editor' });
    const result = await registry.applyWorkspaceEdit(preview.groupId);
    expect(result.status).toBe('rejected');
    expect(registry.get(first)?.buffer).toBe('user edit\n');
    expect(registry.get(second)?.buffer).toBe('second\n');
    registry.dispose();
  });

  test('returns explicit unsupported for resource operations before changing documents', async () => {
    const { api } = createMemoryDocuments();
    const registry = new DocumentRegistry({ documents: api, getGeneration: () => 1, recoverySessionId: 'session' });
    const result = await registry.prepareWorkspaceEdit({
      workspaceId: resource().workspaceId,
      origin: 'language:code-action',
      textEdits: [],
      resourceOperations: [{ kind: 'create', identity: resource('created.ts') }],
    });
    expect(result).toEqual({
      status: 'rejected',
      failures: [{
        reason: 'resource-operation-unsupported',
        message: 'Workspace resource create, rename, and delete operations require a Host batch mutation contract',
      }],
    });
    registry.dispose();
  });
});
