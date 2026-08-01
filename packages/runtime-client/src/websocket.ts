import type { RuntimeTransport, RuntimeTransportHandlers } from "./transport.js";

const WS_CONNECTING = 0;
const WS_OPEN = 1;

export interface RuntimeSocketMessageEvent {
  data: unknown;
}

export interface RuntimeSocketCloseEvent {
  code: number;
  reason: string;
}

/** Minimal socket contract shared by native WebSocket and Piarium relay sockets. */
export interface RuntimeWebSocket {
  readonly readyState: number;
  close(code?: number, reason?: string): void;
  onclose: ((event: RuntimeSocketCloseEvent) => void) | null;
  onerror: (() => void) | null;
  onmessage: ((event: RuntimeSocketMessageEvent) => void) | null;
  onopen: (() => void) | null;
  send(frame: string): void;
}

export interface WebSocketRuntimeTransportOptions {
  protocols?: string[];
  url: string;
  webSocketFactory?: (url: string, protocols?: string[]) => RuntimeWebSocket;
}

function messageToText(data: unknown): Promise<string> {
  if (typeof data === "string") return Promise.resolve(data);
  if (data instanceof ArrayBuffer) return Promise.resolve(new TextDecoder().decode(data));
  if (ArrayBuffer.isView(data)) {
    return Promise.resolve(
      new TextDecoder().decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)),
    );
  }
  if (typeof Blob !== "undefined" && data instanceof Blob) return data.text();
  return Promise.reject(new Error("Pi runtime WebSocket received an unsupported frame"));
}

export class WebSocketRuntimeTransport implements RuntimeTransport {
  readonly #options: WebSocketRuntimeTransportOptions;
  #messageChain: Promise<void> = Promise.resolve();
  #socket: RuntimeWebSocket | undefined;
  #started = false;

  constructor(options: WebSocketRuntimeTransportOptions) {
    this.#options = options;
  }

  start(handlers: RuntimeTransportHandlers): Promise<void> {
    if (this.#started) return Promise.reject(new Error("Runtime WebSocket transport already started"));
    this.#started = true;
    const create: (url: string, protocols?: string[]) => RuntimeWebSocket =
      this.#options.webSocketFactory ??
      ((url: string, protocols?: string[]) =>
        (protocols ? new WebSocket(url, protocols) : new WebSocket(url)) as unknown as RuntimeWebSocket);
    const socket = create(this.#options.url, this.#options.protocols);
    this.#socket = socket;
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      socket.onopen = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      socket.onerror = () => {
        const error = new Error("Pi runtime WebSocket failed");
        if (!settled) {
          settled = true;
          reject(error);
        }
      };
      socket.onclose = (event) => {
        const suffix = event.reason ? `: ${event.reason}` : "";
        const error = event.code === 1000
          ? undefined
          : new Error(`Pi runtime WebSocket closed (${event.code})${suffix}`);
        if (!settled) {
          settled = true;
          reject(error ?? new Error("Pi runtime WebSocket closed during startup"));
        }
        handlers.close(error);
      };
      socket.onmessage = (event) => {
        const data = event.data;
        this.#messageChain = this.#messageChain.then(async () => {
          try {
            handlers.message(await messageToText(data));
          } catch (error) {
            handlers.close(error instanceof Error ? error : new Error(String(error)));
            try {
              socket.close(1003, "unsupported runtime frame");
            } catch {
              // The socket may already be closing after a malformed frame.
            }
          }
        });
      };
    });
  }

  send(frame: string): void {
    if (!this.#socket || this.#socket.readyState !== WS_OPEN) {
      throw new Error("Pi runtime WebSocket is not open");
    }
    this.#socket.send(frame);
  }

  close(): void {
    const socket = this.#socket;
    this.#socket = undefined;
    if (socket && (socket.readyState === WS_OPEN || socket.readyState === WS_CONNECTING)) {
      socket.close(1000, "client closed");
    }
  }
}
