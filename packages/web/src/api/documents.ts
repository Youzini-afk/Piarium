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

const isResource = (value: unknown): value is PiariumResourceReference => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.workspaceId === 'string' && typeof candidate.resourceId === 'string';
};

const parseWorkspaceFileEvent = (value: unknown): PiariumWorkspaceFileEvent => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DocumentsError('Document watch returned an invalid event', { reason: 'failed' });
  }
  const event = value as Record<string, unknown>;
  if (
    !Number.isSafeInteger(event.sequence)
    || Number(event.sequence) < 0
    || typeof event.kind !== 'string'
    || Object.hasOwn(event, 'content')
  ) {
    throw new DocumentsError('Document watch returned an invalid event', { reason: 'failed' });
  }
  if (event.kind === 'reset') {
    if (!['overflow', 'reconnected', 'authority-changed'].includes(String(event.reason))) {
      throw new DocumentsError('Document watch returned an invalid reset event', { reason: 'failed' });
    }
    return event as PiariumWorkspaceFileEvent;
  }
  if (!isResource(event.resource)) {
    throw new DocumentsError('Document watch returned an invalid resource event', { reason: 'failed' });
  }
  if (event.revision !== undefined && typeof event.revision !== 'string') {
    throw new DocumentsError('Document watch returned an invalid revision', { reason: 'failed' });
  }
  if (event.kind === 'moved') {
    if (!isResource(event.from)) {
      throw new DocumentsError('Document watch returned an invalid move event', { reason: 'failed' });
    }
    return event as PiariumWorkspaceFileEvent;
  }
  if (!['created', 'changed', 'deleted'].includes(event.kind)) {
    throw new DocumentsError('Document watch returned an unknown event', { reason: 'failed' });
  }
  return event as PiariumWorkspaceFileEvent;
};

const waitForReconnect = (signal: AbortSignal, delayMs: number): Promise<void> => new Promise((resolve) => {
  if (signal.aborted) {
    resolve();
    return;
  }
  const timer = setTimeout(resolve, delayMs);
  signal.addEventListener('abort', () => {
    clearTimeout(timer);
    resolve();
  }, { once: true });
});

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
      const event = parseWorkspaceFileEvent(JSON.parse(line.slice(6)));
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
    const unsubscribe = subscribeRuntimeEndpointWillChange(() => {
      listener({ kind: 'reset', sequence: 0, reason: 'authority-changed' });
      controller.abort();
    });
    void (async () => {
      let reconnectDelayMs = 250;
      let reconnecting = false;
      while (!controller.signal.aborted) {
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
          if (reconnecting) {
            listener({ kind: 'reset', sequence: 0, reason: 'reconnected' });
            reconnecting = false;
          }
          reconnectDelayMs = 250;
          await readSseEvents(response, listener, controller.signal);
          if (!controller.signal.aborted) throw new DocumentsError('Document watch ended', { reason: 'failed' });
        } catch (error) {
          if (controller.signal.aborted) break;
          if (getRuntimeEndpointGeneration() !== generation) {
            listener({ kind: 'reset', sequence: 0, reason: 'authority-changed' });
            break;
          }
          const status = error instanceof DocumentsError ? error.status : undefined;
          if (typeof status === 'number' && status < 500) {
            listener({ kind: 'reset', sequence: 0, reason: 'authority-changed' });
            break;
          }
          reconnecting = true;
          await waitForReconnect(controller.signal, reconnectDelayMs);
          reconnectDelayMs = Math.min(reconnectDelayMs * 2, 5_000);
        }
      }
      unsubscribe();
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
    if (!Array.isArray(payload.journals)) {
      throw new DocumentsError('Document recovery list returned an invalid response', { reason: 'failed' });
    }
    return payload.journals;
  },
  readRecoveryJournal: (journalId) => postJson('/api/documents/recovery/read', { journalId }) as Promise<PiariumDocumentRecoveryReadResult>,
  writeRecoveryJournal: (request: PiariumDocumentRecoveryWriteRequest) => (
    postJson('/api/documents/recovery/write', request) as Promise<PiariumDocumentRecoveryWriteResult>
  ),
  deleteRecoveryJournal: (request) => postJson('/api/documents/recovery/delete', request) as Promise<Awaited<ReturnType<DocumentsAPI['deleteRecoveryJournal']>>>,
});
