import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { isAbsolute, join } from "node:path";
import {
  createRequest,
  decodeEnvelope,
  type EventEnvelope,
  type HostHandshakeParams,
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
  timer: NodeJS.Timeout | undefined;
}

export interface PiHostExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface PiHostClientOptions {
  agentDir?: string;
  cwd?: string;
  environment?: NodeJS.ProcessEnv;
  execArgv?: string[];
  handshake: Omit<HostHandshakeParams, "protocolVersions">;
  hostEntry: string;
  nodePath?: string;
  onDiagnostic?(level: "error" | "info", message: string): void;
  onEvent?(event: EventEnvelope): void;
  onExit?(exit: PiHostExit): void;
  projectTrustOverride?: boolean;
  requestTimeoutMs?: number | null;
  shutdownTimeoutMs?: number;
  startupTimeoutMs?: number;
}

export class PiHostRequestError extends Error {
  readonly code: string;
  readonly details: unknown;

  constructor(response: Extract<ResponseEnvelope, { ok: false }>) {
    super(response.error.message);
    this.name = "PiHostRequestError";
    this.code = response.error.code;
    this.details = response.error.details;
  }
}

const asError = (value: unknown): Error =>
  value instanceof Error ? value : new Error(String(value));

const isChildRunning = (child: ChildProcess): boolean =>
  child.exitCode === null && child.signalCode === null;

export class PiHostClient {
  readonly id = randomUUID();
  readonly #options: PiHostClientOptions;
  readonly #pending = new Map<string, PendingRequest>();
  #child: ChildProcess | undefined;
  #disposePromise: Promise<void> | undefined;
  #disposed = false;
  #disposing = false;
  #exitPromise: Promise<PiHostExit> | undefined;
  #handshake: HostHandshakeResult | undefined;
  #lastSequence = -1;
  #readyReject: ((error: unknown) => void) | undefined;
  #readyResolve: (() => void) | undefined;
  #sessionId: string | undefined;
  #terminalError: Error | undefined;

  constructor(options: PiHostClientOptions) {
    if (!isAbsolute(options.hostEntry)) {
      throw new Error("Pi host entry must be an absolute path");
    }
    const nodePath = options.nodePath ?? process.execPath;
    if (!isAbsolute(nodePath)) {
      throw new Error("Pi host Node executable must be an absolute path");
    }
    this.#options = options;
  }

  get disposing(): boolean {
    return this.#disposing;
  }

  get handshake(): HostHandshakeResult {
    if (!this.#handshake) throw new Error("Pi host has not completed its handshake");
    return this.#handshake;
  }

  get pid(): number | undefined {
    return this.#child?.pid;
  }

  get running(): boolean {
    return this.#child !== undefined && isChildRunning(this.#child);
  }

  get lastSequence(): number {
    return this.#lastSequence;
  }

  get sessionId(): string | undefined {
    return this.#sessionId;
  }

  async start(): Promise<HostHandshakeResult> {
    if (this.#child) throw new Error("Pi host is already started");
    if (this.#disposed) throw new Error("Pi host is disposed");
    if (this.#terminalError) throw this.#terminalError;

    const ready = new Promise<void>((resolveReady, rejectReady) => {
      this.#readyResolve = resolveReady;
      this.#readyReject = rejectReady;
    });
    const args = [
      ...(this.#options.execArgv ?? []),
      this.#options.hostEntry,
      ...(this.#options.agentDir ? ["--agent-dir", this.#options.agentDir] : []),
      ...(this.#options.projectTrustOverride === true ? ["--trust-project"] : []),
      ...(this.#options.projectTrustOverride === false ? ["--deny-project"] : []),
    ];
    const child = spawn(this.#options.nodePath ?? process.execPath, args, {
      ...(this.#options.cwd === undefined ? {} : { cwd: this.#options.cwd }),
      detached: process.platform !== "win32",
      env: {
        ...process.env,
        ...this.#options.environment,
        ELECTRON_RUN_AS_NODE: "1",
        ...(this.#options.agentDir === undefined
          ? {}
          : { PI_CODING_AGENT_DIR: this.#options.agentDir }),
      },
      serialization: "json",
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      windowsHide: true,
    });
    this.#child = child;
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => this.#diagnostic("info", chunk));
    child.stderr?.on("data", (chunk: string) => this.#diagnostic("error", chunk));
    child.on("message", (message) => this.#handleMessage(message));
    child.once("error", (error) => this.#fail(error));
    this.#exitPromise = new Promise((resolveExit) => {
      child.once("close", (code, signal) => {
        const exit = { code, signal };
        if (this.#child === child) this.#child = undefined;
        this.#fail(
          new Error(`Pi host exited (code=${String(code)}, signal=${String(signal)})`),
        );
        try {
          this.#options.onExit?.(exit);
        } catch (error) {
          this.#diagnostic("error", `Pi host exit handler failed: ${asError(error).message}`);
        }
        resolveExit(exit);
      });
    });

    try {
      await this.#withTimeout(
        ready,
        this.#options.startupTimeoutMs ?? 15_000,
        "Pi host did not become ready",
      );
      this.#readyReject = undefined;
      this.#readyResolve = undefined;
      this.#handshake = await this.#sendRequest(
        "host.handshake",
        {
          ...this.#options.handshake,
          protocolVersions: [PIARIUM_PROTOCOL_VERSION],
        },
        this.#options.startupTimeoutMs ?? 15_000,
      );
      return this.#handshake;
    } catch (error) {
      this.#fail(error);
      await this.#forceTerminate(child);
      throw error;
    }
  }

  async request<M extends HostMethod>(
    method: M,
    params: HostMethodParams<M>,
    timeoutMs: number | null = this.#options.requestTimeoutMs ?? null,
  ): Promise<HostMethodResult<M>> {
    if (this.#disposed || this.#disposing) throw new Error("Pi host is shutting down");
    if (this.#terminalError) throw this.#terminalError;
    if (!this.#handshake) throw new Error("Pi host handshake is not complete");
    if (timeoutMs !== null && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
      throw new RangeError("timeoutMs must be positive");
    }
    return this.#sendRequest(method, params, timeoutMs);
  }

  dispose(): Promise<void> {
    this.#disposePromise ??= this.#performDispose();
    return this.#disposePromise;
  }

  async #sendRequest<M extends HostMethod>(
    method: M,
    params: HostMethodParams<M>,
    timeoutMs: number | null,
  ): Promise<HostMethodResult<M>> {
    const child = this.#child;
    if (!child?.connected) throw new Error("Pi host IPC is not connected");
    const id = randomUUID();
    const result = new Promise<HostMethodResult<M>>((resolve, reject) => {
      const timer = timeoutMs === null
        ? undefined
        : setTimeout(() => {
            this.#pending.delete(id);
            reject(new Error(`Pi host request timed out: ${method}`));
          }, timeoutMs);
      this.#pending.set(id, {
        reject,
        resolve: (value) => resolve(value as HostMethodResult<M>),
        timer,
      });
    });
    const rejectSend = (error: unknown) => {
      const pending = this.#pending.get(id);
      if (!pending) return;
      if (pending.timer) clearTimeout(pending.timer);
      this.#pending.delete(id);
      pending.reject(error);
    };
    try {
      child.send(createRequest(id, method, params), (error) => {
        if (error) rejectSend(error);
      });
    } catch (error) {
      rejectSend(error);
    }
    return result;
  }

  async #performDispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposing = true;
    const child = this.#child;
    try {
      if (!child) return;
      const timeoutMs = this.#options.shutdownTimeoutMs ?? 5_000;
      if (child.connected) {
        try {
          await this.#sendRequest("host.shutdown", {}, timeoutMs);
        } catch (error) {
          this.#diagnostic("error", asError(error).message);
        }
      }
      if (this.#exitPromise) {
        try {
          await this.#withTimeout(
            this.#exitPromise,
            timeoutMs,
            "Pi host did not exit after shutdown",
          );
          return;
        } catch (error) {
          this.#diagnostic("error", asError(error).message);
        }
      }
      await this.#forceTerminate(child);
    } finally {
      this.#disposed = true;
      this.#disposing = false;
      this.#fail(new Error("Pi host client is disposed"));
    }
  }

  #handleMessage(message: unknown): void {
    let envelope: WireEnvelope;
    try {
      const frame = JSON.stringify(message);
      if (frame === undefined) throw new Error("Pi host sent a non-JSON IPC message");
      envelope = decodeEnvelope(frame);
    } catch (error) {
      this.#fail(error);
      const child = this.#child;
      if (child) void this.#forceTerminate(child);
      return;
    }
    if (envelope.kind === "response") {
      const pending = this.#pending.get(envelope.id);
      if (!pending) return;
      if (pending.timer) clearTimeout(pending.timer);
      this.#pending.delete(envelope.id);
      if (envelope.ok) pending.resolve(envelope.result);
      else pending.reject(new PiHostRequestError(envelope));
      return;
    }
    if (envelope.kind !== "event") {
      this.#fail(new Error(`Pi host sent an unexpected ${envelope.kind} envelope`));
      const child = this.#child;
      if (child) void this.#forceTerminate(child);
      return;
    }
    if (envelope.seq !== this.#lastSequence + 1) {
      this.#fail(
        new Error(
          `Pi host event sequence gap: expected ${this.#lastSequence + 1}, received ${envelope.seq}`,
        ),
      );
      const child = this.#child;
      if (child) void this.#forceTerminate(child);
      return;
    }
    this.#lastSequence = envelope.seq;
    if (envelope.event === "host.ready") this.#readyResolve?.();
    if (envelope.event === "session.snapshot") this.#sessionId = envelope.data.sessionId;
    if (envelope.event === "session.closed" && envelope.data.sessionId === this.#sessionId) {
      this.#sessionId = undefined;
    }
    try {
      this.#options.onEvent?.(envelope);
    } catch (error) {
      this.#diagnostic("error", `Pi host event handler failed: ${asError(error).message}`);
    }
  }

  #diagnostic(level: "error" | "info", value: string): void {
    const message = String(value).trimEnd();
    if (!message) return;
    try {
      this.#options.onDiagnostic?.(level, message);
    } catch {
      // Diagnostics must never destabilize the worker transport.
    }
  }

  #fail(value: unknown): void {
    const error = asError(value);
    this.#terminalError ??= error;
    this.#readyReject?.(error);
    this.#readyReject = undefined;
    this.#readyResolve = undefined;
    for (const pending of this.#pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  async #forceTerminate(child: ChildProcess): Promise<void> {
    if (!isChildRunning(child)) return;
    const pid = child.pid;
    try {
      if (process.platform === "win32" && pid) {
        const taskkill = join(
          process.env.SystemRoot ?? "C:\\Windows",
          "System32",
          "taskkill.exe",
        );
        const killer = spawn(taskkill, ["/PID", String(pid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true,
        });
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 3_000);
          killer.once("close", () => {
            clearTimeout(timer);
            resolve();
          });
          killer.once("error", () => {
            clearTimeout(timer);
            resolve();
          });
        });
      } else if (pid) {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      } else {
        child.kill("SIGKILL");
      }
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        // The process already exited.
      }
    }
    if (!this.#exitPromise) return;
    try {
      await this.#withTimeout(this.#exitPromise, 3_000, "Pi host force termination timed out");
    } catch (error) {
      this.#diagnostic("error", asError(error).message);
    }
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
