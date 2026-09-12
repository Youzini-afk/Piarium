import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import type { Writable } from "node:stream";
import {
  KERNEL_PROTOCOL_VERSION,
  type KernelBranchReadResult,
  type KernelBlobResult,
  type KernelError,
  type KernelHandshakeResult,
  type KernelHealthResult,
  type KernelMethod,
  type KernelObjectSlice,
  type KernelRequest,
  type KernelResponse,
  type KernelWriteResult,
} from "./protocol.generated.js";

export interface KernelClientOptions {
  hostId: string;
  storageRoot: string;
  buildVersion: string;
  kernelPath?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Used by focused tests; production always uses a real child process. */
  spawnProcess?: typeof spawn;
  allowCargoDevRunner?: boolean;
  onExit?: (error: Error) => void;
}

export class KernelClientError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(error: KernelError | { code: string; message: string; retryable?: boolean }) {
    super(error.message);
    this.name = "KernelClientError";
    this.code = error.code;
    this.retryable = error.retryable ?? false;
  }
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

const frame = (payload: string): Buffer => {
  const body = Buffer.from(payload, "utf8");
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(body.byteLength, 0);
  return Buffer.concat([header, body]);
};

const asRecord = (value: unknown): Record<string, unknown> => (
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
);

const defaultKernelCandidates = (): string[] => {
  const extension = process.platform === "win32" ? ".exe" : "";
  return [
    process.env.PIARIUM_KERNEL_PATH?.trim() || "",
    path.resolve(process.cwd(), "kernel", `piarium-kernel${extension}`),
    path.resolve(process.cwd(), "kernel", "target", "release", `piarium-kernel${extension}`),
    path.resolve(process.cwd(), "kernel", "target", "debug", `piarium-kernel${extension}`),
  ].filter(Boolean);
};

const resolveKernelCommand = (options: KernelClientOptions): { command: string; args: string[] } => {
  const explicit = options.kernelPath?.trim() || defaultKernelCandidates().find((candidate) => fs.existsSync(candidate));
  if (explicit) return { command: explicit, args: [] };
  const manifest = path.resolve(process.cwd(), "kernel", "Cargo.toml");
  const allowCargo = options.allowCargoDevRunner ?? process.env.NODE_ENV !== "production";
  if (allowCargo && fs.existsSync(manifest)) {
    return { command: process.platform === "win32" ? "cargo.exe" : "cargo", args: ["run", "--quiet", "--manifest-path", manifest, "--bin", "piarium-kernel"] };
  }
  throw new KernelClientError({
    code: "kernel-entry-unavailable",
    message: "Piarium Rust kernel executable is unavailable; build the kernel or set PIARIUM_KERNEL_PATH",
    retryable: false,
  });
};

export class KernelClient {
  private readonly options: KernelClientOptions;
  private readonly spawnProcess: typeof spawn;
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = Buffer.alloc(0);
  private readonly pending = new Map<string, PendingRequest>();
  private started = false;
  private closed = false;
  private epoch: string | null = null;
  private handshakeResult: KernelHandshakeResult | null = null;
  private startPromise: Promise<KernelHandshakeResult> | null = null;

  constructor(options: KernelClientOptions) {
    this.options = options;
    this.spawnProcess = options.spawnProcess ?? spawn;
  }

  get isReady(): boolean { return this.started && !this.closed; }
  get kernelEpoch(): string | null { return this.epoch; }
  get handshake(): KernelHandshakeResult | null { return this.handshakeResult; }

  async start(): Promise<KernelHandshakeResult> {
    if (this.handshakeResult) return this.handshakeResult;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.startInternal();
    try { return await this.startPromise; } finally { this.startPromise = null; }
  }

  private async startInternal(): Promise<KernelHandshakeResult> {
    if (this.closed) throw new KernelClientError({ code: "kernel-client-closed", message: "Kernel client is closed" });
    const command = resolveKernelCommand(this.options);
    const child = this.spawnProcess(command.command, [...command.args, "--stdio"], {
      cwd: this.options.cwd ?? process.cwd(),
      env: { ...process.env, ...this.options.env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;
    child.stdout.on("data", (chunk: Buffer | string) => this.consume(chunk));
    child.stderr.on("data", (chunk: Buffer | string) => {
      // stderr is intentionally separate from the protocol. Keep it out of
      // request responses; the Host can attach a logger at the process layer.
      if (process.env.PIARIUM_KERNEL_DEBUG === "1") process.stderr.write(chunk);
    });
    child.once("error", (error) => this.failAll(new KernelClientError({ code: "kernel-spawn-failed", message: error.message, retryable: true })));
    child.once("exit", (code, signal) => {
      const error = new KernelClientError({
        code: "kernel-exited",
        message: `Rust kernel exited (${signal ?? code ?? "unknown"})`,
        retryable: true,
      });
      this.failAll(error);
      if (!this.closed) this.options.onExit?.(error);
    });
    const result = await this.requestRaw<KernelHandshakeResult>("kernel.handshake", {
      protocolVersion: KERNEL_PROTOCOL_VERSION,
      buildVersion: this.options.buildVersion,
      hostId: this.options.hostId,
      storageRoot: this.options.storageRoot,
      capabilities: ["storage", "workingState", "recovery", "branchCas", "pins", "gc"],
    });
    if (result.protocolVersion !== KERNEL_PROTOCOL_VERSION || !result.kernelEpoch) {
      await this.close().catch(() => undefined);
      throw new KernelClientError({ code: "kernel-protocol-mismatch", message: "Rust kernel handshake returned an incompatible protocol", retryable: false });
    }
    this.epoch = result.kernelEpoch;
    this.handshakeResult = result;
    this.started = true;
    return result;
  }

  private consume(chunk: Buffer | string): void {
    this.buffer = Buffer.concat([this.buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    while (this.buffer.byteLength >= 4) {
      const length = this.buffer.readUInt32BE(0);
      if (this.buffer.byteLength < length + 4) return;
      const body = this.buffer.subarray(4, length + 4);
      this.buffer = this.buffer.subarray(length + 4);
      let response: KernelResponse;
      try { response = JSON.parse(body.toString("utf8")) as KernelResponse; }
      catch (error) { this.failAll(new KernelClientError({ code: "kernel-protocol-error", message: `Invalid Rust kernel response: ${String(error)}`, retryable: false })); return; }
      const pending = this.pending.get(response.id);
      if (!pending) continue;
      this.pending.delete(response.id);
      if (response.ok) pending.resolve(response.result);
      else pending.reject(new KernelClientError(response.error ?? { code: "kernel-error", message: "Rust kernel request failed" }));
    }
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.started = false;
  }

  private async write(request: KernelRequest): Promise<void> {
    const stdin = this.child?.stdin;
    if (!stdin || stdin.destroyed) throw new KernelClientError({ code: "kernel-disconnected", message: "Rust kernel stdin is unavailable", retryable: true });
    const writable = stdin as Writable;
    if (!writable.write(frame(JSON.stringify(request)))) await once(writable, "drain");
  }

  private async requestRaw<T>(method: KernelMethod, params: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const id = randomUUID();
    const request: KernelRequest = { v: KERNEL_PROTOCOL_VERSION, kind: "request", id, method, params, ...(this.epoch ? { epoch: this.epoch } : {}) };
    const promise = new Promise<T>((resolve, reject) => this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject }));
    const abort = () => {
      this.pending.delete(id);
      void this.write({ v: KERNEL_PROTOCOL_VERSION, kind: "cancel", id, ...(this.epoch ? { epoch: this.epoch } : {}) }).catch(() => undefined);
    };
    if (signal?.aborted) { abort(); throw new KernelClientError({ code: "cancelled", message: "Kernel request cancelled", retryable: true }); }
    signal?.addEventListener("abort", abort, { once: true });
    try {
      await this.write(request);
      return await promise;
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }

  async request<T>(method: KernelMethod, params: Record<string, unknown> = {}, options: { signal?: AbortSignal | undefined } = {}): Promise<T> {
    if (!this.handshakeResult && method !== "kernel.handshake") await this.start();
    return this.requestRaw<T>(method, params, options.signal);
  }

  async health(): Promise<KernelHealthResult> { return this.request<KernelHealthResult>("storage.health"); }

  async putBlob(bytes: Uint8Array, operationId: string, signal?: AbortSignal): Promise<KernelBlobResult> {
    const bytesBase64 = Buffer.from(bytes).toString("base64");
    return this.request<KernelBlobResult>("storage.putBlob", { operationId, bytesBase64 }, { signal });
  }

  async getBlob(hash: string, options: { offset?: number; length?: number; signal?: AbortSignal } = {}): Promise<KernelObjectSlice> {
    return this.request<KernelObjectSlice>("storage.getBlob", { hash, ...(options.offset === undefined ? {} : { offset: options.offset }), ...(options.length === undefined ? {} : { length: options.length }) }, { signal: options.signal });
  }

  async createBranch(params: { operationId: string; branchId: string; workspaceId: string; entries: unknown[]; baseRef?: string }, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>("branch.create", params, { signal });
  }

  async readBranch(params: { branchId: string; revision?: number; paths?: string[]; includeEntries?: boolean }, signal?: AbortSignal): Promise<KernelBranchReadResult> {
    return this.request<KernelBranchReadResult>("branch.read", params, { signal });
  }

  async writeBranch(params: { operationId: string; branchId: string; expectedWriteRevision: number; changes: unknown[] }, signal?: AbortSignal): Promise<KernelWriteResult> {
    return this.request<KernelWriteResult>("branch.write", params, { signal });
  }

  async publishBranch(params: { operationId: string; branchId: string }, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>("branch.publish", params, { signal });
  }

  async pinBranch(params: { operationId: string; branchId: string; revision?: number; pinId?: string }, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>("branch.pin", params, { signal });
  }

  async unpinBranch(params: { operationId: string; branchId: string; pinId: string }, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>("branch.unpin", params, { signal });
  }

  async diffRoots(params: { leftRoot: string; rightRoot: string }, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>("branch.diff", params, { signal });
  }

  async gc(operationId: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>("storage.gc", { operationId }, { signal });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.handshakeResult && this.child && !this.child.killed) {
      await this.requestRaw("kernel.shutdown", {}).catch(() => undefined);
    }
    const child = this.child;
    this.child = null;
    if (!child) return;
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (!child.killed) child.stdin.end();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { child.kill(); resolve(); }, 5_000);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
    });
  }
}

export const createKernelClient = (options: KernelClientOptions): KernelClient => new KernelClient(options);
