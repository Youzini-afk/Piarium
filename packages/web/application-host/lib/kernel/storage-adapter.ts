import { randomUUID, createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { KernelBranchState, KernelRecordResult } from "./protocol.generated.js";
import type { KernelClient, KernelGrantHandle, KernelScopedClient } from "./kernel-client.js";
import type { SqliteDatabase } from "../recovery/journal-catalog.js";
import type { RecoveryCatalogBackend } from "./kernel-recovery-catalog.js";
import { createRecoveryFileStore, type RecoveryFileStore, type RecoveryIdentity } from "../recovery/journal-files.js";
import { materializeWorkingState, type MaterializeResult } from "../harness/working-state/materializer.js";
import { sameState, stateIdentity } from "../recovery/journal-files.js";
import type {
  CommandVerificationRecord,
  DraftBaseline,
  DraftBaselinePathProvenance,
  ParentVerificationBundle,
  RecoveryState,
  ResultReviewRecord,
  ResultVerificationBundle,
  WorkingBranch,
  WorkingResult,
} from "../harness/working-state/types.js";
import { treeIdentityFromStates, type CreateDraftBaselinePath, type WorkspaceWorkingStateAccess } from "../harness/working-state/working-state-store.js";

type Mode = "exclusive" | "shared";

export interface KernelActorIdentity {
  sessionId?: string;
  threadId?: string;
  runId?: string;
  owningWorkspace: string;
  executionWorkspace?: string;
  pathScopes?: string[];
}

export interface KernelStorageReference {
  slot: string;
  objectHash: string;
}

export interface KernelStorageContext {
  client: KernelScopedClient;
  /** SQL-shaped transient view for legacy orchestration queries; never durable. */
  database?: SqliteDatabase;
  identity: RecoveryIdentity;
  root: string;
  fileStore: RecoveryFileStore;
  resourceOperationGate: { run<T>(resources: readonly unknown[], operation: () => Promise<T>): Promise<T> };
  records: {
    get(recordId: string): Promise<KernelRecordResult | null>;
    list(input: { recordType?: string; threadId?: string; runId?: string; branchId?: string }): Promise<KernelRecordResult[]>;
    put(input: {
      operationId: string;
      recordId: string;
      recordType: string;
      state: string;
      payloadJson: string;
      references?: KernelStorageReference[];
      ownerIds?: string[];
      sessionId?: string;
      threadId?: string;
      runId?: string;
      branchId?: string;
      revision?: number;
      resultRevision?: number;
    }): Promise<KernelRecordResult>;
    release(operationId: string, recordId: string): Promise<Record<string, unknown>>;
  };
}

interface BranchProjection {
  branchId: string;
  workspaceId: string;
  baseRef?: string;
  baseState: Record<string, RecoveryState>;
  deltas: Record<string, RecoveryState>;
  headRevision: number;
  writeRevision: number;
  root: string;
  baseRoot: string;
  createdAt: string;
  updatedAt: string;
  draftBasePaths: string[];
  captureScopes: string[];
}

const clone = <T>(value: T): T => structuredClone(value);
const nowIso = (): string => new Date().toISOString();
const normalize = (value: string): string => {
  const raw = value.replace(/\\/g, "/").replace(/^\.\//, "");
  const parts = raw.split("/").filter((part) => part && part !== ".");
  if (!raw || raw.startsWith("/") || /^[A-Za-z]:/.test(raw) || raw.includes("\0") || parts.includes("..")) {
    throw new Error(`Invalid working-state path: ${value}`);
  }
  return parts.join("/");
};

const toKernelState = (state: RecoveryState): KernelBranchState => {
  if (state.kind === "regular-file") {
    return { kind: "regular-file", objectHash: state.objectHash, byteLength: state.byteLength, mode: state.mode ?? 0o644 };
  }
  if (state.kind === "directory") return { kind: "directory", ...(state.mode === undefined ? {} : { mode: state.mode }) };
  if (state.kind === "symlink") return { kind: "symlink", symlinkTarget: state.symlinkTarget, ...(state.mode === undefined ? {} : { mode: state.mode }) };
  return { kind: state.kind };
};

const fromKernelState = (state: KernelBranchState): RecoveryState => {
  if (state.kind === "regular-file") return { kind: "regular-file", objectHash: state.objectHash, byteLength: state.byteLength, mode: state.mode };
  if (state.kind === "directory") return { kind: "directory", ...(state.mode === undefined ? {} : { mode: state.mode }) };
  if (state.kind === "symlink") return { kind: "symlink", symlinkTarget: state.symlinkTarget, ...(state.mode === undefined ? {} : { mode: state.mode }) };
  return { kind: state.kind };
};

const asRecord = (value: unknown): Record<string, unknown> => (
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
);

const parsePayload = <T>(record: KernelRecordResult): T => JSON.parse(record.payloadJson) as T;

export class KernelWorkingStateStore {
  private readonly branches = new Map<string, BranchProjection>();
  private readonly results = new Map<string, WorkingResult>();
  private readonly drafts = new Map<string, DraftBaseline>();
  private readonly verifications = new Map<string, ResultVerificationBundle[]>();
  private readonly parentVerifications = new Map<string, ParentVerificationBundle[]>();
  private readonly reviews = new Map<string, ResultReviewRecord[]>();
  private readonly ownerByHash = new Map<string, string>();
  private readonly sourceByHash = new Map<string, { branchId?: string; path?: string; revision?: number; recordId?: string; slot?: string; ownerId?: string }>();
  private readonly fileStore: RecoveryFileStore;

  private constructor(
    private readonly adapter: KernelStorageAdapter,
    private readonly context: KernelStorageContext,
  ) {
    this.fileStore = context.fileStore;
  }

  static async open(adapter: KernelStorageAdapter, context: KernelStorageContext): Promise<KernelWorkingStateStore> {
    const store = new KernelWorkingStateStore(adapter, context);
    const snapshot = await context.client.snapshot(context.identity.workspaceId);
    const branches = Array.isArray(asRecord(snapshot).branches) ? asRecord(snapshot).branches as unknown[] : [];
    for (const item of branches) await store.loadBranch(asRecord(item));
    for (const record of await context.records.list({ recordType: "working.result" })) store.loadResultRecord(record);
    for (const record of await context.records.list({ recordType: "working.draft" })) store.loadDraftRecord(record);
    for (const record of await context.records.list({ recordType: "working.verification.child" })) store.loadVerificationRecord(record, "child");
    for (const record of await context.records.list({ recordType: "working.verification.parent" })) store.loadVerificationRecord(record, "parent");
    for (const record of await context.records.list({ recordType: "working.review" })) store.loadVerificationRecord(record, "review");
    for (const record of await context.records.list({})) {
      for (const reference of record.references) store.sourceByHash.set(reference.objectHash, { recordId: record.recordId, slot: reference.slot });
    }
    return store;
  }

  private async readAll(branchId: string, revision?: number): Promise<Record<string, RecoveryState>> {
    const states: Record<string, RecoveryState> = {};
    let cursor: number | undefined;
    do {
      const page = await this.context.client.readBranch({ branchId, ...(revision === undefined ? {} : { revision }), includeEntries: true, ...(cursor === undefined ? {} : { cursor }), pageSize: 256 });
      for (const entry of page.entries) {
        const state = fromKernelState(entry.state);
        states[normalize(entry.path)] = state;
        if (state.kind === "regular-file") this.sourceByHash.set(state.objectHash, { branchId, path: normalize(entry.path), ...(revision === undefined ? {} : { revision }) });
      }
      cursor = page.nextCursor === null || page.nextCursor === undefined ? undefined : page.nextCursor;
    } while (cursor !== undefined);
    return states;
  }

  private async loadBranch(row: Record<string, unknown>): Promise<void> {
    const branchId = String(row.branchId ?? "");
    const baseRoot = String(row.baseRoot ?? "");
    const root = String(row.headRoot ?? "");
    if (!branchId || !baseRoot || !root) return;
    const [baseState, effective] = await Promise.all([
      this.readAll(branchId, 0),
      this.readAll(branchId),
    ]);
    const deltas: Record<string, RecoveryState> = {};
    for (const [file, state] of Object.entries(effective)) {
      if (!sameState(baseState[file] ?? { kind: "missing" }, state)) deltas[file] = state;
    }
    const meta = await this.context.records.get(`working-branch:${branchId}`);
    const payload = meta ? asRecord(parsePayload(meta)) : {};
    const createdAt = typeof payload.createdAt === "string" ? payload.createdAt : nowIso();
    this.branches.set(branchId, {
      branchId,
      workspaceId: this.context.identity.workspaceId,
      ...(typeof payload.baseRef === "string" ? { baseRef: payload.baseRef } : {}),
      baseState,
      deltas,
      headRevision: Number(row.headRevision ?? 0),
      writeRevision: Number(row.writeRevision ?? 0),
      root,
      baseRoot,
      createdAt,
      updatedAt: typeof payload.updatedAt === "string" ? payload.updatedAt : createdAt,
      draftBasePaths: Array.isArray(payload.draftBasePaths) ? payload.draftBasePaths.filter((item): item is string => typeof item === "string") : [],
      captureScopes: Array.isArray(payload.captureScopes) ? payload.captureScopes.filter((item): item is string => typeof item === "string") : [],
    });
  }

  private loadResultRecord(record: KernelRecordResult): void {
    const payload = asRecord(parsePayload(record));
    const branchId = typeof payload.branchId === "string" ? payload.branchId : record.branchId;
    const revision = Number(payload.resultRevision ?? record.resultRevision ?? 0);
    if (!branchId || !Number.isSafeInteger(revision) || revision <= 0) return;
    const result = payload as unknown as WorkingResult;
    if (result.branchId !== branchId || result.resultRevision !== revision) return;
    this.results.set(`${branchId}@${revision}`, clone(result));
    for (const [file, state] of Object.entries(result.pathStates ?? {})) if (state.kind === "regular-file") this.sourceByHash.set(state.objectHash, { branchId, path: file, revision });
    for (const [file, state] of Object.entries(result.baseStates ?? {})) if (state.kind === "regular-file") {
      const reference = record.references.find((item) => item.slot === `base:${file}`);
      if (reference) this.sourceByHash.set(state.objectHash, { recordId: record.recordId, slot: reference.slot });
    }
  }

  private loadDraftRecord(record: KernelRecordResult): void {
    const payload = parsePayload<DraftBaseline>(record);
    if (payload?.id) {
      this.drafts.set(payload.id, clone(payload));
      for (const [file, state] of Object.entries(payload.pathStates)) if (state.kind === "regular-file") {
        const reference = record.references.find((item) => item.slot === `draft:${file}`);
        this.sourceByHash.set(state.objectHash, reference ? { recordId: record.recordId, slot: reference.slot } : {});
      }
    }
  }

  private loadVerificationRecord(record: KernelRecordResult, kind: "child" | "parent" | "review"): void {
    const payload = parsePayload<Record<string, unknown>>(record);
    const threadId = typeof record.threadId === "string" ? record.threadId : typeof payload.threadId === "string" ? payload.threadId : "";
    if (!threadId) return;
    if (kind === "child") this.verifications.set(threadId, [...(this.verifications.get(threadId) ?? []), payload as unknown as ResultVerificationBundle]);
    else if (kind === "parent") this.parentVerifications.set(threadId, [...(this.parentVerifications.get(threadId) ?? []), payload as unknown as ParentVerificationBundle]);
    else this.reviews.set(threadId, [...(this.reviews.get(threadId) ?? []), payload as unknown as ResultReviewRecord]);
  }

  private branchEntries(branch: BranchProjection): Array<{ path: string; state: KernelBranchState; ownerId?: string; sourcePath?: string }> {
    return Object.entries(branch.deltas).map(([file, state]) => {
      const entry = { path: file, state: toKernelState(state) } as { path: string; state: KernelBranchState; ownerId?: string; sourcePath?: string };
      if (state.kind === "regular-file") {
        const ownerId = this.ownerByHash.get(state.objectHash);
        if (ownerId) entry.ownerId = ownerId;
        else {
          const source = this.sourceByHash.get(state.objectHash);
          if (source?.path) entry.sourcePath = source.path;
        }
      }
      return entry;
    });
  }

  private async putMetadata(branch: BranchProjection): Promise<void> {
    await this.context.records.put({
      operationId: `branch-meta:${branch.branchId}:${branch.writeRevision}`,
      recordId: `working-branch:${branch.branchId}`,
      recordType: "working.branch",
      state: "active",
      branchId: branch.branchId,
      revision: branch.headRevision,
      payloadJson: JSON.stringify({ baseRef: branch.baseRef, draftBasePaths: branch.draftBasePaths, captureScopes: branch.captureScopes, createdAt: branch.createdAt, updatedAt: branch.updatedAt }),
    });
  }

  getBranch(branchId: string): WorkingBranch | null {
    const branch = this.branches.get(branchId);
    if (!branch) return null;
    return clone({ branchId: branch.branchId, workspaceId: branch.workspaceId, ...(branch.baseRef ? { baseRef: branch.baseRef } : {}), baseState: branch.baseState, draftBasePaths: branch.draftBasePaths, captureScopes: branch.captureScopes, deltas: branch.deltas, headRevision: branch.headRevision, writeRevision: branch.writeRevision, createdAt: branch.createdAt, updatedAt: branch.updatedAt });
  }

  getDraftBaselineRecord(id: string): DraftBaseline | null { const value = this.drafts.get(id); return value ? clone(value) : null; }
  async getDraftBaseline(id: string): Promise<DraftBaseline | null> { return this.getDraftBaselineRecord(id); }
  listResults(branchId?: string): WorkingResult[] { return [...this.results.values()].filter((result) => branchId === undefined || result.branchId === branchId).map(clone); }
  getResult(branchId: string, revision: number): WorkingResult | null { const value = this.results.get(`${branchId}@${revision}`); return value ? clone(value) : null; }
  resultState(branchId: string, revision: number): Record<string, RecoveryState> | null { const branch = this.branches.get(branchId); const result = this.results.get(`${branchId}@${revision}`); return branch && result ? { ...clone(branch.baseState), ...clone(result.pathStates) } : null; }
  effectiveState(branchId: string, revision?: number): Record<string, RecoveryState> | null {
    const branch = this.branches.get(branchId);
    if (!branch) return null;
    if (revision !== undefined && revision > 0) return this.resultState(branchId, revision);
    return { ...clone(branch.baseState), ...clone(branch.deltas) };
  }
  effectiveStateSlice(branchId: string, prefixes: readonly string[], revision?: number, options?: { signal?: AbortSignal; deadlineAt?: number }): Record<string, RecoveryState> | null {
    const state = this.effectiveState(branchId, revision);
    if (!state) return null;
    const roots = prefixes.length ? prefixes.map(normalize) : [""];
    const result: Record<string, RecoveryState> = {};
    for (const [file, value] of Object.entries(state)) {
      options?.signal?.throwIfAborted();
      if (options?.deadlineAt !== undefined && Date.now() >= options.deadlineAt) throw new DOMException("Explore query deadline exceeded", "AbortError");
      if (roots.some((root) => !root || file === root || file.startsWith(`${root}/`) || root.startsWith(`${file}/`))) result[file] = clone(value);
    }
    return result;
  }
  branchWriteRevision(branchId: string): number | null { return this.branches.get(branchId)?.writeRevision ?? null; }
  pathOrigin(branchId: string, file: string): "base" | "delta" | "draft-base" | null {
    const branch = this.branches.get(branchId); if (!branch) return null; const normalized = normalize(file);
    if (Object.hasOwn(branch.deltas, normalized)) return "delta";
    if (branch.draftBasePaths.includes(normalized)) return "draft-base";
    if (Object.hasOwn(branch.baseState, normalized)) return "base";
    return null;
  }
  resultTreeIdentity(branchId: string, revision: number): string | null { const state = this.resultState(branchId, revision); return state ? treeIdentityFromStates(state) : null; }

  async putObject(bytes: Buffer): Promise<{ hash: string; byteLength: number }> {
    const operationId = `blob:${randomUUID()}`;
    const value = await this.context.client.putBlob(bytes, operationId);
    this.ownerByHash.set(value.hash, value.ownerId);
    this.sourceByHash.set(value.hash, { ownerId: value.ownerId });
    return { hash: value.hash, byteLength: value.byteLength };
  }
  ownerIdForObject(hash: string): string | undefined { return this.ownerByHash.get(hash); }

  private async objectSource(hash: string): Promise<{ branchId: string; path: string; revision?: number } | { recordId: string; slot: string } | { ownerId: string }> {
    const source = this.sourceByHash.get(hash);
    if (source?.ownerId) return { ownerId: source.ownerId };
    if (source?.recordId && source.slot) return { recordId: source.recordId, slot: source.slot };
    if (source?.branchId && source.path) return { branchId: source.branchId, path: source.path, ...(source.revision === undefined ? {} : { revision: source.revision }) };
    const owner = this.ownerByHash.get(hash);
    if (owner) return { ownerId: owner };
    const records = await this.context.records.list({});
    for (const record of records) {
      const reference = record.references.find((item) => item.objectHash === hash);
      if (reference) {
        this.sourceByHash.set(hash, { recordId: record.recordId, slot: reference.slot });
        return { recordId: record.recordId, slot: reference.slot };
      }
    }
    throw new Error(`Kernel object ${hash} has no durable source identity`);
  }

  async getObject(hash: string): Promise<Buffer | null> {
    try {
      const slice = await this.context.client.getBlob(hash, await this.objectSource(hash));
      return Buffer.from(slice.bytesBase64, "base64");
    } catch (error) {
      if ((error as { code?: string }).code === "object-not-found") return null;
      throw error;
    }
  }
  async getObjectSlice(hash: string, _expectedByteLength: number, offset: number, length: number): Promise<Buffer | null> {
    const slice = await this.context.client.getBlob(hash, await this.objectSource(hash), { offset, length });
    return Buffer.from(slice.bytesBase64, "base64");
  }

  async captureDirectory(directory: string, relativePaths?: string[], options?: { signal?: AbortSignal; onProgress?: (done: number, total: number) => void; store?: boolean; indexModes?: Map<string, string> | Record<string, string> }): Promise<Record<string, RecoveryState>> {
    const files = relativePaths?.map(normalize) ?? await this.scanDirectory(directory);
    const result: Record<string, RecoveryState> = {};
    let done = 0;
    for (const file of files) {
      options?.signal?.throwIfAborted();
      const captured = await this.fileStore.captureState({ ...this.context.identity, canonicalRoot: directory }, this.context.root, file, { store: false });
      let state = captured.state;
      if (state.kind === "regular-file") {
        const object = await this.putObject(await fs.promises.readFile(path.join(directory, ...file.split("/"))));
        state = { ...state, objectHash: object.hash, byteLength: object.byteLength };
      }
      result[file] = state;
      done += 1; options?.onProgress?.(done, files.length);
    }
    return result;
  }

  private async scanDirectory(directory: string, base = directory): Promise<string[]> {
    const output: string[] = [];
    for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === ".piarium") continue;
      const absolute = path.join(directory, entry.name); const relative = normalize(path.relative(base, absolute));
      output.push(relative); if (entry.isDirectory()) output.push(...await this.scanDirectory(absolute, base));
    }
    return output.sort();
  }
  async listCaptureScopePaths(directory: string, scopes: readonly string[]): Promise<string[]> { return Object.keys(await this.captureDirectory(directory, [...scopes])); }
  async listWorkspaceBaselinePaths(directory: string): Promise<string[]> { return this.scanDirectory(directory); }

  async createBranch(workspaceId: string, branchId: string, baseState: Record<string, RecoveryState>, baseRef?: string, draftBasePaths: string[] = [], captureScopes: string[] = []): Promise<WorkingBranch> {
    if (workspaceId !== this.context.identity.workspaceId) throw new Error("Working-state workspace mismatch");
    const existing = this.getBranch(branchId); if (existing) return existing;
    let entriesState = baseState;
    if (baseRef) {
      const split = baseRef.lastIndexOf("@");
      const parentId = split > 0 ? baseRef.slice(0, split) : "";
      const parentRevision = split > 0 ? Number(baseRef.slice(split + 1)) : undefined;
      const parent = parentId ? this.effectiveState(parentId, parentRevision) : null;
      if (parent) entriesState = Object.fromEntries(Object.entries(baseState).filter(([file, state]) => !sameState(parent[file] ?? { kind: "missing" }, state)));
    }
    const entries = Object.entries(entriesState).map(([file, state]) => ({ path: normalize(file), state: toKernelState(state), ...(state.kind === "regular-file" && this.ownerByHash.has(state.objectHash) ? { ownerId: this.ownerByHash.get(state.objectHash)! } : {}), ...(state.kind === "regular-file" && !this.ownerByHash.has(state.objectHash) && this.sourceByHash.get(state.objectHash)?.path ? { sourcePath: this.sourceByHash.get(state.objectHash)!.path } : {}) }));
    const created = await this.context.client.createBranch({ operationId: `branch-create:${branchId}`, branchId, workspaceId, entries, ...(baseRef ? { baseRef } : {}) });
    const now = nowIso();
    let baseRoot = String(asRecord(created).root);
    if (baseRef) {
      const split = baseRef.lastIndexOf("@");
      if (split > 0) baseRoot = (await this.context.client.readBranch({ branchId: baseRef.slice(0, split), revision: Number(baseRef.slice(split + 1)) })).root;
    }
    const row: BranchProjection = { branchId, workspaceId, ...(baseRef ? { baseRef } : {}), baseState: clone(baseState), deltas: {}, headRevision: Number(asRecord(created).headRevision ?? 0), writeRevision: Number(asRecord(created).writeRevision ?? 0), root: String(asRecord(created).root), baseRoot, createdAt: now, updatedAt: now, draftBasePaths: draftBasePaths.map(normalize), captureScopes: captureScopes.map(normalize) };
    this.branches.set(branchId, row); await this.putMetadata(row); for (const [file, state] of Object.entries(baseState)) if (state.kind === "regular-file") { this.ownerByHash.delete(state.objectHash); this.sourceByHash.set(state.objectHash, { branchId, path: file }); }
    return this.getBranch(branchId)!;
  }

  async createDraftBaseline(workspaceId: string, paths: readonly CreateDraftBaselinePath[]): Promise<DraftBaseline> {
    if (workspaceId !== this.context.identity.workspaceId) throw new Error("Working-state workspace mismatch");
    const id = `draft-${randomUUID()}`; const pathStates: Record<string, RecoveryState> = {}; const provenance: Record<string, DraftBaselinePathProvenance> = {}; const ownerIds: string[] = []; const references: KernelStorageReference[] = [];
    for (const input of paths) { const file = normalize(input.path); const bytes = typeof input.content === "string" ? Buffer.from(input.content, "utf8") : input.content; const object = await this.putObject(bytes); pathStates[file] = { kind: "regular-file", objectHash: object.hash, byteLength: object.byteLength, ...(input.mode === undefined ? {} : { mode: input.mode }) }; provenance[file] = clone(input.provenance); const owner = this.ownerByHash.get(object.hash); if (owner) ownerIds.push(owner); references.push({ slot: `draft:${file}`, objectHash: object.hash }); }
    const baseline: DraftBaseline = { id, workspaceId, createdAt: nowIso(), pathStates, provenance };
    await this.context.records.put({ operationId: `draft:${id}`, recordId: id, recordType: "working.draft", state: "active", payloadJson: JSON.stringify(baseline), references, ownerIds }); this.drafts.set(id, baseline); for (const state of Object.values(pathStates)) if (state.kind === "regular-file") { this.ownerByHash.delete(state.objectHash); this.sourceByHash.set(state.objectHash, { recordId: id, slot: `draft:${Object.entries(pathStates).find(([, value]) => value === state)?.[0] ?? ""}` }); } return clone(baseline);
  }

  async commitVirtualWrites(branchId: string, expectedWriteRevision: number, files: Record<string, RecoveryState>): Promise<{ status: "committed"; writeRevision: number } | { status: "conflict"; writeRevision: number }> {
    const branch = this.branches.get(branchId); if (!branch) throw new Error(`Working branch not found: ${branchId}`);
    if (branch.writeRevision !== expectedWriteRevision) return { status: "conflict", writeRevision: branch.writeRevision };
    const changes = Object.entries(files).map(([file, state]) => ({ path: normalize(file), state: toKernelState(state), ...(state.kind === "regular-file" && this.ownerByHash.has(state.objectHash) ? { ownerId: this.ownerByHash.get(state.objectHash)! } : {}) }));
    const result = await this.context.client.writeBranch({ operationId: `branch-write:${branchId}:${expectedWriteRevision + 1}:${randomUUID()}`, branchId, expectedWriteRevision, changes });
    if (result.status === "conflict") return { status: "conflict", writeRevision: result.writeRevision };
    for (const [file, state] of Object.entries(files)) { const normalized = normalize(file); if (state.kind === "missing" && !Object.hasOwn(branch.baseState, normalized)) delete branch.deltas[normalized]; else branch.deltas[normalized] = clone(state); if (state.kind === "regular-file") { this.ownerByHash.delete(state.objectHash); this.sourceByHash.set(state.objectHash, { branchId, path: normalized }); } }
    branch.writeRevision = result.writeRevision; branch.root = result.root; branch.updatedAt = nowIso(); this.branches.set(branchId, branch); await this.putMetadata(branch); return { status: "committed", writeRevision: result.writeRevision };
  }
  async commitVirtualWrite(branchId: string, expectedWriteRevision: number, file: string, state: RecoveryState) { return this.commitVirtualWrites(branchId, expectedWriteRevision, { [file]: state }); }

  async publishStates(branchId: string, capturedState: Record<string, RecoveryState>, knownChangedPaths?: string[]): Promise<WorkingResult> {
    const branch = this.branches.get(branchId); if (!branch) throw new Error(`Working branch not found: ${branchId}`);
    const candidates = knownChangedPaths?.map(normalize) ?? [...new Set([...Object.keys(branch.baseState), ...Object.keys(capturedState)])];
    const changedPaths = candidates.filter((file) => !sameState(branch.baseState[file] ?? { kind: "missing" }, capturedState[file] ?? { kind: "missing" })).sort();
    const baseStates = Object.fromEntries(changedPaths.map((file) => [file, branch.baseState[file] ?? { kind: "missing" as const}]));
    const pathStates = Object.fromEntries(changedPaths.map((file) => [file, capturedState[file] ?? { kind: "missing" as const}]));
    const written = changedPaths.length > 0 ? await this.commitVirtualWrites(branchId, branch.writeRevision, pathStates) : { status: "committed" as const, writeRevision: branch.writeRevision };
    if (written.status === "conflict") throw new Error("Working branch changed while publishing result");
    const published = await this.context.client.publishBranch({ operationId: `branch-publish:${branchId}:${branch.headRevision + 1}`, branchId, expectedWriteRevision: written.writeRevision, expectedRoot: branch.root });
    if (asRecord(published).status === "conflict") throw new Error("Working branch publish CAS conflict");
    const revision = Number(asRecord(published).revision); const result: WorkingResult = { resultRevision: revision, branchId, ...(branch.baseRef ? { parentRef: branch.baseRef } : {}), changedPaths, baseStates, pathStates, diffStats: { files: changedPaths.length, insertions: 0, deletions: 0 }, createdAt: nowIso() };
    branch.headRevision = revision; branch.root = String(asRecord(published).root); branch.updatedAt = result.createdAt; this.branches.set(branchId, branch); this.results.set(`${branchId}@${revision}`, result);
    const refs = [
      ...Object.entries(baseStates).flatMap(([file, state]) => state.kind === "regular-file" ? [{ slot: `base:${file}`, objectHash: state.objectHash }] : []),
      ...Object.entries(pathStates).flatMap(([file, state]) => state.kind === "regular-file" ? [{ slot: `result:${file}`, objectHash: state.objectHash }] : []),
    ];
    await this.context.records.put({ operationId: `result:${branchId}:${revision}`, recordId: `working-result:${branchId}@${revision}`, recordType: "working.result", state: "published", branchId, revision, resultRevision: revision, payloadJson: JSON.stringify(result), references: refs });
    return clone(result);
  }
  async publishHeadResult(branchId: string): Promise<WorkingResult> { const states = this.effectiveState(branchId); if (!states) throw new Error(`Working branch not found: ${branchId}`); return this.publishStates(branchId, states); }
  async publishDirectoryResult(branchId: string, directory: string, changedPaths?: string[], options?: { indexModes?: Map<string, string> | Record<string, string>; validateFixedSource?: () => Promise<boolean> }): Promise<WorkingResult> { const captured = await this.captureDirectory(directory, changedPaths, options); if (options?.validateFixedSource && !await options.validateFixedSource()) throw new Error("Working-state source changed while it was being captured"); return this.publishStates(branchId, captured, changedPaths); }
  async captureBranchCandidateIdentity(branchId: string, directory: string, changedPaths: string[]): Promise<string | null> { const captured = await this.captureDirectory(directory, changedPaths); const branch = this.branches.get(branchId); if (!branch) return null; return treeIdentityFromStates({ ...branch.baseState, ...captured }); }
  async captureSeededPathIdentity(directory: string, changedPaths: string[], seed: string): Promise<string> { const captured = await this.captureDirectory(directory, changedPaths); return `sha256-${createHash("sha256").update(seed).update("\0").update(treeIdentityFromStates(captured)).digest("hex")}`; }

  async materializeResult(branchId: string, revision: number, directory: string): Promise<MaterializeResult> { const states = this.resultState(branchId, revision); if (!states) throw new Error(`Working result not found: ${branchId}@${revision}`); return this.materializeStates(states, directory); }
  async materializeStates(states: Record<string, RecoveryState>, directory: string): Promise<MaterializeResult> { return materializeWorkingState({ targetDir: directory, states, readContent: async (state) => state.kind === "regular-file" ? this.getObject(state.objectHash) : null, objectPathFor: () => null, cleanUnreferenced: true }); }
  async directoryMatchesResult(branchId: string, revision: number, directory: string): Promise<boolean> { const expected = this.resultState(branchId, revision); if (!expected) return false; const actual = await this.captureDirectory(directory); const files = new Set([...Object.keys(expected), ...Object.keys(actual)]); return [...files].every((file) => sameState(actual[file] ?? { kind: "missing" }, expected[file] ?? { kind: "missing" })); }

  async deleteBranch(branchId: string): Promise<void> { if (!this.branches.has(branchId)) return; await this.context.client.deleteBranch({ operationId: `branch-delete:${branchId}`, branchId }); await this.context.records.release(`branch-release:${branchId}`, `working-branch:${branchId}`); this.branches.delete(branchId); }
  async deleteDraftBaseline(id: string): Promise<void> { await this.context.records.release(`draft-release:${id}`, id); this.drafts.delete(id); }
  async deleteResult(branchId: string, revision: number): Promise<void> { await this.deleteResults(branchId, [revision]); }
  async deleteResults(branchId: string, revisions: readonly number[]): Promise<number[]> { const removed: number[] = []; for (const revision of revisions) { if (!this.results.has(`${branchId}@${revision}`)) continue; await this.context.records.release(`result-release:${branchId}@${revision}`, `working-result:${branchId}@${revision}`); this.results.delete(`${branchId}@${revision}`); removed.push(revision); } return removed; }
  async reconcileObjectReferences(): Promise<void> { await this.context.client.health({ deep: true }); }
  async listParentVerifications(threadId: string): Promise<ParentVerificationBundle[]> { return (this.parentVerifications.get(threadId) ?? []).map(clone); }
  async listChildVerifications(threadId: string): Promise<ResultVerificationBundle[]> { return (this.verifications.get(threadId) ?? []).map(clone); }
  async listReviewRecords(threadId: string): Promise<ResultReviewRecord[]> { return (this.reviews.get(threadId) ?? []).map(clone); }
  getChildVerification(threadId: string, revision: number): ResultVerificationBundle | null { return (this.verifications.get(threadId) ?? []).find((item) => item.resultRevision === revision) ?? null; }
  getParentVerification(threadId: string, revision?: number): ParentVerificationBundle | null { const list = this.parentVerifications.get(threadId) ?? []; return revision === undefined ? list.at(-1) ?? null : list.find((item) => item.mergedResultRevision === revision) ?? null; }
  getReviewRecord(threadId: string, revision: number): ResultReviewRecord | null { return (this.reviews.get(threadId) ?? []).find((item) => item.resultRevision === revision) ?? null; }
  async putChildVerification(threadId: string, bundle: ResultVerificationBundle): Promise<void> { await this.putVerification("working.verification.child", threadId, bundle.resultRevision, bundle); const list = (this.verifications.get(threadId) ?? []).filter((item) => item.resultRevision !== bundle.resultRevision); this.verifications.set(threadId, [...list, clone(bundle)]); }
  async putParentVerification(threadId: string, bundle: ParentVerificationBundle): Promise<void> { await this.putVerification("working.verification.parent", threadId, bundle.mergedResultRevision, bundle); const list = (this.parentVerifications.get(threadId) ?? []).filter((item) => item.mergedResultRevision !== bundle.mergedResultRevision); this.parentVerifications.set(threadId, [...list, clone(bundle)]); }
  async putReviewRecord(threadId: string, record: ResultReviewRecord): Promise<void> { await this.putVerification("working.review", threadId, record.resultRevision, record); const list = (this.reviews.get(threadId) ?? []).filter((item) => item.resultRevision !== record.resultRevision); this.reviews.set(threadId, [...list, clone(record)]); }
  private async putVerification(recordType: string, threadId: string, revision: number, payload: unknown): Promise<void> { await this.context.records.put({ operationId: `${recordType}:${threadId}:${revision}`, recordId: `${recordType}:${threadId}:${revision}`, recordType, state: "recorded", threadId, resultRevision: revision, payloadJson: JSON.stringify(payload) }); }
}

export interface KernelStorageAdapterOptions {
  client: KernelClient;
  hostId: string;
  hostGeneration?: string;
  resolveWorkspaceRoot: (workspaceId: string) => Promise<string>;
  fileStore?: RecoveryFileStore;
  storageRoot: string;
  resolveActor?: (workspaceId: string, purpose: string) => KernelActorIdentity | Promise<KernelActorIdentity>;
}

export class KernelStorageAdapter {
  readonly client: KernelClient;
  private readonly options: KernelStorageAdapterOptions;
  private readonly grants = new Map<string, Promise<KernelGrantHandle>>();
  constructor(options: KernelStorageAdapterOptions) { this.options = options; this.client = options.client; }
  private grantFor(workspaceId: string, purpose: string): Promise<KernelGrantHandle> {
    const key = `${workspaceId}:${purpose}`;
    const existing = this.grants.get(key); if (existing) return existing;
    const grant = (async () => {
      const actor = this.options.resolveActor ? await this.options.resolveActor(workspaceId, purpose) : { owningWorkspace: workspaceId, executionWorkspace: workspaceId, pathScopes: [""] };
      const capabilities = ["storage.read", "storage.write", "recovery", ...(purpose === "recovery-catalog" ? ["recovery.maintenance", "storage.gc"] : purpose.includes("gc") ? ["storage.gc"] : [])];
      return this.client.issueGrant({ grantId: `product:${this.options.hostId}:${this.options.hostGeneration ?? process.pid}:${workspaceId}:${purpose}`, ...actor, capabilities, pathScopes: actor.pathScopes ?? [""] });
    })();
    this.grants.set(key, grant); return grant;
  }
  async context(workspaceId: string, purpose: string): Promise<KernelStorageContext & { client: KernelScopedClient }> {
    const root = this.options.storageRoot;
    const identity: RecoveryIdentity = { authorityId: this.options.hostId, canonicalRoot: await this.options.resolveWorkspaceRoot(workspaceId), filesystemProfile: process.platform === "win32" ? "windows-local" : `${process.platform}-local`, workspaceId };
    const scoped = this.client.scoped(await this.grantFor(workspaceId, purpose));
    const records = {
      get: (recordId: string) => scoped.getRecord(workspaceId, recordId),
      list: async (input: { recordType?: string; threadId?: string; runId?: string; branchId?: string }) => { const all: KernelRecordResult[] = []; let cursor: number | undefined; do { const page = await scoped.listRecords({ workspaceId, ...input, ...(cursor === undefined ? {} : { cursor }), pageSize: 128 }); all.push(...page.records); cursor = page.nextCursor === null ? undefined : page.nextCursor; } while (cursor !== undefined); return all; },
      put: (input: Omit<Parameters<KernelScopedClient["putRecord"]>[0], "ownerIds" | "references"> & { ownerIds?: string[]; references?: KernelStorageReference[] }) => scoped.putRecord({ ...input, workspaceId, ownerIds: input.ownerIds ?? [], references: input.references ?? [] }),
      release: (operationId: string, recordId: string) => scoped.releaseRecord(operationId, workspaceId, recordId),
    };
    return { identity, root, fileStore: this.options.fileStore ?? createRecoveryFileStore(), resourceOperationGate: { run: async (_resources, operation) => operation() }, records, client: scoped };
  }
  async dispose(): Promise<void> {
    const grants = await Promise.allSettled([...this.grants.values()].map(async (grant) => this.client.revokeGrant((await grant).grantId)));
    this.grants.clear();
    const failures = grants.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failures.length > 0) throw new Error(`One or more kernel storage grants failed to revoke: ${failures.map((failure) => String(failure.reason)).join("; ")}`);
  }
}

export const createKernelWorkspaceWorkingStateAccess = (adapter: KernelStorageAdapter, catalogBackend?: RecoveryCatalogBackend): WorkspaceWorkingStateAccess => {
  // Keep one short-lived root projection per Host/workspace instead of
  // expanding every branch on every consumer callback. Durable truth remains
  // the kernel root/revision; this cache is rebuilt after a Host restart.
  const stores = new Map<string, Promise<KernelWorkingStateStore>>();
  const storeFor = (workspaceId: string): Promise<KernelWorkingStateStore> => {
    const existing = stores.get(workspaceId);
    if (existing) return existing;
    const opening = (async () => {
      const context = await adapter.context(workspaceId, "working-state-open");
      return KernelWorkingStateStore.open(adapter, context);
    })();
    stores.set(workspaceId, opening);
    return opening;
  };
  return {
    withStore: async (workspaceId, purpose, operation, _mode: Mode = "exclusive") => {
      const store = await storeFor(workspaceId);
      const context = await adapter.context(workspaceId, purpose);
      const database = catalogBackend
        ? await catalogBackend.open(workspaceId, context.root, { create: true, purpose })
        : null;
      try {
        const scopedContext = database ? { ...context, database } : context;
        return operation(store as never, scopedContext as never);
      } finally {
        if (database) await catalogBackend!.close(database);
      }
    },
  };
};
