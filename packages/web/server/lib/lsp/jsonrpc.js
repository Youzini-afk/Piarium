import { attachContentLengthReader, writeContentLengthMessage } from '../run/content-length.js';

export const createJsonRpcClient = ({ input, output }) => {
  let nextId = 1;
  const pending = new Map();
  const notificationListeners = new Set();

  const detach = attachContentLengthReader(input, (message) => {
    if (message && typeof message === 'object' && message.id !== undefined && pending.has(message.id)) {
      const waiter = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message || 'Language server request failed'));
      else waiter.resolve(message.result);
      return;
    }
    if (message && typeof message === 'object' && typeof message.method === 'string' && message.id === undefined) {
      for (const listener of notificationListeners) listener(message.method, message.params);
    }
  });

  const rejectAllPending = (error) => {
    const failure = error ?? new Error('Language server connection closed');
    for (const waiter of pending.values()) waiter.reject(failure);
    pending.clear();
  };

  return {
    request(method, params) {
      const id = nextId;
      nextId += 1;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        writeContentLengthMessage(output, { jsonrpc: '2.0', id, method, params });
      });
    },
    notify(method, params) {
      writeContentLengthMessage(output, { jsonrpc: '2.0', method, params });
    },
    onNotification(listener) {
      notificationListeners.add(listener);
      return () => notificationListeners.delete(listener);
    },
    rejectAll(error) {
      rejectAllPending(error);
    },
    dispose() {
      detach();
      notificationListeners.clear();
      rejectAllPending();
    },
  };
};

export const createJsonRpcServer = ({ input, output, onRequest, onNotification }) => {
  attachContentLengthReader(input, async (message) => {
    if (!message || typeof message !== 'object') return;
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
    notify(method, params) {
      writeContentLengthMessage(output, { jsonrpc: '2.0', method, params });
    },
  };
};
