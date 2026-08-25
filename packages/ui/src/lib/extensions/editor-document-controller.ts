import type {
  PiariumEditorDocumentApplyEditsResult,
  PiariumEditorDocumentController,
  PiariumEditorDocumentEdit,
  PiariumEditorDocumentSnapshot,
  PiariumEditorDocumentUpdateResult,
} from '@piarium/extension-contract';

import { getDocumentRegistry } from '@/lib/documents/session';
import type { DocumentIdentity, DocumentRecord } from '@/lib/documents/types';

type EditorDocumentRegistry = Pick<ReturnType<typeof getDocumentRegistry>,
  'applyEdits' | 'get' | 'open' | 'save' | 'subscribe'>;

const snapshotFromRecord = (record: DocumentRecord | undefined): PiariumEditorDocumentSnapshot => {
  const status = record && [
    'binary',
    'conflict',
    'deleted',
    'error',
    'missing',
    'ready',
    'unsupported-encoding',
  ].includes(record.status)
    ? record.status as PiariumEditorDocumentSnapshot['status']
    : 'error';
  return {
    baseRevision: record?.baseRevision ?? null,
    content: record?.buffer ?? '',
    dirty: record?.dirty ?? false,
    documentVersion: record?.localEditRevision ?? 0,
    saving: record?.saving ?? false,
    status,
    ...(record?.errorMessage ? { errorMessage: record.errorMessage } : {}),
  };
};

const mutationUnsupported = (record: DocumentRecord): boolean => (
  record.status === 'binary'
  || record.status === 'deleted'
  || record.status === 'error'
  || record.status === 'loading'
  || record.status === 'unloaded'
  || record.status === 'unsupported-encoding'
);

export const createEditorDocumentController = (options: {
  identity: DocumentIdentity;
  origin: string;
  registry?: EditorDocumentRegistry;
}): PiariumEditorDocumentController => {
  const registry = options.registry ?? getDocumentRegistry();
  const currentRecord = async (): Promise<DocumentRecord> => (
    registry.get(options.identity) ?? registry.open(options.identity)
  );

  const applyEdits = async (
    edits: readonly PiariumEditorDocumentEdit[],
    expectedDocumentVersion: number,
  ): Promise<PiariumEditorDocumentApplyEditsResult> => {
    const current = await currentRecord();
    if (current.localEditRevision !== expectedDocumentVersion) {
      return { status: 'stale', snapshot: snapshotFromRecord(current) };
    }
    if (current.status === 'conflict') {
      return { status: 'conflict', snapshot: snapshotFromRecord(current) };
    }
    if (mutationUnsupported(current)) {
      return { status: 'unsupported', snapshot: snapshotFromRecord(current) };
    }
    const result = registry.applyEdits(options.identity, {
      edits: edits.map((edit) => ({ ...edit })),
      expectedLocalEditRevision: expectedDocumentVersion,
      origin: options.origin,
    });
    const snapshot = snapshotFromRecord(result.record);
    if (result.status === 'applied') return { status: 'applied', snapshot };
    if (result.status === 'invalid') return { status: result.reason, snapshot };
    return { status: result.status, snapshot };
  };

  const replaceContent = async (
    content: string,
    expectedDocumentVersion: number,
  ): Promise<PiariumEditorDocumentUpdateResult> => {
    const current = await currentRecord();
    if (current.localEditRevision !== expectedDocumentVersion) {
      return { status: 'stale', snapshot: snapshotFromRecord(current) };
    }
    if (current.status === 'conflict') {
      return { status: 'conflict', snapshot: snapshotFromRecord(current) };
    }
    const result = await applyEdits([{
      from: 0,
      insert: content,
      to: current.buffer.length,
    }], expectedDocumentVersion);
    if (result.status === 'applied') return { status: 'updated', snapshot: result.snapshot };
    if (result.status === 'conflict' || result.status === 'stale' || result.status === 'unsupported') {
      return result;
    }
    // The range above was created from the same captured snapshot. An invalid result therefore means
    // the authority changed without the expected revision and must not be reported as a successful write.
    return { status: 'stale', snapshot: result.snapshot };
  };

  return {
    applyEdits,
    getSnapshot: () => snapshotFromRecord(registry.get(options.identity)),
    replaceContent,
    save: async (expectedDocumentVersion): Promise<PiariumEditorDocumentUpdateResult> => {
      const current = await currentRecord();
      if (current.localEditRevision !== expectedDocumentVersion) {
        return { status: 'stale', snapshot: snapshotFromRecord(current) };
      }
      if (current.status === 'conflict') {
        return { status: 'conflict', snapshot: snapshotFromRecord(current) };
      }
      if (mutationUnsupported(current)) {
        return { status: 'unsupported', snapshot: snapshotFromRecord(current) };
      }
      const next = await registry.save(options.identity);
      return {
        status: next.status === 'conflict'
          ? 'conflict'
          : next.status === 'binary' || next.status === 'unsupported-encoding'
            ? 'unsupported'
            : 'updated',
        snapshot: snapshotFromRecord(next),
      };
    },
    subscribe: (listener) => registry.subscribe(options.identity, listener),
  };
};
