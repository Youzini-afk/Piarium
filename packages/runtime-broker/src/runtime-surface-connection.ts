import {
  createRuntimeErrorResponse,
  createRuntimeEvent,
  createRuntimeSuccessResponse,
  decodeRuntimeEnvelope,
  encodeRuntimeEnvelope,
  ProtocolDecodeError,
  type JsonValue,
  type RuntimeWireEnvelope,
} from "@piarium/protocol";
import { PiHostRequestError } from "./host-client.js";
import { PiRuntimeBrokerError } from "./errors.js";
import { RuntimeDispatchError, dispatchRuntimeRequest } from "./runtime-dispatcher.js";
import type { PiRuntimeBroker } from "./runtime-broker.js";

export interface RuntimeSurfaceConnectionOptions {
  broker: PiRuntimeBroker;
  /** Deployment-owned concurrency budget. Zero or omitted means unrestricted. */
  maxPendingRequests?: number;
  onClose?(reason: string): void;
  send(frame: string): boolean | void | Promise<boolean | void>;
}

type HandshakeState = "complete" | "pending" | "required";

const readFrameId = (frame: string): string | null => {
  try {
    const value = JSON.parse(frame) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const id = (value as Record<string, unknown>).id;
    return typeof id === "string" && id.length > 0 ? id : null;
  } catch {
    return null;
  }
};

const errorEnvelope = (id: string, error: unknown): RuntimeWireEnvelope => {
  if (
    error instanceof RuntimeDispatchError
    || error instanceof PiRuntimeBrokerError
    || error instanceof PiHostRequestError
  ) {
    const details = "details" in error ? error.details : undefined;
    return createRuntimeErrorResponse(id, {
      code: error.code,
      ...(details === undefined ? {} : { details: details as JsonValue }),
      message: error.message,
      retryable: "retryable" in error && error.retryable === true,
    });
  }
  if (error instanceof ProtocolDecodeError) {
    return createRuntimeErrorResponse(id, {
      code: error.code,
      message: error.message,
      retryable: false,
    });
  }
  return createRuntimeErrorResponse(id, {
    code: "runtime_request_failed",
    message: "Pi runtime request failed",
    retryable: false,
  });
};

/**
 * One authenticated surface's transport-neutral Runtime protocol state.
 *
 * Network authentication, Origin policy, heartbeats, and transport framing stay
 * with the owning surface. This class owns the shared handshake gate, strict
 * envelope decoding, request validation/dispatch, request-id lifetime, and
 * routed host-event projection used by WebSocket and editor postMessage links.
 */
export class PiRuntimeSurfaceConnection {
  readonly #broker: PiRuntimeBroker;
  readonly #maxPendingRequests: number;
  readonly #onClose: ((reason: string) => void) | undefined;
  readonly #pending = new Set<string>();
  readonly #sendFrame: RuntimeSurfaceConnectionOptions["send"];
  readonly #unsubscribe: () => void;
  #closed = false;
  #handshake: HandshakeState = "required";
  #outbound: Promise<void> = Promise.resolve();

  constructor(options: RuntimeSurfaceConnectionOptions) {
    if (!Number.isSafeInteger(options.maxPendingRequests ?? 0) || (options.maxPendingRequests ?? 0) < 0) {
      throw new RangeError("maxPendingRequests must be a non-negative integer");
    }
    this.#broker = options.broker;
    this.#maxPendingRequests = options.maxPendingRequests ?? 0;
    this.#onClose = options.onClose;
    this.#sendFrame = options.send;
    this.#unsubscribe = options.broker.subscribe((event) => {
      if (this.#closed || this.#handshake !== "complete" || event.kind !== "host") return;
      this.#send(createRuntimeEvent(
        {
          role: event.role,
          workerId: event.workerId,
          ...(event.sessionId === undefined ? {} : { sessionId: event.sessionId }),
        },
        event.envelope.seq,
        event.envelope.event,
        event.envelope.data,
      ));
    });
  }

  get closed(): boolean {
    return this.#closed;
  }

  get handshakeComplete(): boolean {
    return this.#handshake === "complete";
  }

  receive(frame: string): void {
    if (this.#closed) return;
    let envelope: ReturnType<typeof decodeRuntimeEnvelope>;
    try {
      envelope = decodeRuntimeEnvelope(frame);
    } catch (error) {
      const id = readFrameId(frame);
      if (id) this.#send(errorEnvelope(id, error));
      else this.#close("invalid runtime frame");
      return;
    }
    if (envelope.kind !== "request") {
      this.#close("runtime clients may only send requests");
      return;
    }

    if (envelope.method === "host.handshake") {
      if (this.#handshake !== "required") {
        this.#send(createRuntimeErrorResponse(envelope.id, {
          code: "handshake_already_started",
          message: "Runtime handshake has already started",
          retryable: false,
        }));
        return;
      }
      this.#handshake = "pending";
    } else if (this.#handshake !== "complete") {
      this.#send(createRuntimeErrorResponse(envelope.id, {
        code: "handshake_required",
        message: "Runtime handshake is required before other requests",
        retryable: true,
      }));
      return;
    }

    if (this.#pending.has(envelope.id)) {
      this.#send(createRuntimeErrorResponse(envelope.id, {
        code: "duplicate_request_id",
        message: "Runtime request ID is already active",
        retryable: false,
      }));
      return;
    }
    if (this.#maxPendingRequests > 0 && this.#pending.size >= this.#maxPendingRequests) {
      this.#send(createRuntimeErrorResponse(envelope.id, {
        code: "too_many_requests",
        message: "Too many runtime requests are active",
        retryable: true,
      }));
      return;
    }

    this.#pending.add(envelope.id);
    void dispatchRuntimeRequest(this.#broker, envelope.method, envelope.params).then(
      (result) => {
        if (envelope.method === "host.handshake") this.#handshake = "complete";
        this.#send(createRuntimeSuccessResponse(envelope.id, result));
      },
      (error: unknown) => {
        if (envelope.method === "host.handshake") this.#handshake = "required";
        this.#send(errorEnvelope(envelope.id, error));
      },
    ).finally(() => {
      this.#pending.delete(envelope.id);
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#pending.clear();
    this.#unsubscribe();
  }

  #close(reason: string): void {
    if (this.#closed) return;
    this.close();
    try {
      this.#onClose?.(reason);
    } catch {
      // Transport shutdown is observational and must not destabilize the broker.
    }
  }

  #send(envelope: RuntimeWireEnvelope): void {
    if (this.#closed) return;
    let frame: string;
    try {
      frame = encodeRuntimeEnvelope(envelope);
    } catch {
      this.#close("runtime encoding failed");
      return;
    }
    this.#outbound = this.#outbound.then(async () => {
      if (this.#closed) return;
      const accepted = await this.#sendFrame(frame);
      if (accepted === false) this.#close("runtime transport closed");
    }).catch(() => {
      this.#close("runtime transport failed");
    });
  }
}
