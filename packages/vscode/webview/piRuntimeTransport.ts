import type {
  RuntimeTransport,
  RuntimeTransportHandlers,
} from '@piarium/runtime-client';
import { getVSCodeAPI } from './api/bridge';

interface RuntimeFrameMessage {
  frame: string;
  type: 'piarium:runtime:frame';
}

interface RuntimeClosedMessage {
  error?: string;
  type: 'piarium:runtime:closed';
}

const isFrameMessage = (value: unknown): value is RuntimeFrameMessage => (
  typeof value === 'object'
  && value !== null
  && (value as { type?: unknown }).type === 'piarium:runtime:frame'
  && typeof (value as { frame?: unknown }).frame === 'string'
);

const isClosedMessage = (value: unknown): value is RuntimeClosedMessage => (
  typeof value === 'object'
  && value !== null
  && (value as { type?: unknown }).type === 'piarium:runtime:closed'
  && (
    (value as { error?: unknown }).error === undefined
    || typeof (value as { error?: unknown }).error === 'string'
  )
);

/** Runtime protocol transport over VS Code's isolated extension↔webview channel. */
export class VSCodeRuntimeTransport implements RuntimeTransport {
  #closed = false;
  #handlers: RuntimeTransportHandlers | null = null;
  #started = false;

  readonly #onMessage = (event: MessageEvent): void => {
    if (this.#closed) return;
    if (isFrameMessage(event.data)) {
      this.#handlers?.message(event.data.frame);
      return;
    }
    if (isClosedMessage(event.data)) {
      this.#closed = true;
      window.removeEventListener('message', this.#onMessage);
      this.#handlers?.close(event.data.error ? new Error(event.data.error) : undefined);
      this.#handlers = null;
    }
  };

  start(handlers: RuntimeTransportHandlers): void {
    if (this.#started) throw new Error('VS Code runtime transport already started');
    if (this.#closed) throw new Error('VS Code runtime transport is closed');
    this.#started = true;
    this.#handlers = handlers;
    window.addEventListener('message', this.#onMessage);
  }

  send(frame: string): void {
    if (!this.#started || this.#closed) throw new Error('VS Code runtime transport is not open');
    getVSCodeAPI().postMessage({ frame, type: 'piarium:runtime:frame' });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    window.removeEventListener('message', this.#onMessage);
    this.#handlers = null;
    getVSCodeAPI().postMessage({ type: 'piarium:runtime:close' });
  }
}
