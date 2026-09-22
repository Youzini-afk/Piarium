import { randomUUID } from "node:crypto";
import type { AuthPrompt } from "@earendil-works/pi-ai";
import type {
  HostEvent,
  HostEventData,
  ProviderAuthResponse,
} from "@varin/protocol";
import { createDeferred, type Deferred } from "./deferred.js";
import { HostError } from "./errors.js";
import { projectProviderAuthPrompt } from "./protocol-projector.js";

type EventEmitter = <E extends HostEvent>(event: E, data: HostEventData<E>) => void;

interface PendingPrompt {
  abortHandler: () => void;
  deferred: Deferred<string>;
  interactionId: string;
  providerId: string;
  sessionId: string;
  promptSignal?: AbortSignal;
  operationSignal?: AbortSignal;
}

const cancelledError = () => new HostError("auth_cancelled", "Authentication was cancelled");

export class ProviderAuthBridge {
  readonly #emit: EventEmitter;
  readonly #pending = new Map<string, PendingPrompt>();

  constructor(emit: EventEmitter) {
    this.#emit = emit;
  }

  async prompt(
    interactionId: string,
    providerId: string,
    sessionId: string,
    prompt: AuthPrompt,
    operationSignal?: AbortSignal,
  ): Promise<string> {
    if (prompt.signal?.aborted || operationSignal?.aborted) throw cancelledError();
    const requestId = randomUUID();
    const pending: PendingPrompt = {
      deferred: createDeferred<string>(),
      interactionId,
      providerId,
      sessionId,
      ...(prompt.signal === undefined ? {} : { promptSignal: prompt.signal }),
      ...(operationSignal === undefined ? {} : { operationSignal }),
      abortHandler: () => {
        this.#clear(requestId, pending);
        this.#emit("provider.auth.dismiss", {
          interactionId,
          providerId,
          requestId,
          sessionId,
        });
        pending.deferred.reject(cancelledError());
      },
    };
    pending.promptSignal?.addEventListener("abort", pending.abortHandler, { once: true });
    if (pending.operationSignal && pending.operationSignal !== pending.promptSignal) {
      pending.operationSignal.addEventListener("abort", pending.abortHandler, { once: true });
    }
    this.#pending.set(requestId, pending);
    this.#emit("provider.auth.prompt", {
      interactionId,
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

  cancelInteraction(interactionId: string): boolean {
    let cancelled = false;
    for (const pending of this.#pending.values()) {
      if (pending.interactionId !== interactionId) continue;
      cancelled = true;
      pending.abortHandler();
    }
    return cancelled;
  }

  cancelAll(): void {
    for (const [requestId, pending] of [...this.#pending]) {
      this.#clear(requestId, pending);
      this.#emit("provider.auth.dismiss", {
        interactionId: pending.interactionId,
        providerId: pending.providerId,
        requestId,
        sessionId: pending.sessionId,
      });
      pending.deferred.reject(cancelledError());
    }
  }

  #clear(requestId: string, pending: PendingPrompt): void {
    pending.promptSignal?.removeEventListener("abort", pending.abortHandler);
    if (pending.operationSignal && pending.operationSignal !== pending.promptSignal) {
      pending.operationSignal.removeEventListener("abort", pending.abortHandler);
    }
    this.#pending.delete(requestId);
  }
}
