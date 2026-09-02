import { attachContentLengthReader, writeContentLengthMessage } from './content-length.js';
import type { ContentLengthInput, ContentLengthOutput } from './content-length.js';

type MessageRecord = Record<string, unknown>;
interface Waiter { reject(error: unknown): void; resolve(value: unknown): void }

const asRecord = (value: unknown): MessageRecord | null => (
  value && typeof value === 'object' && !Array.isArray(value) ? value as MessageRecord : null
);

const failureMessage = (message: MessageRecord) => (
  typeof message.message === 'string' && message.message
    ? message.message
    : 'Debug adapter request failed'
);

export const createDapClient = ({
  input,
  output,
}: { input: ContentLengthInput; output: ContentLengthOutput }) => {
  let nextSeq = 1;
  const pending = new Map<number, Waiter>();
  const eventListeners = new Set<(event: string, body: unknown) => void>();
  const eventWaiters = new Map<string, Waiter[]>();

  const send = (message: MessageRecord): void => writeContentLengthMessage(output, { seq: nextSeq++, ...message });
  const detach = attachContentLengthReader(input, (rawMessage) => {
    const message = asRecord(rawMessage);
    if (!message) return;
    if (message.type === 'response' && typeof message.request_seq === 'number' && pending.has(message.request_seq)) {
      const waiter = pending.get(message.request_seq);
      pending.delete(message.request_seq);
      if (!waiter) return;
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

  const rejectAll = (error: unknown = new Error('Debug adapter connection closed')): void => {
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
    for (const waiters of eventWaiters.values()) {
      for (const waiter of waiters) waiter.reject(error);
    }
    eventWaiters.clear();
  };

  return {
    request(command: string, args: unknown): Promise<unknown> {
      const seq = nextSeq;
      return new Promise<unknown>((resolve, reject) => {
        pending.set(seq, { reject, resolve });
        send({ type: 'request', command, arguments: args });
      });
    },
    onNotification(listener: (event: string, body: unknown) => void): () => boolean {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
    waitForEvent(event: string): Promise<unknown> {
      return new Promise<unknown>((resolve, reject) => {
        const waiters = eventWaiters.get(event) ?? [];
        waiters.push({ reject, resolve });
        eventWaiters.set(event, waiters);
      });
    },
    rejectAll,
    dispose(): void {
      detach();
      eventListeners.clear();
      rejectAll();
    },
  };
};

export const createDapServer = ({ input, output, onRequest }: {
  input: ContentLengthInput;
  onRequest(command: string, args: unknown): Promise<unknown> | unknown;
  output: ContentLengthOutput;
}) => {
  let nextSeq = 1;
  const send = (message: MessageRecord): void => writeContentLengthMessage(output, { seq: nextSeq++, ...message });
  const server = {
    notify(event: string, body: unknown): void {
      send({ type: 'event', event, body });
    },
  };
  attachContentLengthReader(input, async (rawMessage) => {
    const message = asRecord(rawMessage);
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
