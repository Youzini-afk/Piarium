import { attachContentLengthReader, writeContentLengthMessage } from './content-length.js';

const failureMessage = (message) => (
  typeof message?.message === 'string' && message.message
    ? message.message
    : 'Debug adapter request failed'
);

export const createDapClient = ({ input, output }) => {
  let nextSeq = 1;
  const pending = new Map();
  const eventListeners = new Set();
  const eventWaiters = new Map();

  const send = (message) => writeContentLengthMessage(output, { seq: nextSeq++, ...message });
  const detach = attachContentLengthReader(input, (message) => {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'response' && pending.has(message.request_seq)) {
      const waiter = pending.get(message.request_seq);
      pending.delete(message.request_seq);
      if (message.success === false) waiter.reject(new Error(failureMessage(message)));
      else waiter.resolve(message.body ?? {});
      return;
    }
    if (message.type === 'event' && typeof message.event === 'string') {
      for (const listener of eventListeners) listener(message.event, message.body);
      const waiters = eventWaiters.get(message.event) ?? [];
      eventWaiters.delete(message.event);
      for (const waiter of waiters) waiter.resolve(message.body);
      return;
    }
    if (message.type === 'request' && Number.isFinite(message.seq)) {
      send({
        type: 'response',
        request_seq: message.seq,
        success: false,
        command: typeof message.command === 'string' ? message.command : '',
        message: `Piarium does not implement reverse DAP request: ${String(message.command ?? '')}`,
      });
    }
  });

  const rejectAll = (error = new Error('Debug adapter connection closed')) => {
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
    for (const waiters of eventWaiters.values()) {
      for (const waiter of waiters) waiter.reject(error);
    }
    eventWaiters.clear();
  };

  return {
    request(command, args) {
      const seq = nextSeq;
      return new Promise((resolve, reject) => {
        pending.set(seq, { reject, resolve });
        send({ type: 'request', command, arguments: args });
      });
    },
    onNotification(listener) {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
    waitForEvent(event) {
      return new Promise((resolve, reject) => {
        const waiters = eventWaiters.get(event) ?? [];
        waiters.push({ reject, resolve });
        eventWaiters.set(event, waiters);
      });
    },
    rejectAll,
    dispose() {
      detach();
      eventListeners.clear();
      rejectAll();
    },
  };
};

export const createDapServer = ({ input, output, onRequest }) => {
  let nextSeq = 1;
  const send = (message) => writeContentLengthMessage(output, { seq: nextSeq++, ...message });
  const server = {
    notify(event, body) {
      send({ type: 'event', event, body });
    },
  };
  attachContentLengthReader(input, async (message) => {
    if (!message || message.type !== 'request' || !Number.isFinite(message.seq) || typeof message.command !== 'string') return;
    try {
      const body = await onRequest(message.command, message.arguments);
      send({
        type: 'response',
        request_seq: message.seq,
        success: true,
        command: message.command,
        body: body ?? {},
      });
      if (message.command === 'initialize') server.notify('initialized', {});
    } catch (error) {
      send({
        type: 'response',
        request_seq: message.seq,
        success: false,
        command: message.command,
        message: error instanceof Error ? error.message : 'Debug adapter request failed',
      });
    }
  });
  return server;
};
