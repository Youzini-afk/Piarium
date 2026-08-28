import type {
  DocumentsAPI,
  PiariumDocumentDeleteResult,
  PiariumDocumentMoveResult,
  PiariumDocumentReadResult,
  PiariumDocumentRecoveryJournalSummary,
  PiariumDocumentRecoveryReadResult,
  PiariumDocumentRecoveryWriteResult,
  PiariumDocumentWriteResult,
  PiariumWorkspaceFileEvent,
  PiariumWorkspaceIdentity,
  Subscription,
} from '@piarium/ui/lib/api/types';
import { DocumentsError, parseDocumentsFailureReason } from '@piarium/ui/lib/api/documents-errors';
import { createDocumentWatchEventTracker } from '@piarium/ui/lib/documents/watch-events';
import {
  getRuntimeEndpointGeneration,
  subscribeRuntimeEndpointWillChange,
} from '@piarium/ui/lib/runtime-switch';
import { sendBridgeMessage } from './bridge';

const assertGeneration = (generation: number): void => {
  if (generation !== getRuntimeEndpointGeneration()) {
    throw new DocumentsError('Application host endpoint changed', { reason: 'stale-completion' });
  }
};

const call = async <T>(type: string, payload?: unknown): Promise<T> => {
  const generation = getRuntimeEndpointGeneration();
  try {
    const data = await sendBridgeMessage<T>(type, payload);
    assertGeneration(generation);
    return data;
  } catch (error) {
    if (error instanceof DocumentsError) throw error;
    const details = error as { reason?: unknown; status?: unknown };
    if (typeof details?.reason !== 'string'
      && (typeof details?.status !== 'number' || !Number.isFinite(details.status))) {
      throw error;
    }
    throw new DocumentsError(error instanceof Error ? error.message : String(error), {
      reason: parseDocumentsFailureReason(details?.reason),
      ...(typeof details?.status === 'number' && Number.isFinite(details.status)
        ? { status: details.status }
        : {}),
    });
  }
};

export const createVSCodeDocumentsAPI = (): DocumentsAPI => ({
  resolveWorkspace: (input) => call<PiariumWorkspaceIdentity>('api:documents:resolveWorkspace', input),
  read: (resource) => call<PiariumDocumentReadResult>('api:documents:read', { resource }),
  write: (request) => call<PiariumDocumentWriteResult>('api:documents:write', request),
  move: (request) => call<PiariumDocumentMoveResult>('api:documents:move', request),
  delete: (request) => call<PiariumDocumentDeleteResult>('api:documents:delete', request),
  watch(workspaceId, listener, options): Subscription {
    const tracker = createDocumentWatchEventTracker(listener);
    const generation = getRuntimeEndpointGeneration();
    let watchId: string | null = null;
    let closed = false;
    const onEvent = (event: MessageEvent<{ type?: string; watchId?: string; event?: PiariumWorkspaceFileEvent }>) => {
      if (event.data?.type !== 'api:documents:watch:event') return;
      if (event.data.watchId !== watchId || !event.data.event) return;
      if (JSON.stringify(event.data.event).includes('"content":')) return;
      tracker.accept(event.data.event);
    };
    window.addEventListener('message', onEvent);
    const unsubscribe = subscribeRuntimeEndpointWillChange(() => {
      closed = true;
      if (watchId) void sendBridgeMessage('api:documents:watch:stop', { watchId });
      tracker.transportReset('authority-changed');
    });
    if (options?.signal?.aborted) {
      unsubscribe();
      window.removeEventListener('message', onEvent);
      return { close() {} };
    }
    options?.signal?.addEventListener('abort', () => {
      closed = true;
      if (watchId) void sendBridgeMessage('api:documents:watch:stop', { watchId });
    }, { once: true });
    void call<{ watchId: string }>('api:documents:watch:start', { workspaceId }).then((result) => {
      if (closed || generation !== getRuntimeEndpointGeneration()) {
        void sendBridgeMessage('api:documents:watch:stop', { watchId: result.watchId });
        return;
      }
      watchId = result.watchId;
    }).catch(() => undefined);
    return {
      close() {
        closed = true;
        unsubscribe();
        window.removeEventListener('message', onEvent);
        if (watchId) void sendBridgeMessage('api:documents:watch:stop', { watchId });
      },
    };
  },
  listRecoveryJournals: async (request) => {
    const payload = await call<{ journals?: PiariumDocumentRecoveryJournalSummary[] }>('api:documents:recovery:list', request);
    return Array.isArray(payload.journals) ? payload.journals : [];
  },
  readRecoveryJournal: (journalId) => call<PiariumDocumentRecoveryReadResult>('api:documents:recovery:read', { journalId }),
  writeRecoveryJournal: (request) => call<PiariumDocumentRecoveryWriteResult>('api:documents:recovery:write', request),
  deleteRecoveryJournal: (request) => call<Awaited<ReturnType<DocumentsAPI['deleteRecoveryJournal']>>>('api:documents:recovery:delete', request),
});
