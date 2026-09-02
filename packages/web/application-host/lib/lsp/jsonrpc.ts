import { attachContentLengthReader, writeContentLengthMessage } from '../run/content-length.js';
import type { ContentLengthInput, ContentLengthOutput } from '../run/content-length.js';

type JsonRpcRecord = Record<string, unknown>;
interface Waiter { reject(error: unknown): void; resolve(value: unknown): void }
const asRecord = (value: unknown): JsonRpcRecord | null => (
  value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRpcRecord : null
);

export const createJsonRpcClient = ({
  input,
  output,
}: { input: ContentLengthInput; output: ContentLengthOutput }) => {
  let nextId = 1;
  const pending = new Map<number | string, Waiter>();
  const notificationListeners = new Set<(method: string, params: unknown) => void>();

  const detach = attachContentLengthReader(input, (rawMessage) => {
    const message = asRecord(rawMessage);
    if (!message) return;
    if ((typeof message.id === 'number' || typeof message.id === 'string') && pending.has(message.id)) {
      const waiter = pending.get(message.id);
      pending.delete(message.id);
      if (!waiter) return;
      const error = asRecord(message.error);
      if (error) waiter.reject(new Error(typeof error.message === 'string' ? error.message : 'Language server request failed'));
      else waiter.resolve(message.result);
      return;
    }
    if (message && typeof message === 'object' && typeof message.method === 'string' && message.id === undefined) {
      for (const listener of notificationListeners) listener(message.method, message.params);
    }
  });

  const rejectAllPending = (error?: unknown): void => {
    const failure = error ?? new Error('Language server connection closed');
    for (const waiter of pending.values()) waiter.reject(failure);
    pending.clear();
  };

  return {
    request(method: string, params: unknown): Promise<unknown> {
      const id = nextId;
      nextId += 1;
      return new Promise<unknown>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        writeContentLengthMessage(output, { jsonrpc: '2.0', id, method, params });
      });
    },
    notify(method: string, params: unknown): void {
      writeContentLengthMessage(output, { jsonrpc: '2.0', method, params });
    },
    onNotification(listener: (method: string, params: unknown) => void): () => boolean {
      notificationListeners.add(listener);
      return () => notificationListeners.delete(listener);
    },
    rejectAll(error?: unknown): void {
      rejectAllPending(error);
    },
    dispose(): void {
      detach();
      notificationListeners.clear();
      rejectAllPending();
    },
  };
};

export const createJsonRpcServer = ({ input, output, onRequest, onNotification }: {
  input: ContentLengthInput;
  onNotification?: ((method: string, params: unknown) => void) | undefined;
  onRequest(method: string, params: unknown): Promise<unknown> | unknown;
  output: ContentLengthOutput;
}) => {
  attachContentLengthReader(input, async (rawMessage) => {
    const message = asRecord(rawMessage);
    if (!message) return;
    if (typeof message.method === 'string' && message.id !== undefined) {
      try {
        const result = await onRequest(message.method, message.params);
        writeContentLengthMessage(output, { jsonrpc: '2.0', id: message.id, result: result ?? null });
      } catch (error) {
        writeContentLengthMessage(output, {
          jsonrpc: '2.0',
          id: message.id,
          error: {
            code: -32603,
            message: error instanceof Error ? error.message : 'Internal error',
          },
        });
      }
      return;
    }
    if (typeof message.method === 'string') {
      onNotification?.(message.method, message.params);
    }
  });
  return {
    notify(method: string, params: unknown): void {
      writeContentLengthMessage(output, { jsonrpc: '2.0', method, params });
    },
  };
};
