import { randomUUID } from "node:crypto";
import type { AuthPrompt } from "@earendil-works/pi-ai";
import type {
  HostEvent,
  HostEventData,
  ProviderAuthResponse,
} from "@piarium/protocol";
import { createDeferred, type Deferred } from "./deferred.js";
import { HostError } from "./errors.js";
import { projectProviderAuthPrompt } from "./protocol-projector.js";

type EventEmitter = <E extends HostEvent>(event: E, data: HostEventData<E>) => void;

interface PendingPrompt {
  abortHandler?: () => void;
  deferred: Deferred<string>;
  providerId: string;
  sessionId: string;
  signal?: AbortSignal;
}

const cancelledError = () => new HostError("auth_cancelled", "Authentication was cancelled");

export class ProviderAuthBridge {
  readonly #emit: EventEmitter;
  readonly #pending = new Map<string, PendingPrompt>();

  constructor(emit: EventEmitter) {
    this.#emit = emit;
  }

  async prompt(
    providerId: string,
    sessionId: string,
    prompt: AuthPrompt,
  ): Promise<string> {
    if (prompt.signal?.aborted) throw cancelledError();
    const requestId = randomUUID();
    const pending: PendingPrompt = {
      deferred: createDeferred<string>(),
      providerId,
      sessionId,
      ...(prompt.signal === undefined ? {} : { signal: prompt.signal }),
    };
    pending.abortHandler = () => {
      this.#clear(requestId, pending);
      this.#emit("provider.auth.dismiss", { providerId, requestId, sessionId });
      pending.deferred.reject(cancelledError());
    };
    if (pending.signal) {
      pending.signal.addEventListener("abort", pending.abortHandler, { once: true });
    }
    this.#pending.set(requestId, pending);
    this.#emit("provider.auth.prompt", {
      prompt: projectProviderAuthPrompt(requestId, prompt),
      providerId,
      sessionId,
    });
    try {
      return await pending.deferred.promise;
    } finally {
      this.#clear(requestId, pending);
    }
  }

  respond(response: ProviderAuthResponse): boolean {
    const pending = this.#pending.get(response.requestId);
    if (!pending) return false;
    this.#clear(response.requestId, pending);
    if (response.cancelled || typeof response.value !== "string") {
      pending.deferred.reject(cancelledError());
    } else {
      pending.deferred.resolve(response.value);
    }
    return true;
  }

  cancelAll(): void {
    for (const [requestId, pending] of [...this.#pending]) {
      this.#clear(requestId, pending);
      this.#emit("provider.auth.dismiss", {
        providerId: pending.providerId,
        requestId,
        sessionId: pending.sessionId,
      });
      pending.deferred.reject(cancelledError());
    }
  }

  #clear(requestId: string, pending: PendingPrompt): void {
    if (pending.abortHandler && pending.signal) {
      pending.signal.removeEventListener("abort", pending.abortHandler);
    }
    this.#pending.delete(requestId);
  }
}
