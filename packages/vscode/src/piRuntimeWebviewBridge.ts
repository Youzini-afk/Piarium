import type * as vscode from 'vscode';
import { PiRuntimeSurfaceConnection } from '@piarium/runtime-broker/core';
import type { VSCodePiRuntime } from './piRuntime';

interface RuntimeFrameMessage {
  frame: string;
  type: 'piarium:runtime:frame';
}

interface RuntimeCloseMessage {
  type: 'piarium:runtime:close';
}

const isRuntimeFrame = (message: unknown): message is RuntimeFrameMessage => (
  typeof message === 'object'
  && message !== null
  && (message as { type?: unknown }).type === 'piarium:runtime:frame'
  && typeof (message as { frame?: unknown }).frame === 'string'
);

const isRuntimeClose = (message: unknown): message is RuntimeCloseMessage => (
  typeof message === 'object'
  && message !== null
  && (message as { type?: unknown }).type === 'piarium:runtime:close'
);

export class PiRuntimeWebviewBridge implements vscode.Disposable {
  readonly #runtime: VSCodePiRuntime;
  readonly #webview: vscode.Webview;
  #connection: PiRuntimeSurfaceConnection | null = null;
  #disposed = false;
  #generation = 0;
  #receiveQueue: Promise<void> = Promise.resolve();

  constructor(webview: vscode.Webview, runtime: VSCodePiRuntime) {
    this.#runtime = runtime;
    this.#webview = webview;
  }

  handleMessage(message: unknown): boolean {
    if (isRuntimeClose(message)) {
      this.#generation += 1;
      this.#receiveQueue = this.#receiveQueue.then(() => {
        this.#closeConnection();
      });
      return true;
    }
    if (!isRuntimeFrame(message)) return false;
    const generation = this.#generation;
    this.#receiveQueue = this.#receiveQueue.then(async () => {
      if (this.#disposed || generation !== this.#generation) return;
      try {
        const connection = await this.#ensureConnection(generation);
        if (this.#disposed || generation !== this.#generation) {
          this.#closeConnection();
          return;
        }
        connection.receive(message.frame);
      } catch (error) {
        if (this.#disposed || generation !== this.#generation) return;
        await this.#postClosed(error instanceof Error ? error.message : String(error));
      }
    });
    return true;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#generation += 1;
    this.#closeConnection();
  }

  async #ensureConnection(generation: number): Promise<PiRuntimeSurfaceConnection> {
    if (this.#connection && !this.#connection.closed) return this.#connection;
    const broker = await this.#runtime.start();
    if (this.#disposed || generation !== this.#generation) {
      throw new Error('VS Code runtime bridge was closed');
    }
    const connection = new PiRuntimeSurfaceConnection({
      broker,
      onClose: (reason) => {
        if (this.#connection === connection) this.#connection = null;
        void this.#postClosed(reason);
      },
      send: async (frame) => this.#webview.postMessage({
        frame,
        type: 'piarium:runtime:frame',
      }),
    });
    this.#connection = connection;
    return connection;
  }

  #closeConnection(): void {
    this.#connection?.close();
    this.#connection = null;
  }

  async #postClosed(error?: string): Promise<void> {
    if (this.#disposed) return;
    try {
      await this.#webview.postMessage({
        ...(error ? { error } : {}),
        type: 'piarium:runtime:closed',
      });
    } catch {
      // The webview may already be gone.
    }
  }
}
