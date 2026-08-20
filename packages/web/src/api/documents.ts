import type {
  DocumentsAPI,
  PiariumDocumentDeleteRequest,
  PiariumDocumentDeleteResult,
  PiariumDocumentMoveRequest,
  PiariumDocumentMoveResult,
  PiariumDocumentReadResult,
  PiariumDocumentRecoveryJournalSummary,
  PiariumDocumentRecoveryReadResult,
  PiariumDocumentRecoveryWriteRequest,
  PiariumDocumentRecoveryWriteResult,
  PiariumDocumentWriteRequest,
  PiariumDocumentWriteResult,
  PiariumResourceReference,
  PiariumWorkspaceFileEvent,
  PiariumWorkspaceIdentity,
  Subscription,
} from '@piarium/ui/lib/api/types';
import { DocumentsError, parseDocumentsFailureReason } from '@piarium/ui/lib/api/documents-errors';
import { runtimeFetch } from '@piarium/ui/lib/runtime-fetch';
import {
  getRuntimeEndpointGeneration,
  subscribeRuntimeEndpointWillChange,
} from '@piarium/ui/lib/runtime-switch';

const assertGeneration = (generation: number): void => {
  if (generation !== getRuntimeEndpointGeneration()) {
    throw new DocumentsError('Application host endpoint changed', { reason: 'stale-completion' });
  }
};

const postJson = async (path: string, body: unknown): Promise<unknown> => {
  const generation = getRuntimeEndpointGeneration();
  const response = await runtimeFetch(path, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  assertGeneration(generation);
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText })) as {
      error?: string;
      reason?: unknown;
    };
    throw new DocumentsError(error.error || 'Document request failed', {
      reason: parseDocumentsFailureReason(error.reason),
      status: response.status,
    });
  }
  return response.json();
};

const readSseEvents = async (
  response: Response,
  listener: (event: PiariumWorkspaceFileEvent) => void,
  signal: AbortSignal,
): Promise<void> => {
  const reader = response.body?.getReader();
  if (!reader) throw new DocumentsError('Document watch stream is unavailable', { reason: 'failed' });
  const decoder = new TextDecoder();
  let buffer = '';
  while (!signal.aborted) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split('\n\n');
    buffer = chunks.pop() ?? '';
    for (const chunk of chunks) {
      const line = chunk.split('\n').find((entry) => entry.startsWith('data: '));
      if (!line) continue;
      const event = JSON.parse(line.slice(6)) as PiariumWorkspaceFileEvent;
      if (JSON.stringify(event).includes('"content":')) continue;
      listener(event);
    }
  }
};

/**
 * Hosted Web, Electron, and mobile clients talk to the remote/in-process Web
 * Application Host. This module never uses a Capacitor filesystem plugin.
 */
export const createWebDocumentsAPI = (): DocumentsAPI => ({
  resolveWorkspace: (input) => postJson('/api/documents/workspace/resolve', input) as Promise<PiariumWorkspaceIdentity>,
  read: (resource: PiariumResourceReference) => postJson('/api/documents/read', { resource }) as Promise<PiariumDocumentReadResult>,
  write: (request: PiariumDocumentWriteRequest) => postJson('/api/documents/write', request) as Promise<PiariumDocumentWriteResult>,
  move: (request: PiariumDocumentMoveRequest) => postJson('/api/documents/move', request) as Promise<PiariumDocumentMoveResult>,
  delete: (request: PiariumDocumentDeleteRequest) => postJson('/api/documents/delete', request) as Promise<PiariumDocumentDeleteResult>,
  watch(workspaceId: string, listener: (event: PiariumWorkspaceFileEvent) => void, options): Subscription {
    const generation = getRuntimeEndpointGeneration();
    const controller = new AbortController();
    if (options?.signal) {
      if (options.signal.aborted) controller.abort();
      else options.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }
    const unsubscribe = subscribeRuntimeEndpointWillChange(() => controller.abort());
    void (async () => {
      try {
        assertGeneration(generation);
        const response = await runtimeFetch('/api/documents/watch', {
          headers: { Accept: 'text/event-stream' },
          query: { workspaceId },
          signal: controller.signal,
        });
        assertGeneration(generation);
        if (!response.ok) {
          throw new DocumentsError('Document watch failed', {
            reason: 'failed',
            status: response.status,
          });
        }
        await readSseEvents(response, listener, controller.signal);
      } catch {
        if (controller.signal.aborted) return;
        if (getRuntimeEndpointGeneration() !== generation) {
          listener({ kind: 'reset', sequence: 0, reason: 'authority-changed' });
        }
      } finally {
        unsubscribe();
      }
    })();
    return {
      close() {
        unsubscribe();
        controller.abort();
      },
    };
  },
  listRecoveryJournals: async (request) => {
    const payload = await postJson('/api/documents/recovery/list', request) as { journals?: PiariumDocumentRecoveryJournalSummary[] };
    return Array.isArray(payload.journals) ? payload.journals : [];
  },
  readRecoveryJournal: (journalId) => postJson('/api/documents/recovery/read', { journalId }) as Promise<PiariumDocumentRecoveryReadResult>,
  writeRecoveryJournal: (request: PiariumDocumentRecoveryWriteRequest) => (
    postJson('/api/documents/recovery/write', request) as Promise<PiariumDocumentRecoveryWriteResult>
  ),
  deleteRecoveryJournal: (request) => postJson('/api/documents/recovery/delete', request) as Promise<Awaited<ReturnType<DocumentsAPI['deleteRecoveryJournal']>>>,
});
