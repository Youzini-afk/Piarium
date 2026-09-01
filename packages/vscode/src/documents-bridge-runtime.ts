import type { Webview } from 'vscode';
import type { BridgeResponse } from './bridge';

type BridgeMessageInput = {
  id: string;
  type: string;
  payload?: unknown;
};

type DocumentAuthority = {
  resolveWorkspace: (input: unknown) => Promise<unknown>;
  read: (resource: unknown) => Promise<unknown>;
  write: (request: unknown) => Promise<unknown>;
  move: (request: unknown) => Promise<unknown>;
  delete: (request: unknown) => Promise<unknown>;
  watch: (workspaceId: string, listener: (event: unknown) => void) => { close: () => void };
  registerDirtySurface: (
    request: { generation: number; ownerId: string; workspaceId: string },
    listener: (event: unknown) => void,
  ) => { close: () => void };
  acknowledgeDirtyStateBarrier: (request: unknown) => Promise<unknown>;
  listRecoveryJournals: (request: unknown) => Promise<unknown>;
  readRecoveryJournal: (journalId: string) => Promise<unknown>;
  writeRecoveryJournal: (request: unknown) => Promise<unknown>;
  deleteRecoveryJournal: (request: unknown) => Promise<unknown>;
  publishDirtyBuffers: (request: unknown) => Promise<unknown>;
  clearDirtyBuffers: (request: unknown) => Promise<unknown>;
};

const watches = new Map<string, { close: () => void }>();
let watchSeq = 0;

const payloadRecord = (value: unknown): Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
);

const bridgeErrorDetails = (error: unknown): Pick<BridgeResponse, 'reason' | 'status'> => {
  if (!error || typeof error !== 'object' || Array.isArray(error)) return {};
  const details = error as { code?: unknown; reason?: unknown; statusCode?: unknown; status?: unknown };
  const reason = typeof details.code === 'string'
    ? details.code
    : typeof details.reason === 'string' ? details.reason : undefined;
  const statusValue = details.statusCode ?? details.status;
  const status = typeof statusValue === 'number' && Number.isFinite(statusValue)
    ? statusValue
    : undefined;
  return {
    ...(reason ? { reason } : {}),
    ...(status === undefined ? {} : { status }),
  };
};

export const handleDocumentsBridgeMessage = async (
  message: BridgeMessageInput,
  deps: {
    documents: DocumentAuthority;
    webview?: Webview;
  },
): Promise<BridgeResponse | null> => {
  const { id, type, payload } = message;
  const body = payloadRecord(payload);
  try {
    switch (type) {
      case 'api:documents:resolveWorkspace':
        return { id, type, success: true, data: await deps.documents.resolveWorkspace(body) };
      case 'api:documents:read':
        return { id, type, success: true, data: await deps.documents.read(body.resource) };
      case 'api:documents:write':
        return { id, type, success: true, data: await deps.documents.write(body) };
      case 'api:documents:move':
        return { id, type, success: true, data: await deps.documents.move(body) };
      case 'api:documents:delete':
        return { id, type, success: true, data: await deps.documents.delete(body) };
      case 'api:documents:dirty:publish':
        return { id, type, success: true, data: await deps.documents.publishDirtyBuffers(body) };
      case 'api:documents:dirty:clear':
        return { id, type, success: true, data: await deps.documents.clearDirtyBuffers(body) };
      case 'api:documents:dirty:barrier:ack':
        return { id, type, success: true, data: await deps.documents.acknowledgeDirtyStateBarrier(body) };
      case 'api:documents:recovery:list':
        return { id, type, success: true, data: { journals: await deps.documents.listRecoveryJournals(body) } };
      case 'api:documents:recovery:read':
        return { id, type, success: true, data: await deps.documents.readRecoveryJournal(String(body.journalId ?? '')) };
      case 'api:documents:recovery:write':
        return { id, type, success: true, data: await deps.documents.writeRecoveryJournal(body) };
      case 'api:documents:recovery:delete':
        return { id, type, success: true, data: await deps.documents.deleteRecoveryJournal(body) };
      case 'api:documents:watch:start': {
        const workspaceId = String(body.workspaceId ?? '');
        if (!workspaceId) {
          return { id, type, success: false, error: 'workspaceId is required', reason: 'failed', status: 400 };
        }
        const watchId = `watch_${++watchSeq}`;
        const sendEvent = (event: unknown) => {
          const serialized = JSON.stringify(event);
          if (serialized.includes('"content":')) return;
          void deps.webview?.postMessage({ type: 'api:documents:watch:event', watchId, event });
        };
        const subscription = deps.documents.watch(workspaceId, sendEvent);
        const ownerId = typeof body.ownerId === 'string' ? body.ownerId : '';
        const generation = Number(body.generation);
        const dirtySubscription = ownerId && Number.isSafeInteger(generation) && generation >= 0
          ? deps.documents.registerDirtySurface({ generation, ownerId, workspaceId }, sendEvent)
          : null;
        watches.set(watchId, {
          close() {
            subscription.close();
            dirtySubscription?.close();
          },
        });
        return { id, type, success: true, data: { watchId } };
      }
      case 'api:documents:watch:stop': {
        const watchId = String(body.watchId ?? '');
        watches.get(watchId)?.close();
        watches.delete(watchId);
        return { id, type, success: true, data: { stopped: true } };
      }
      default:
        return null;
    }
  } catch (error) {
    return {
      id,
      type,
      success: false,
      error: error instanceof Error ? error.message : String(error),
      ...bridgeErrorDetails(error),
    };
  }
};
