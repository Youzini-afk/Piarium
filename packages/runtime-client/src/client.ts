import {
  createRuntimeRequest,
  decodeRuntimeEnvelope,
  encodeRuntimeEnvelope,
  type HostHandshakeParams,
  type HostHandshakeResult,
  type RuntimeEventEnvelope,
  type RuntimeMethod,
  type RuntimeMethodParams,
  type RuntimeMethodResult,
  type RuntimeResponseEnvelope,
} from "@piarium/protocol";
import type { RuntimeTransport } from "./transport.js";

interface PendingRequest {
  method: RuntimeMethod;
  reject(error: unknown): void;
  resolve(value: unknown): void;
  timer: ReturnType<typeof setTimeout> | undefined;
}

export interface RuntimeSequenceGap {
  expected: number;
  received: number;
  source: RuntimeEventEnvelope["source"];
}

export interface PiRuntimeClientOptions {
  createId?: () => string;
  onProtocolError?(error: Error): void;
  onSequenceGap?(gap: RuntimeSequenceGap): void;
  requestTimeoutMs?: number | null;
  transport: RuntimeTransport;
}

export class PiRuntimeRequestError extends Error {
  readonly code: string;
  readonly details: unknown;
  readonly retryable: boolean;

  constructor(response: Extract<RuntimeResponseEnvelope, { ok: false }>) {
    super(response.error.message);
    this.name = "PiRuntimeRequestError";
    this.code = response.error.code;
    this.details = response.error.details;
    this.retryable = response.error.retryable === true;
  }
}

/** A sent request lost its transport before a response established the outcome. */
export class PiRuntimeAmbiguousRequestError extends Error {
  override readonly cause: Error;
  readonly method: RuntimeMethod;

  constructor(method: RuntimeMethod, cause: Error) {
    super(`Pi runtime connection was lost after ${method} was sent; the result is unknown`);
    this.name = "PiRuntimeAmbiguousRequestError";
    this.cause = cause;
    this.method = method;
  }
}

const asError = (value: unknown): Error =>
  value instanceof Error ? value : new Error(String(value));

let fallbackId = 0;

const createFallbackId = (): string => {
  fallbackId += 1;
  return `runtime-${Date.now().toString(36)}-${fallbackId.toString(36)}`;
};

export class PiRuntimeClient {
  readonly #createId: () => string;
  readonly #listeners = new Set<(event: RuntimeEventEnvelope) => void>();
  readonly #lastSequences = new Map<string, number>();
  readonly #options: PiRuntimeClientOptions;
  readonly #pending = new Map<string, PendingRequest>();
  #closed = false;
  #connected = false;
  #connectPromise: Promise<void> | undefined;

  constructor(options: PiRuntimeClientOptions) {
    this.#options = options;
    this.#createId = options.createId ?? createFallbackId;
  }

  get connected(): boolean {
    return this.#connected && !this.#closed;
  }

  connect(): Promise<void> {
    if (this.#closed) return Promise.reject(new Error("Pi runtime client is closed"));
    this.#connectPromise ??= Promise.resolve(
      this.#options.transport.start({
        close: (error) => this.#handleClose(error),
        message: (frame) => this.#handleMessage(frame),
      }),
    ).then(() => {
      if (this.#closed) throw new Error("Pi runtime transport closed during startup");
      this.#connected = true;
    });
    return this.#connectPromise;
  }

  handshake(params: HostHandshakeParams): Promise<HostHandshakeResult> {
    return this.request("host.handshake", params);
  }

  async request<M extends RuntimeMethod>(
    method: M,
    params: RuntimeMethodParams<M>,
    timeoutMs: number | null = this.#options.requestTimeoutMs ?? null,
  ): Promise<RuntimeMethodResult<M>> {
    if (!this.connected) throw new Error("Pi runtime client is not connected");
    if (timeoutMs !== null && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
      throw new RangeError("timeoutMs must be positive");
    }
    const id = this.#createId();
    if (!id || this.#pending.has(id)) throw new Error("Runtime request IDs must be unique");
    const envelope = createRuntimeRequest(id, method, params);
    const result = new Promise<RuntimeMethodResult<M>>((resolve, reject) => {
      const timer = timeoutMs === null
        ? undefined
        : setTimeout(() => {
            this.#pending.delete(id);
            reject(new Error(`Pi runtime request timed out: ${method}`));
          }, timeoutMs);
      this.#pending.set(id, {
        method,
        reject,
        resolve: (value) => resolve(value as RuntimeMethodResult<M>),
        timer,
      });
    });
    try {
      await this.#options.transport.send(encodeRuntimeEnvelope(envelope));
    } catch (error) {
      this.#rejectPending(id, error);
    }
    return result;
  }

  subscribe(listener: (event: RuntimeEventEnvelope) => void): () => void {
    if (this.#closed) throw new Error("Pi runtime client is closed");
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#connected = false;
    this.#failPending(new Error("Pi runtime client is closed"));
    this.#listeners.clear();
    this.#lastSequences.clear();
    await this.#options.transport.close();
  }

  #handleMessage(frame: string): void {
    let envelope;
    try {
      envelope = decodeRuntimeEnvelope(frame);
    } catch (error) {
      this.#reportProtocolError(asError(error));
      return;
    }
    if (envelope.kind === "response") {
      const pending = this.#pending.get(envelope.id);
      if (!pending) {
        this.#reportProtocolError(new Error(`Unexpected runtime response: ${envelope.id}`));
        return;
      }
      if (pending.timer !== undefined) clearTimeout(pending.timer);
      this.#pending.delete(envelope.id);
      if (envelope.ok) pending.resolve(envelope.result);
      else pending.reject(new PiRuntimeRequestError(envelope));
      return;
    }
    if (envelope.kind !== "event") {
      this.#reportProtocolError(new Error("Runtime server sent a request to the client"));
      return;
    }
    const previous = this.#lastSequences.get(envelope.source.workerId);
    if (previous !== undefined && envelope.seq !== previous + 1) {
      try {
        this.#options.onSequenceGap?.({
          expected: previous + 1,
          received: envelope.seq,
          source: envelope.source,
        });
      } catch (error) {
        this.#reportProtocolError(asError(error));
      }
    }
    this.#lastSequences.set(envelope.source.workerId, envelope.seq);
    for (const listener of this.#listeners) {
      try {
        listener(envelope);
      } catch (error) {
        this.#reportProtocolError(asError(error));
      }
    }
  }

  #handleClose(error?: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#connected = false;
    this.#failPending(error ?? new Error("Pi runtime transport closed"), true);
    this.#listeners.clear();
  }

  #rejectPending(id: string, error: unknown): void {
    const pending = this.#pending.get(id);
    if (!pending) return;
    if (pending.timer !== undefined) clearTimeout(pending.timer);
    this.#pending.delete(id);
    pending.reject(error);
  }

  #failPending(error: Error, ambiguous = false): void {
    for (const pending of this.#pending.values()) {
      if (pending.timer !== undefined) clearTimeout(pending.timer);
      pending.reject(ambiguous ? new PiRuntimeAmbiguousRequestError(pending.method, error) : error);
    }
    this.#pending.clear();
  }

  #reportProtocolError(error: Error): void {
    try {
      this.#options.onProtocolError?.(error);
    } catch {
      // Diagnostics must not destabilize request/event handling.
    }
  }
}
