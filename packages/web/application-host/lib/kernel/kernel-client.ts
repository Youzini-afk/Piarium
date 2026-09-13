import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import type { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  KERNEL_PROTOCOL_VERSION,
  type KernelBranchReadResult,
  type KernelBranchChange,
  type KernelCreateEntry,
  type KernelError,
  type KernelHandshakeResult,
  type KernelHealthResult,
  type KernelGetBlobParams,
  type KernelMethod,
  type KernelMethodParams,
  type KernelObjectSlice,
  type KernelPutBlobResult,
  type KernelRecordListResult,
  type KernelRecordResult,
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
  hostGeneration?: string;
  kernelBuildIdentity?: string;
  targetTriple?: string;
  targetArch?: string;
  requireKernelManifest?: boolean;
  onExit?: (error: Error) => void;
}

export type KernelBlobReadSource =
  | { branchId: string; path: string; revision?: number }
  | { pinId: string; path: string }
  | { recordId: string; slot: string }
  | { ownerId: string };

export interface KernelGrantHandle {
  readonly grantId: string;
  readonly kernelEpoch: string;
  readonly hostGeneration: string;
  readonly sessionId: string | null;
  readonly threadId: string | null;
  readonly runId: string | null;
  readonly owningWorkspace: string | null;
  readonly executionWorkspace: string | null;
  readonly capabilities: readonly string[];
  readonly pathScopes: readonly string[];
  readonly storageIdentity: string;
}

interface InternalGrantHandle extends KernelGrantHandle {
  readonly clientToken: symbol;
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

export class KernelScopedClient {
  private readonly grant: KernelGrantHandle;

  constructor(private readonly owner: KernelClient, grant: KernelGrantHandle) {
    this.grant = owner.assertGrantForScope(grant);
  }

  health(options: { deep?: boolean; signal?: AbortSignal | undefined } = {}): Promise<KernelHealthResult> {
    return this.owner.health(options);
  }

  snapshot(workspaceId: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.owner.snapshot(workspaceId, this.grant, signal);
  }

  putBlob(bytes: Uint8Array, operationId: string, signal?: AbortSignal): Promise<KernelPutBlobResult> {
    return this.owner.putBlob(bytes, operationId, this.grant, signal);
  }

  getBlob(hash: string, source: KernelBlobReadSource, options: { offset?: number; length?: number; signal?: AbortSignal | undefined } = {}): Promise<KernelObjectSlice> {
    return this.owner.getBlob(hash, source, this.grant, options);
  }

  createBranch(params: { operationId: string; branchId: string; workspaceId: string; entries: KernelCreateEntry[]; baseRef?: string }, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.owner.createBranch(params, this.grant, signal);
  }

  readBranch(params: { branchId: string; revision?: number; paths?: string[]; includeEntries?: boolean; cursor?: number; pageSize?: number }, signal?: AbortSignal): Promise<KernelBranchReadResult> {
    return this.owner.readBranch(params, this.grant, signal);
  }

  writeBranch(params: { operationId: string; branchId: string; expectedWriteRevision: number; changes: KernelBranchChange[] }, signal?: AbortSignal): Promise<KernelWriteResult> {
    return this.owner.writeBranch(params, this.grant, signal);
  }

  publishBranch(params: { operationId: string; branchId: string; expectedWriteRevision: number; expectedRoot: string }, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.owner.publishBranch(params, this.grant, signal);
  }

  pinBranch(params: { operationId: string; branchId: string; revision?: number; pinId?: string }, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.owner.pinBranch(params, this.grant, signal);
  }

  unpinBranch(params: { operationId: string; branchId: string; pinId: string }, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.owner.unpinBranch(params, this.grant, signal);
  }

  diffRoots(params: { leftRoot: string; rightRoot: string }, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.owner.diffRoots(params, this.grant, signal);
  }

  deleteBranch(params: { operationId: string; branchId: string }, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.owner.deleteBranch(params, this.grant, signal);
  }

  readPin(params: { pinId: string; includeEntries?: boolean }, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.owner.readPin(params, this.grant, signal);
  }

  gc(operationId: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.owner.gc(operationId, this.grant, signal);
  }

  getOperation(operationId: string, signal?: AbortSignal): Promise<Record<string, unknown> | null> {
    return this.owner.getOperation(operationId, this.grant, signal);
  }

  beginRecovery(params: { operationId: string; recordId?: string; workspaceId?: string; state?: string; data?: unknown }, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.owner.beginRecovery(params, this.grant, signal);
  }

  updateRecovery(params: { operationId: string; recordId?: string; workspaceId?: string; state?: string; data?: unknown }, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.owner.updateRecovery(params, this.grant, signal);
  }

  getRecovery(params: { recordId?: string; operationId?: string }, signal?: AbortSignal): Promise<Record<string, unknown> | null> {
    return this.owner.getRecovery(params, this.grant, signal);
  }

  releaseBlob(ownerId: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.owner.releaseBlob(ownerId, this.grant, signal);
  }

  releaseOperation(operationId: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.owner.releaseOperation(operationId, this.grant, signal);
  }

  putRecord(params: KernelMethodParams["storage.record.put"], signal?: AbortSignal): Promise<KernelRecordResult> {
    return this.owner.putRecord(params, this.grant, signal);
  }

  getRecord(workspaceId: string, recordId: string, signal?: AbortSignal): Promise<KernelRecordResult | null> {
    return this.owner.getRecord({ workspaceId, recordId }, this.grant, signal);
  }

  listRecords(params: KernelMethodParams["storage.record.list"], signal?: AbortSignal): Promise<KernelRecordListResult> {
    return this.owner.listRecords(params, this.grant, signal);
  }

  releaseRecord(operationId: string, workspaceId: string, recordId: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.owner.releaseRecord({ operationId, workspaceId, recordId }, this.grant, signal);
  }

  close(): Promise<void> { return this.owner.close(); }
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  grantId?: string | undefined;
}

const frame = (payload: string): Buffer => {
  const body = Buffer.from(payload, "utf8");
  if (body.byteLength > 16 * 1024 * 1024) throw new KernelClientError({ code: "kernel-frame-too-large", message: "Rust kernel frame exceeds transport limit", retryable: false });
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(body.byteLength, 0);
  return Buffer.concat([header, body]);
};

const KERNEL_BATCH_TARGET_BYTES = 512 * 1024;

const batchForKernelTransport = <T>(values: readonly T[]): T[][] => {
  const batches: T[][] = [];
  let batch: T[] = [];
  let batchBytes = 0;
  for (const value of values) {
    const valueBytes = Buffer.byteLength(JSON.stringify(value), "utf8") + 1;
    if (batch.length > 0 && batchBytes + valueBytes > KERNEL_BATCH_TARGET_BYTES) {
      batches.push(batch);
      batch = [];
      batchBytes = 0;
    }
    batch.push(value);
    batchBytes += valueBytes;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
};

const normalizeStorageIdentity = (value: string): string => {
  const withoutDevicePrefix = process.platform === "win32" && value.startsWith("\\\\?\\") ? value.slice(4) : value;
  const normalized = path.normalize(withoutDevicePrefix);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
};

const canonicalStoragePath = (value: string): string => {
  try { return fs.realpathSync.native(value); } catch { /* the kernel creates a missing leaf */ }
  try {
    return path.join(fs.realpathSync.native(path.dirname(value)), path.basename(value));
  } catch {
    return path.resolve(value);
  }
};

interface KernelManifest {
  schema: number;
  executable: string;
  targetTriple: string;
  platform: string;
  arch: string;
  binaryFormat: "pe" | "elf" | "macho";
  buildIdentity: string;
  protocolVersion: number;
  kernelVersion: string;
  sha256: string;
}

const defaultKernelCandidates = (): string[] => {
  const extension = process.platform === "win32" ? ".exe" : "";
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  return [
    process.env.PIARIUM_KERNEL_PATH?.trim() || "",
    path.resolve(moduleDirectory, "../../../../../kernel", `piarium-kernel${extension}`),
    path.resolve(moduleDirectory, "../../../../../../kernel", `piarium-kernel${extension}`),
    path.resolve(moduleDirectory, "../../../../../kernel", "target", "release", `piarium-kernel${extension}`),
    path.resolve(moduleDirectory, "../../../../../kernel", "target", "debug", `piarium-kernel${extension}`),
    path.resolve(moduleDirectory, "../../../../kernel", `piarium-kernel${extension}`),
    path.resolve(moduleDirectory, "../../../kernel", `piarium-kernel${extension}`),
    path.resolve(process.cwd(), "kernel", `piarium-kernel${extension}`),
    path.resolve(process.cwd(), "kernel", "target", "release", `piarium-kernel${extension}`),
    path.resolve(process.cwd(), "kernel", "target", "debug", `piarium-kernel${extension}`),
  ].filter(Boolean);
};

const resolveKernelCommand = (options: KernelClientOptions): { command: string; args: string[]; manifestPath?: string } => {
  const explicit = options.kernelPath?.trim() || defaultKernelCandidates().find((candidate) => fs.existsSync(candidate));
  if (explicit) {
    const manifestPath = path.join(path.dirname(explicit), "manifest.json");
    return { command: explicit, args: [], ...(fs.existsSync(manifestPath) ? { manifestPath } : {}) };
  }
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const manifest = [
    path.resolve(moduleDirectory, "../../../../../kernel/Cargo.toml"),
    path.resolve(process.cwd(), "kernel", "Cargo.toml"),
  ].find((candidate) => fs.existsSync(candidate));
  const allowCargo = options.allowCargoDevRunner ?? process.env.NODE_ENV !== "production";
  if (allowCargo && manifest) {
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
  private readonly clientToken = Symbol("piarium-kernel-client");
  private managementGrant: InternalGrantHandle | null = null;
  private handshakeResult: KernelHandshakeResult | null = null;
  private startPromise: Promise<KernelHandshakeResult> | null = null;

  constructor(options: KernelClientOptions) {
    this.options = options;
    this.spawnProcess = options.spawnProcess ?? spawn;
  }

  get isReady(): boolean { return this.started && !this.closed; }
  get kernelEpoch(): string | null { return this.epoch; }
  get handshake(): KernelHandshakeResult | null { return this.handshakeResult; }

  private assertGrant(grant: KernelGrantHandle | undefined): InternalGrantHandle {
    if (!grant || (grant as InternalGrantHandle).clientToken !== this.clientToken) {
      throw new KernelClientError({ code: "kernel-grant-required", message: "A scoped kernel grant handle is required", retryable: false });
    }
    const internal = grant as InternalGrantHandle;
    if (!this.epoch || internal.kernelEpoch !== this.epoch || internal.grantId.length === 0) {
      throw new KernelClientError({ code: "kernel-grant-stale", message: "The kernel grant handle belongs to an old epoch", retryable: true });
    }
    return internal;
  }

  /** Create a client whose every domain call carries this explicit actor grant. */
  scoped(grant: KernelGrantHandle): KernelScopedClient {
    return new KernelScopedClient(this, grant);
  }

  /** @internal used by KernelScopedClient; callers should use scoped(). */
  assertGrantForScope(grant: KernelGrantHandle): KernelGrantHandle {
    return this.assertGrant(grant);
  }

  private grantFromResponse(value: Record<string, unknown>): InternalGrantHandle {
    const grantId = typeof value.grant_id === "string" ? value.grant_id : "";
    const epoch = typeof value.kernel_epoch === "string" ? value.kernel_epoch : "";
    if (!grantId || !epoch) throw new KernelClientError({ code: "kernel-grant-invalid", message: "Rust kernel returned an incomplete grant handle", retryable: false });
    return Object.freeze({
      clientToken: this.clientToken,
      grantId,
      kernelEpoch: epoch,
      hostGeneration: String(value.host_generation ?? ""),
      sessionId: typeof value.session_id === "string" ? value.session_id : null,
      threadId: typeof value.thread_id === "string" ? value.thread_id : null,
      runId: typeof value.run_id === "string" ? value.run_id : null,
      owningWorkspace: typeof value.owning_workspace === "string" ? value.owning_workspace : null,
      executionWorkspace: typeof value.execution_workspace === "string" ? value.execution_workspace : null,
      capabilities: Object.freeze(Array.isArray(value.capabilities) ? value.capabilities.filter((entry): entry is string => typeof entry === "string") : []),
      pathScopes: Object.freeze(Array.isArray(value.path_scopes) ? value.path_scopes.filter((entry): entry is string => typeof entry === "string") : []),
      storageIdentity: String(value.storage_identity ?? ""),
    });
  }

  private isManagementMethod(method: KernelMethod): boolean {
    return method === "kernel.ping" || method === "kernel.shutdown" || method === "storage.health";
  }

  async start(): Promise<KernelHandshakeResult> {
    if (this.handshakeResult) return this.handshakeResult;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.startInternal();
    try { return await this.startPromise; } finally { this.startPromise = null; }
  }

  private async startInternal(): Promise<KernelHandshakeResult> {
    if (this.closed) throw new KernelClientError({ code: "kernel-client-closed", message: "Kernel client is closed" });
    const command = resolveKernelCommand(this.options);
    let manifest: KernelManifest | null = null;
    if (command.manifestPath) {
      try {
        manifest = JSON.parse(await fs.promises.readFile(command.manifestPath, "utf8")) as KernelManifest;
        const bytes = await fs.promises.readFile(command.command);
        const digest = createHash("sha256").update(bytes).digest("hex");
        if (manifest.schema !== 3 || manifest.sha256 !== digest || manifest.protocolVersion !== KERNEL_PROTOCOL_VERSION
          || manifest.platform !== process.platform || manifest.arch !== (this.options.targetArch ?? process.arch)
          || (this.options.targetTriple !== undefined && manifest.targetTriple !== this.options.targetTriple)
          || (this.options.kernelBuildIdentity !== undefined && manifest.buildIdentity !== this.options.kernelBuildIdentity)) {
          throw new KernelClientError({ code: "kernel-manifest-mismatch", message: "Rust kernel manifest does not match this Host", retryable: false });
        }
      } catch (error) {
        if (error instanceof KernelClientError) throw error;
        throw new KernelClientError({ code: "kernel-manifest-invalid", message: `Rust kernel manifest is invalid: ${String(error)}`, retryable: false });
      }
    } else if (this.options.requireKernelManifest ?? process.env.NODE_ENV === "production") {
      throw new KernelClientError({ code: "kernel-manifest-missing", message: "Rust kernel manifest is required for this Host", retryable: false });
    }
    const child = this.spawnProcess(command.command, [...command.args, "--stdio"], {
      cwd: this.options.cwd ?? process.cwd(),
      env: {
        ...process.env,
        PIARIUM_KERNEL_BUILD_IDENTITY: this.options.kernelBuildIdentity ?? this.options.buildVersion,
        ...this.options.env,
      },
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
    let result: KernelHandshakeResult;
    try {
    result = await this.requestRaw<KernelHandshakeResult>("kernel.handshake", {
        protocolVersion: KERNEL_PROTOCOL_VERSION,
        buildVersion: this.options.buildVersion,
        hostId: this.options.hostId,
        hostGeneration: this.options.hostGeneration ?? `${this.options.hostId}:${process.pid}`,
        storageRoot: this.options.storageRoot,
        capabilities: ["storage", "workingState", "recovery", "branchCas", "pins", "gc"],
      }, { allowBootstrap: true });
    } catch (error) {
      await this.close().catch(() => undefined);
      throw error;
    }
    const requiredCapabilities = ["storage", "workingState", "recovery", "branchCas", "pins", "gc"];
    const expectedHostGeneration = this.options.hostGeneration ?? `${this.options.hostId}:${process.pid}`;
    if (result.protocolVersion !== KERNEL_PROTOCOL_VERSION || !result.kernelEpoch || result.applicationBuildVersion !== this.options.buildVersion
      || result.buildVersion !== result.kernelBuildIdentity
      || (manifest && (result.kernelBuildIdentity !== manifest.buildIdentity || result.targetTriple !== manifest.targetTriple || result.arch !== manifest.arch))
      || (this.options.kernelBuildIdentity !== undefined && result.kernelBuildIdentity !== this.options.kernelBuildIdentity)
      || result.hostId !== this.options.hostId || result.hostGeneration !== expectedHostGeneration
      || normalizeStorageIdentity(result.storageRoot) !== normalizeStorageIdentity(canonicalStoragePath(this.options.storageRoot))
      || !requiredCapabilities.every((capability) => result.capabilities.includes(capability))) {
      await this.close().catch(() => undefined);
      throw new KernelClientError({ code: "kernel-protocol-mismatch", message: "Rust kernel handshake returned an incompatible protocol", retryable: false });
    }
    this.epoch = result.kernelEpoch;
    this.handshakeResult = result;
    this.started = true;
    const managementGrant = await this.requestRaw<Record<string, unknown>>("authority.grant.issue", {
      grantId: `host-management:${this.options.hostId}:${process.pid}`,
      hostGeneration: expectedHostGeneration,
      sessionId: null,
      threadId: null,
      runId: null,
      owningWorkspace: null,
      executionWorkspace: null,
      storageIdentity: result.storageRoot,
      capabilities: ["storage.read", "storage.gc"],
      pathScopes: [""],
    }, { allowBootstrap: true });
    this.managementGrant = this.grantFromResponse(managementGrant);
    return result;
  }

  private consume(chunk: Buffer | string): void {
    this.buffer = Buffer.concat([this.buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    while (this.buffer.byteLength >= 4) {
      const length = this.buffer.readUInt32BE(0);
      if (length > 16 * 1024 * 1024) {
        this.failAll(new KernelClientError({ code: "kernel-frame-too-large", message: "Rust kernel response exceeds transport limit", retryable: false }), true);
        return;
      }
      if (this.buffer.byteLength < length + 4) return;
      const body = this.buffer.subarray(4, length + 4);
      this.buffer = this.buffer.subarray(length + 4);
      let response: KernelResponse;
      try { response = JSON.parse(body.toString("utf8")) as KernelResponse; }
      catch (error) { this.failAll(new KernelClientError({ code: "kernel-protocol-error", message: `Invalid Rust kernel response: ${String(error)}`, retryable: false }), true); return; }
      if (response.v !== KERNEL_PROTOCOL_VERSION || response.kind !== "response" || typeof response.id !== "string" || typeof response.ok !== "boolean") {
        this.failAll(new KernelClientError({ code: "kernel-protocol-error", message: "Rust kernel response envelope is malformed", retryable: false }), true);
        return;
      }
      const pending = this.pending.get(response.id);
      if (!pending) continue;
      this.pending.delete(response.id);
      if (response.ok) pending.resolve(response.result);
      else {
        pending.reject(new KernelClientError(response.error ?? { code: "kernel-error", message: "Rust kernel request failed" }));
      }
    }
  }

  private failAll(error: Error, terminate = false): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.started = false;
    this.epoch = null;
    this.managementGrant = null;
    this.handshakeResult = null;
    this.buffer = Buffer.alloc(0);
    if (terminate && this.child && !this.child.killed) this.child.kill();
  }

  private async write(request: KernelRequest): Promise<void> {
    const stdin = this.child?.stdin;
    if (!stdin || stdin.destroyed) throw new KernelClientError({ code: "kernel-disconnected", message: "Rust kernel stdin is unavailable", retryable: true });
    const writable = stdin as Writable;
    if (!writable.write(frame(JSON.stringify(request)))) await once(writable, "drain");
  }

  private async requestRaw<T, M extends KernelMethod = KernelMethod>(method: M, params: KernelMethodParams[M], options: { signal?: AbortSignal | undefined; grant?: KernelGrantHandle | undefined; allowBootstrap?: boolean | undefined } = {}): Promise<T> {
    const id = randomUUID();
    const grant = options.grant
      ? this.assertGrant(options.grant)
      : this.isManagementMethod(method)
        ? this.managementGrant
        : null;
    if (this.epoch && !grant && !options.allowBootstrap && method !== "kernel.handshake" && method !== "authority.grant.issue" && method !== "authority.grant.revoke") {
      throw new KernelClientError({ code: "kernel-grant-required", message: `A scoped grant is required for ${method}`, retryable: false });
    }
    const request = {
      v: KERNEL_PROTOCOL_VERSION,
      kind: "request",
      id,
      method,
      params,
      ...(this.epoch ? { epoch: this.epoch } : {}),
      ...(grant ? { grantId: grant.grantId } : {}),
    } as KernelRequest;
    let rejectPending: ((error: unknown) => void) | undefined;
    const promise = new Promise<T>((resolve, reject) => {
      rejectPending = reject;
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, grantId: grant?.grantId });
    });
    // Abort can fire while stdin is blocked on drain. Attach a handler before
    // awaiting the write so Node never observes the pending request as an
    // unhandled rejection during genuine transport backpressure.
    void promise.catch(() => undefined);
    const abort = () => {
      if (!this.pending.delete(id)) return;
      rejectPending?.(new KernelClientError({ code: "cancelled", message: "Kernel request cancelled", retryable: true }));
      void this.write({ v: KERNEL_PROTOCOL_VERSION, kind: "cancel", id, ...(this.epoch ? { epoch: this.epoch } : {}), ...(grant ? { grantId: grant.grantId } : {}) }).catch(() => undefined);
    };
    const signal = options.signal;
    if (signal?.aborted) { abort(); throw new KernelClientError({ code: "cancelled", message: "Kernel request cancelled", retryable: true }); }
    signal?.addEventListener("abort", abort, { once: true });
    try {
      await this.write(request);
      return await promise;
    } catch (error) {
      this.pending.delete(id);
      throw error;
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }

  async health(options: { deep?: boolean; signal?: AbortSignal | undefined } = {}): Promise<KernelHealthResult> {
    if (!this.handshakeResult) await this.start();
    return this.requestRaw<KernelHealthResult>("storage.health", options.deep === undefined ? {} : { deep: options.deep }, { signal: options.signal });
  }

  async snapshot(workspaceId: string, grant: KernelGrantHandle, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.requestRaw<Record<string, unknown>>("storage.snapshot", { workspaceId }, { signal, grant });
  }

  async putBlob(bytes: Uint8Array, operationId: string, grant: KernelGrantHandle, signal?: AbortSignal): Promise<KernelPutBlobResult> {
    const scoped = this.assertGrant(grant);
    const source = Buffer.from(bytes);
    const expectedHash = `sha256-${createHash("sha256").update(source).digest("hex")}`;
    const existing = await this.getOperation(operationId, scoped, signal).catch(() => null);
    if (existing?.state === "committed" && existing.result && typeof existing.result === "object") {
      const result = existing.result as Partial<KernelPutBlobResult>;
      if (result.hash === expectedHash && result.byteLength === source.byteLength && typeof result.ownerId === "string") return result as KernelPutBlobResult;
    }
    const streamId = `blob-${randomUUID()}`;
    try {
      const begin = await this.requestRaw<Record<string, unknown>>("storage.putBlob.begin", {
        operationId,
        streamId,
        byteLength: source.byteLength,
        expectedHash,
        ...(scoped.owningWorkspace ? { workspaceId: scoped.owningWorkspace } : {}),
      }, { signal, grant: scoped });
      if (begin.streamId !== streamId) throw new KernelClientError({ code: "kernel-stream-invalid", message: "Rust kernel returned a different upload stream identity", retryable: false });
      const chunkSize = 64 * 1024;
      let sequence = 0;
      for (let offset = 0; offset < source.byteLength; offset += chunkSize) {
        signal?.throwIfAborted();
        const chunk = source.subarray(offset, Math.min(offset + chunkSize, source.byteLength));
        await this.writeDataFrame(streamId, sequence, chunk, scoped);
        sequence += 1;
      }
      return await this.requestRaw<KernelPutBlobResult>("storage.putBlob.finish", {
        operationId,
        streamId,
        expectedHash,
        ...(scoped.owningWorkspace ? { workspaceId: scoped.owningWorkspace } : {}),
      }, { signal, grant: scoped });
    } catch (error) {
      await this.requestRaw<Record<string, unknown>>("storage.putBlob.abort", {
        operationId,
        streamId,
        ...(scoped.owningWorkspace ? { workspaceId: scoped.owningWorkspace } : {}),
      }, { grant: scoped }).catch(() => undefined);
      throw error;
    }
  }

  private async writeDataFrame(streamId: string, sequence: number, bytes: Uint8Array, grant: InternalGrantHandle): Promise<void> {
    await this.write({
      v: KERNEL_PROTOCOL_VERSION,
      kind: "data",
      id: streamId,
      streamId,
      sequence,
      bytesBase64: Buffer.from(bytes).toString("base64"),
      epoch: this.epoch ?? grant.kernelEpoch,
      grantId: grant.grantId,
    });
  }

  async getBlob(hash: string, source: KernelBlobReadSource, grant: KernelGrantHandle, options: { offset?: number; length?: number; signal?: AbortSignal | undefined } = {}): Promise<KernelObjectSlice> {
    const params: KernelGetBlobParams = { hash, ...source, ...(options.offset === undefined ? {} : { offset: options.offset }), ...(options.length === undefined ? {} : { length: options.length }) };
    return this.requestRaw<KernelObjectSlice>("storage.getBlob", params, { signal: options.signal, grant });
  }

  async createBranch(params: { operationId: string; branchId: string; workspaceId: string; entries: KernelCreateEntry[]; baseRef?: string }, grant: KernelGrantHandle, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const scoped = this.assertGrant(grant);
    const builderId = `branch-builder-${randomUUID()}`;
    try {
      await this.requestRaw<Record<string, unknown>>("branch.create.begin", {
        operationId: params.operationId,
        builderId,
        branchId: params.branchId,
        workspaceId: params.workspaceId,
        ...(params.baseRef === undefined ? {} : { baseRef: params.baseRef }),
      }, { signal, grant: scoped });
      let sequence = 0;
      for (const batch of batchForKernelTransport(params.entries)) {
        await this.requestRaw<Record<string, unknown>>("branch.create.append", { builderId, sequence, entries: batch }, { signal, grant: scoped });
        sequence += 1;
      }
      return await this.requestRaw<Record<string, unknown>>("branch.create.finish", { operationId: params.operationId, builderId }, { signal, grant: scoped });
    } catch (error) {
      await this.requestRaw<Record<string, unknown>>("branch.create.abort", { builderId }, { grant: scoped }).catch(() => undefined);
      throw error;
    }
  }

  async readBranch(params: { branchId: string; revision?: number; paths?: string[]; includeEntries?: boolean; cursor?: number; pageSize?: number }, grant: KernelGrantHandle, signal?: AbortSignal): Promise<KernelBranchReadResult> {
    return this.requestRaw<KernelBranchReadResult>("branch.read", params, { signal, grant });
  }

  async writeBranch(params: { operationId: string; branchId: string; expectedWriteRevision: number; changes: KernelBranchChange[] }, grant: KernelGrantHandle, signal?: AbortSignal): Promise<KernelWriteResult> {
    const scoped = this.assertGrant(grant);
    const builderId = `branch-write-${randomUUID()}`;
    try {
      await this.requestRaw<Record<string, unknown>>("branch.write.begin", {
        operationId: params.operationId,
        builderId,
        branchId: params.branchId,
        expectedWriteRevision: params.expectedWriteRevision,
      }, { signal, grant: scoped });
      let sequence = 0;
      for (const batch of batchForKernelTransport(params.changes)) {
        await this.requestRaw<Record<string, unknown>>("branch.write.append", { builderId, sequence, changes: batch }, { signal, grant: scoped });
        sequence += 1;
      }
      return await this.requestRaw<KernelWriteResult>("branch.write.finish", { operationId: params.operationId, builderId }, { signal, grant: scoped });
    } catch (error) {
      await this.requestRaw<Record<string, unknown>>("branch.write.abort", { builderId }, { grant: scoped }).catch(() => undefined);
      throw error;
    }
  }

  async publishBranch(params: { operationId: string; branchId: string; expectedWriteRevision: number; expectedRoot: string }, grant: KernelGrantHandle, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.requestRaw<Record<string, unknown>>("branch.publish", params, { signal, grant });
  }

  async pinBranch(params: { operationId: string; branchId: string; revision?: number; pinId?: string }, grant: KernelGrantHandle, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.requestRaw<Record<string, unknown>>("branch.pin", params, { signal, grant });
  }

  async unpinBranch(params: { operationId: string; branchId: string; pinId: string }, grant: KernelGrantHandle, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.requestRaw<Record<string, unknown>>("branch.unpin", params, { signal, grant });
  }

  async diffRoots(params: { leftRoot: string; rightRoot: string }, grant: KernelGrantHandle, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.requestRaw<Record<string, unknown>>("branch.diff", params, { signal, grant });
  }

  async deleteBranch(params: { operationId: string; branchId: string }, grant: KernelGrantHandle, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.requestRaw<Record<string, unknown>>("branch.delete", params, { signal, grant });
  }

  async readPin(params: { pinId: string; includeEntries?: boolean }, grant: KernelGrantHandle, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.requestRaw<Record<string, unknown>>("pin.read", params, { signal, grant });
  }

  async gc(operationId: string, grant: KernelGrantHandle, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.requestRaw<Record<string, unknown>>("storage.gc", { operationId }, { signal, grant });
  }

  async getOperation(operationId: string, grant: KernelGrantHandle, signal?: AbortSignal): Promise<Record<string, unknown> | null> {
    return this.requestRaw<Record<string, unknown> | null>("operation.get", { operationId }, { signal, grant });
  }

  async beginRecovery(params: { operationId: string; recordId?: string; workspaceId?: string; state?: string; data?: unknown }, grant: KernelGrantHandle, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.requestRaw<Record<string, unknown>>("recovery.operation.begin", params, { signal, grant });
  }

  async updateRecovery(params: { operationId: string; recordId?: string; workspaceId?: string; state?: string; data?: unknown }, grant: KernelGrantHandle, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.requestRaw<Record<string, unknown>>("recovery.operation.update", params, { signal, grant });
  }

  async getRecovery(params: { recordId?: string; operationId?: string }, grant: KernelGrantHandle, signal?: AbortSignal): Promise<Record<string, unknown> | null> {
    return this.requestRaw<Record<string, unknown> | null>("recovery.operation.get", params, { signal, grant });
  }

  async issueGrant(params: Record<string, unknown>, signal?: AbortSignal): Promise<KernelGrantHandle> {
    if (!this.handshakeResult) await this.start();
    const grant = await this.requestRaw<Record<string, unknown>>("authority.grant.issue", {
      ...params,
      hostGeneration: params.hostGeneration ?? this.options.hostGeneration ?? `${this.options.hostId}:${process.pid}`,
      ...(params.storageIdentity === undefined && this.handshake?.storageRoot
        ? { storageIdentity: this.handshake.storageRoot }
        : {}),
    }, { signal });
    return this.grantFromResponse(grant);
  }

  async revokeGrant(grantId: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    if (!this.handshakeResult) await this.start();
    return this.requestRaw<Record<string, unknown>>("authority.grant.revoke", { grantId }, { signal });
  }

  async releaseBlob(ownerId: string, grant: KernelGrantHandle, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.requestRaw<Record<string, unknown>>("storage.blob.release", { ownerId }, { signal, grant });
  }

  async releaseOperation(operationId: string, grant: KernelGrantHandle, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const scoped = this.assertGrant(grant);
    return this.requestRaw<Record<string, unknown>>("operation.release", {
      operationId,
      ...(scoped.owningWorkspace ? { workspaceId: scoped.owningWorkspace } : {}),
    }, { signal, grant: scoped });
  }

  async putRecord(params: KernelMethodParams["storage.record.put"], grant: KernelGrantHandle, signal?: AbortSignal): Promise<KernelRecordResult> {
    return this.requestRaw<KernelRecordResult>("storage.record.put", params, { signal, grant });
  }

  async getRecord(params: KernelMethodParams["storage.record.get"], grant: KernelGrantHandle, signal?: AbortSignal): Promise<KernelRecordResult | null> {
    return this.requestRaw<KernelRecordResult | null>("storage.record.get", params, { signal, grant });
  }

  async listRecords(params: KernelMethodParams["storage.record.list"], grant: KernelGrantHandle, signal?: AbortSignal): Promise<KernelRecordListResult> {
    return this.requestRaw<KernelRecordListResult>("storage.record.list", params, { signal, grant });
  }

  async releaseRecord(params: KernelMethodParams["storage.record.release"], grant: KernelGrantHandle, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.requestRaw<Record<string, unknown>>("storage.record.release", params, { signal, grant });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.handshakeResult && this.child && !this.child.killed) {
      await this.requestRaw("kernel.shutdown", {}, { grant: this.managementGrant ?? undefined }).catch(() => undefined);
    }
    const child = this.child;
    this.child = null;
    if (!child) return;
    const waitForExit = (): Promise<boolean> => new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve(true);
        return;
      }
      const onExit = () => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        child.removeListener("exit", onExit);
        resolve(false);
      }, 5_000);
      child.once("exit", onExit);
    });
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (!child.killed) child.stdin.end();
    const stopped = await waitForExit();
    if (stopped) return;
    child.kill();
    const killed = await waitForExit();
    if (!killed) throw new KernelClientError({ code: "kernel-stop-failed", message: "Rust kernel did not exit after termination", retryable: true });
  }
}

export const createKernelClient = (options: KernelClientOptions): KernelClient => new KernelClient(options);
