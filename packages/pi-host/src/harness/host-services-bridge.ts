import { randomUUID } from "node:crypto";
import type {
  HarnessError,
  HarnessMethod,
  HarnessRequestData,
  HarnessServiceMap,
  HostEvent,
} from "@piarium/protocol";

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: HarnessRequestError) => void;
  sessionId: string;
  timer: ReturnType<typeof setTimeout> | undefined;
}

export interface HostServicesBridgeOptions {
  emit: (event: "harness.request", data: HarnessRequestData) => void;
  sessionId: string;
  defaultTimeoutMs?: number;
}

export class HarnessRequestError extends Error {
  readonly code: HarnessError["code"];
  readonly retryable: boolean;
  constructor(code: HarnessError["code"], message: string, retryable: boolean = false) {
    super(message);
    this.name = "HarnessRequestError";
    this.code = code;
    this.retryable = retryable;
  }
}

export class HostServicesBridge {
  readonly #emit: HostServicesBridgeOptions["emit"];
  readonly #pending = new Map<string, PendingRequest>();
  readonly #sessionId: string;
  readonly #defaultTimeoutMs: number;
  #disposed = false;

  constructor(options: HostServicesBridgeOptions) {
    this.#emit = options.emit;
    this.#sessionId = options.sessionId;
    this.#defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000;
  }

  request<M extends HarnessMethod>(
    method: M,
    params: HarnessServiceMap[M]["params"],
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<HarnessServiceMap[M]["result"]> {
    if (this.#disposed) {
      return Promise.reject(new HarnessRequestError("failed", "disposed"));
    }
    const requestId = randomUUID();
    const timeoutMs = options?.timeoutMs ?? this.#defaultTimeoutMs;
    let resolveResponse!: (value: unknown) => void;
    let rejectResponse!: (error: HarnessRequestError) => void;
    const response = new Promise<unknown>((resolve, reject) => {
      resolveResponse = resolve;
      rejectResponse = reject;
    });
    const timer = setTimeout(() => {
      const pending = this.#pending.get(requestId);
      if (!pending) return;
      this.#pending.delete(requestId);
      pending.reject(new HarnessRequestError("timeout", `harness request timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    this.#pending.set(requestId, {
      resolve: resolveResponse,
      reject: rejectResponse,
      sessionId: this.#sessionId,
      timer,
    });
    if (options?.signal) {
      if (options.signal.aborted) {
        this.#cancel(requestId, new HarnessRequestError("failed", "aborted"));
      } else {
        options.signal.addEventListener("abort", () => {
          this.#cancel(requestId, new HarnessRequestError("failed", "aborted"));
        }, { once: true });
      }
    }
    try {
      this.#emit("harness.request", {
        method,
        params,
        requestId,
        sessionId: this.#sessionId,
      });
    } catch (error) {
      this.#cancel(requestId, new HarnessRequestError("failed", error instanceof Error ? error.message : "emit failed"));
    }
    return response as Promise<HarnessServiceMap[M]["result"]>;
  }

  respond(
    sessionId: string,
    requestId: string,
    outcome: { ok: true; result: unknown } | { ok: false; error: HarnessError },
  ): boolean {
    const pending = this.#pending.get(requestId);
    if (!pending || pending.sessionId !== sessionId) return false;
    this.#pending.delete(requestId);
    if (pending.timer) clearTimeout(pending.timer);
    if (outcome.ok) {
      pending.resolve(outcome.result);
    } else {
      pending.reject(new HarnessRequestError(
        outcome.error.code,
        outcome.error.message,
        outcome.error.retryable === true,
      ));
    }
    return true;
  }

  #cancel(requestId: string, error: HarnessRequestError): void {
    const pending = this.#pending.get(requestId);
    if (!pending) return;
    this.#pending.delete(requestId);
    if (pending.timer) clearTimeout(pending.timer);
    pending.reject(error);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const pending of this.#pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(new HarnessRequestError("failed", "disposed"));
    }
    this.#pending.clear();
  }
}
