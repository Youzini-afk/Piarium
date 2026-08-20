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

const createMemoryDocuments = () => {
  const files = new Map<string, { content: string; revision: string }>();
  const journals = new Map<string, {
    journalId: string;
    resource: PiariumResourceReference;
    content: string;
    revision: number;
    baseRevision: string | null;
  }>();
  const listeners = new Set<(event: PiariumWorkspaceFileEvent) => void>();
  let revisionSeq = 1;
  let watchSequence = 0;
  const keyOf = (ref: PiariumResourceReference) => `${ref.workspaceId}\0${ref.resourceId}`;
  const nextRevision = () => `d1_${revisionSeq++}`;
  const emit = (event: PiariumWorkspaceFileEvent) => {
    for (const listener of listeners) listener(event);
  };

  const api: DocumentsAPI = {
    resolveWorkspace: async () => ({ workspaceId: resource().workspaceId, hostId: 'host-1' }),
    read: async (ref) => {
      const file = files.get(keyOf(ref));
      if (!file) return { status: 'missing', resource: ref };
      return {
        status: 'ready',
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
          return { status: 'conflict', current: { status: 'ready', resource: request.resource, revision: current.revision, encoding: 'utf-8', bom: false, byteLength: current.content.length } };
        }
      } else if (!current || current.revision !== request.expectedRevision) {
        return {
          status: 'conflict',
          current: current
            ? { status: 'ready', resource: request.resource, revision: current.revision, encoding: 'utf-8', bom: false, byteLength: current.content.length }
            : { status: 'missing', resource: request.resource },
        };
      }
      const revision = nextRevision();
      files.set(key, { content: request.content, revision });
      emit({ kind: current ? 'changed' : 'created', sequence: ++watchSequence, resource: request.resource, revision });
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
        revision: 1,
        baseRevision: request.baseRevision,
      };
      journals.set(journalId, created);
      return { status: 'written', journal: {
        journalId,
        resource: request.resource,
        revision: 1,
        baseRevision: request.baseRevision,
        updatedAt: '2026-08-20T00:00:00.000Z',
        byteLength: request.content.length,
      } };
    },
    deleteRecoveryJournal: async (request) => {
      journals.delete(request.journalId);
      return { status: 'deleted' };
    },
  };

  return { api, files, emit };
};

describe('DocumentRegistry', () => {
  test('keeps independent dirty buffers when switching documents', async () => {
    const { api } = createMemoryDocuments();
    await api.write({ resource: resource('a.txt'), content: 'A', encoding: 'utf-8', bom: false, expectedRevision: null, operationId: '1' });
    await api.write({ resource: resource('b.txt'), content: 'B', encoding: 'utf-8', bom: false, expectedRevision: null, operationId: '2' });
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

  test('two views share one buffer and keep independent origins', async () => {
    const { api } = createMemoryDocuments();
    const identity = resource();
    await api.write({ resource: identity, content: 'base', encoding: 'utf-8', bom: false, expectedRevision: null, operationId: '1' });
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

  test('reloads clean documents and conflicts when dirty content differs', async () => {
    const { api, files } = createMemoryDocuments();
    const identity = resource();
    await api.write({ resource: identity, content: 'one', encoding: 'utf-8', bom: false, expectedRevision: null, operationId: '1' });
    const registry = new DocumentRegistry({ documents: api, getGeneration: () => 1, recoverySessionId: 'session' });
    await registry.open(identity);
    files.set(documentKey(identity), { content: 'two', revision: 'd1_external' });
    await registry.reload(identity);
    expect(registry.get(identity)?.buffer).toBe('two');
    expect(registry.get(identity)?.dirty).toBe(false);
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
    await api.write({ resource: identity, content: 'base', encoding: 'utf-8', bom: false, expectedRevision: null, operationId: '1' });
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
    await api.write({ resource: identity, content: 'ok', encoding: 'utf-8', bom: false, expectedRevision: null, operationId: '1' });
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

  test('deleted watch events keep dirty buffers', async () => {
    const { api, files } = createMemoryDocuments();
    const identity = resource();
    await api.write({ resource: identity, content: 'keep', encoding: 'utf-8', bom: false, expectedRevision: null, operationId: '1' });
    const registry = new DocumentRegistry({ documents: api, getGeneration: () => 1, recoverySessionId: 'session' });
    await registry.open(identity);
    registry.applyTransaction(identity, 'kept', { origin: 'view' });
    files.delete(documentKey(identity));
    registry.handleWatchEvent({ kind: 'deleted', sequence: 1, resource: identity });
    expect(registry.get(identity)?.status).toBe('deleted');
    expect(registry.get(identity)?.buffer).toBe('kept');
    const saved = await registry.save(identity);
    expect(saved.status).toBe('ready');
    expect(saved.dirty).toBe(false);
    expect(files.get(documentKey(identity))?.content).toBe('kept');
    registry.dispose();
  });

  test('stale generation completions do not replace newer buffers', async () => {
    const { api } = createMemoryDocuments();
    const identity = resource();
    await api.write({ resource: identity, content: 'v1', encoding: 'utf-8', bom: false, expectedRevision: null, operationId: '1' });
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
    await api.write({ resource: identity, content: 'disk', encoding: 'utf-8', bom: false, expectedRevision: null, operationId: '1' });
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
});
