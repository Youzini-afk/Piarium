declare module 'ws' {
  import type { IncomingMessage } from 'node:http';
  import type { Duplex } from 'node:stream';

  export type RawData = Buffer | Buffer[] | ArrayBuffer | ArrayBufferView;

  export interface WebSocketServerOptions {
    noServer?: boolean | undefined;
    server?: unknown;
    path?: string | undefined;
    maxPayload?: number | undefined;
    clientTracking?: boolean | undefined;
  }

  export class WebSocket {
    readonly readyState: number;
    readonly bufferedAmount: number;

    send(
      data: RawData | string,
      options?: { compress?: boolean; binary?: boolean; fin?: boolean; mask?: boolean } | undefined,
    ): void;
    send(data: RawData | string, cb: ((error?: Error) => void) | undefined): void;
    send(
      data: RawData | string,
      options: { compress?: boolean; binary?: boolean; fin?: boolean; mask?: boolean },
      cb: ((error?: Error) => void) | undefined,
    ): void;

    close(code?: number, reason?: string | Buffer): void;
    terminate(): void;
    ping(
      data?: RawData | string,
      mask?: boolean,
      cb?: ((error?: Error) => void) | undefined,
    ): void;
    pong(
      data?: RawData | string,
      mask?: boolean,
      cb?: ((error?: Error) => void) | undefined,
    ): void;

    on(event: 'open', listener: () => void): this;
    on(event: 'close', listener: (code: number, reason: Buffer) => void): this;
    on(event: 'error', listener: (error: Error) => void): this;
    on(event: 'message', listener: (data: RawData, isBinary: boolean) => void): this;
    on(event: 'ping', listener: (data: Buffer) => void): this;
    on(event: 'pong', listener: (data: Buffer) => void): this;
    on(event: string | symbol, listener: (...args: unknown[]) => void): this;
  }

  export class WebSocketServer {
    clients: Set<WebSocket>;

    constructor(options?: WebSocketServerOptions | undefined);

    on(event: 'connection', listener: (socket: WebSocket, req: IncomingMessage) => void): this;
    on(event: 'error', listener: (error: Error) => void): this;
    on(event: 'close', listener: () => void): this;
    on(event: string | symbol, listener: (...args: unknown[]) => void): this;

    emit(event: 'connection', socket: WebSocket, req: IncomingMessage): boolean;
    emit(event: string | symbol, ...args: unknown[]): boolean;

    handleUpgrade(
      req: IncomingMessage,
      socket: Duplex,
      head: Buffer,
      cb: (ws: WebSocket) => void,
    ): void;

    close(cb?: ((error?: Error) => void) | undefined): void;
  }
}
