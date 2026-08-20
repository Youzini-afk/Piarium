import fs from 'node:fs';

const HEADER_DELIMITER = Buffer.from('\r\n\r\n');

const extractContentLength = (header) => {
  const match = /Content-Length:\s*(\d+)/i.exec(header.toString('utf8'));
  return match ? Number(match[1]) : null;
};

const writeJsonRpcMessage = (output, message) => {
  const payload = Buffer.from(JSON.stringify(message), 'utf8');
  const frame = Buffer.concat([
    Buffer.from(`Content-Length: ${payload.length}\r\n\r\n`, 'utf8'),
    payload,
  ]);
  if (typeof output.fd === 'number') {
    fs.writeSync(output.fd, frame);
    return;
  }
  output.write(frame);
};

const attachJsonRpcReader = (input, onMessage) => {
  let buffer = Buffer.alloc(0);
  const onData = (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const headerEnd = buffer.indexOf(HEADER_DELIMITER);
      if (headerEnd === -1) break;
      const length = extractContentLength(buffer.subarray(0, headerEnd));
      if (!Number.isFinite(length) || length < 0) {
        buffer = buffer.subarray(headerEnd + HEADER_DELIMITER.length);
        continue;
      }
      const bodyStart = headerEnd + HEADER_DELIMITER.length;
      if (buffer.length < bodyStart + length) break;
      const body = buffer.subarray(bodyStart, bodyStart + length).toString('utf8');
      buffer = buffer.subarray(bodyStart + length);
      try {
        onMessage(JSON.parse(body));
      } catch {
        // Malformed LSP frames are ignored. Bodies are never logged.
      }
    }
  };
  input.on('data', onData);
  return () => input.off('data', onData);
};

export const createJsonRpcClient = ({ input, output }) => {
  let nextId = 1;
  const pending = new Map();
  const notificationListeners = new Set();

  const detach = attachJsonRpcReader(input, (message) => {
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
        writeJsonRpcMessage(output, { jsonrpc: '2.0', id, method, params });
      });
    },
    notify(method, params) {
      writeJsonRpcMessage(output, { jsonrpc: '2.0', method, params });
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
  attachJsonRpcReader(input, async (message) => {
    if (!message || typeof message !== 'object') return;
    if (typeof message.method === 'string' && message.id !== undefined) {
      try {
        const result = await onRequest(message.method, message.params);
        writeJsonRpcMessage(output, { jsonrpc: '2.0', id: message.id, result: result ?? null });
      } catch (error) {
        writeJsonRpcMessage(output, {
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
      writeJsonRpcMessage(output, { jsonrpc: '2.0', method, params });
    },
  };
};
