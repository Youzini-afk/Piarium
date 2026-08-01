import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  decodeEnvelope,
  type EventEnvelope,
  type HostHandshakeResult,
  type HostMethod,
  type HostMethodParams,
  type HostMethodResult,
  PIARIUM_PROTOCOL_VERSION,
  type ResponseEnvelope,
  type WireEnvelope,
} from "@piarium/protocol";

interface PendingRequest {
  reject(error: unknown): void;
  resolve(value: unknown): void;
  timer: NodeJS.Timeout;
}

export interface HostExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface HostClientOptions {
  agentDir?: string;
  hostEntry: string;
  onDiagnostic?(level: "error" | "info", message: string): void;
  onEvent(event: EventEnvelope): void;
  onExit(exit: HostExit): void;
}

export class HostRequestError extends Error {
  readonly code: string;
  readonly details: unknown;

  constructor(response: Extract<ResponseEnvelope, { ok: false }>) {
    super(response.error.message);
    this.name = "HostRequestError";
    this.code = response.error.code;
    this.details = response.error.details;
  }
}

export class HostClient {
  readonly id = randomUUID();
  readonly #options: HostClientOptions;
  readonly #pending = new Map<string, PendingRequest>();
  #child: ChildProcess | undefined;
  #disposePromise: Promise<void> | undefined;
  #disposed = false;
  #disposing = false;
  #exitPromise: Promise<HostExit> | undefined;
  #handshake: HostHandshakeResult | undefined;
  #lastSequence = -1;
  #readyResolve: (() => void) | undefined;
  #readyReject: ((error: unknown) => void) | undefined;
  #sessionId: string | undefined;

  constructor(options: HostClientOptions) {
    this.#options = options;
  }

  get handshake(): HostHandshakeResult {
    if (!this.#handshake) throw new Error("Pi host has not completed its handshake");
    return this.#handshake;
  }

  get sessionId(): string | undefined {
    return this.#sessionId;
  }

  async start(): Promise<HostHandshakeResult> {
    if (this.#child) throw new Error("Pi host is already started");
    if (this.#disposed) throw new Error("Pi host is disposed");
    const ready = new Promise<void>((resolveReady, rejectReady) => {
      this.#readyResolve = () => resolveReady();
      this.#readyReject = rejectReady;
    });
    const args = [...(this.#options.agentDir ? ["--agent-dir", this.#options.agentDir] : [])];
    const child = spawn(process.execPath, [this.#options.hostEntry, ...args], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      serialization: "json",
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      windowsHide: true,
    });
    this.#child = child;
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) =>
      this.#options.onDiagnostic?.("info", chunk.trimEnd()),
    );
    child.stderr?.on("data", (chunk: string) =>
      this.#options.onDiagnostic?.("error", chunk.trimEnd()),
    );
    child.on("message", (message) => this.#handleMessage(message));
    child.once("error", (error) => this.#fail(error));
    this.#exitPromise = new Promise((resolveExit) => {
      child.once("exit", (code, signal) => {
        const exit = { code, signal };
        this.#child = undefined;
        this.#fail(new Error(`Pi host exited (code=${String(code)}, signal=${String(signal)})`));
        this.#options.onExit(exit);
        resolveExit(exit);
      });
    });
    await this.#withTimeout(ready, 15_000, "Pi host did not become ready");
    this.#handshake = await this.request("host.handshake", {
      clientName: "piarium-desktop",
      clientVersion: "0.1.0",
      mode: "desktop",
      protocolVersions: [PIARIUM_PROTOCOL_VERSION],
    });
    return this.#handshake;
  }

  async request<M extends HostMethod>(
    method: M,
    params: HostMethodParams<M>,
    timeoutMs: number = 120_000,
  ): Promise<HostMethodResult<M>> {
    if (this.#disposed || this.#disposing) throw new Error("Pi host is shutting down");
    return this.#sendRequest(method, params, timeoutMs);
  }

  dispose(): Promise<void> {
    this.#disposePromise ??= this.#performDispose();
    return this.#disposePromise;
  }

  async #sendRequest<M extends HostMethod>(
    method: M,
    params: HostMethodParams<M>,
    timeoutMs: number,
  ): Promise<HostMethodResult<M>> {
    const child = this.#child;
    if (!child?.connected) throw new Error("Pi host IPC is not connected");
    const id = randomUUID();
    const result = new Promise<HostMethodResult<M>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Pi host request timed out: ${method}`));
      }, timeoutMs);
      this.#pending.set(id, {
        reject,
        resolve: (value) => resolve(value as HostMethodResult<M>),
        timer,
      });
    });
    child.send({ id, kind: "request", method, params, v: PIARIUM_PROTOCOL_VERSION }, (error) => {
      if (!error) return;
      const pending = this.#pending.get(id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.#pending.delete(id);
      pending.reject(error);
    });
    return result;
  }

  async #performDispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposing = true;
    const child = this.#child;
    if (!child) {
      this.#disposed = true;
      return;
    }
    if (child.connected) {
      try {
        await this.#withTimeout(
          this.#sendRequest("host.shutdown", {}, 5_000),
          5_000,
          "Pi host did not acknowledge shutdown",
        );
      } catch (error) {
        this.#options.onDiagnostic?.(
          "error",
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    const exit = this.#exitPromise;
    if (exit) {
      try {
        await this.#withTimeout(exit, 5_000, "Pi host did not exit after shutdown");
        this.#disposed = true;
        return;
      } catch {
        // Fall through to the bounded force-termination path.
      }
    }
    child.kill();
    this.#disposed = true;
  }

  #handleMessage(message: unknown): void {
    let envelope: WireEnvelope;
    try {
      const frame = JSON.stringify(message);
      if (frame === undefined) throw new Error("Pi host sent a non-JSON IPC message");
      envelope = decodeEnvelope(frame);
    } catch (error) {
      this.#fail(error);
      this.#child?.kill();
      return;
    }
    if (envelope.kind === "response") {
      const pending = this.#pending.get(envelope.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.#pending.delete(envelope.id);
      if (envelope.ok) pending.resolve(envelope.result);
      else pending.reject(new HostRequestError(envelope));
      return;
    }
    if (envelope.kind !== "event") {
      this.#fail(new Error(`Pi host sent an unexpected ${envelope.kind} envelope`));
      return;
    }
    if (envelope.seq !== this.#lastSequence + 1) {
      this.#fail(
        new Error(
          `Pi host event sequence gap: expected ${this.#lastSequence + 1}, received ${envelope.seq}`,
        ),
      );
      this.#child?.kill();
      return;
    }
    this.#lastSequence = envelope.seq;
    if (envelope.event === "host.ready") this.#readyResolve?.();
    if (envelope.event === "session.snapshot") this.#sessionId = envelope.data.sessionId;
    if (envelope.event === "session.closed" && envelope.data.sessionId === this.#sessionId) {
      this.#sessionId = undefined;
    }
    this.#options.onEvent(envelope);
  }

  #fail(error: unknown): void {
    this.#readyReject?.(error);
    this.#readyReject = undefined;
    this.#readyResolve = undefined;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  async #withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(message)), timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
