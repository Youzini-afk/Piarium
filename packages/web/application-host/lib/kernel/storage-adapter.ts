import { randomUUID, createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { KernelBranchReadResult, KernelBranchState, KernelEntry, KernelRecordResult } from "./protocol.generated.js";
import type { KernelClient, KernelGrantHandle, KernelScopedClient } from "./kernel-client.js";
import type { SqliteDatabase } from "../recovery/journal-catalog.js";
import type { WorkspaceRecoveryEngine } from "../recovery/engine.js";
import type { RecoveryDurableOperationPort } from "../recovery/journal-engine.js";
import { type RecoveryFileStore, type RecoveryIdentity } from "../recovery/journal-files.js";
import { materializeWorkingState, type MaterializeResult } from "../harness/working-state/materializer.js";
import { applyIndexModes } from "../harness/working-state/git-index-mode.js";
import { sameState } from "../recovery/journal-files.js";
import type {
  DraftBaseline,
  DraftBaselinePathProvenance,
  ParentVerificationBundle,
  RecoveryState,
  ResultReviewRecord,
  ResultVerificationBundle,
  WorkingBranch,
  WorkingBranchRoot,
  WorkingResult,
  WorkingStatePin,
  WorkingStateContentSource,
  WorkingStateReadOptions,
  WorkingStateRootStore,
  WorkingStateTreeEntry,
  WorkingStateTreeRead,
  WorkspaceWorkingStateRootAccess,
} from "../harness/working-state/types.js";
import { type CreateDraftBaselinePath, type WorkspaceWorkingStateAccess } from "../harness/working-state/working-state-store.js";
import { assertVirtualWriteTree } from "../harness/working-state/virtual-write-tree.js";

type Mode = "exclusive" | "shared";

export interface KernelActorIdentity {
  authorityInstanceId?: string;
  workerId?: string;
  workerGeneration?: number;
  sessionId?: string;
  threadId?: string;
  runId?: string;
  owningWorkspace: string;
  executionWorkspace?: string;
  pathScopes?: string[];
  capabilities?: string[];
}

export interface KernelStorageReference {
  slot: string;
  objectHash: string;
}

export interface KernelStorageContext {
  client: KernelScopedClient;
  /** Kept only for local test-only recovery adapters. Production kernel paths do not populate it. */
  database?: SqliteDatabase;
  actor?: KernelActorIdentity;
  identity: RecoveryIdentity;
  root: string;
  fileStore: RecoveryFileStore;
  resourceOperationGate: { run<T>(resources: readonly unknown[], operation: () => Promise<T>): Promise<T> };
  collectUnreachableObjects?: () => Promise<{ byteLengthReclaimed: number; objectsDeleted: number }>;
  durableRecoveryStore?: RecoveryDurableOperationPort;
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
      expectedRecordRevision?: number;
    }): Promise<KernelRecordResult>;
    release(operationId: string, recordId: string): Promise<Record<string, unknown>>;
  };
  working: {
    resultPut(input: Omit<Parameters<KernelScopedClient["workingResultPut"]>[0], "workspaceId"> & { workspaceId?: string }): Promise<Record<string, unknown>>;
    resultGet(recordId: string): Promise<Record<string, unknown> | null>;
    resultList(branchId?: string): Promise<Record<string, unknown>[]>;
    resultRelease(operationId: string, recordId: string): Promise<Record<string, unknown>>;
    draftPut(input: Omit<Parameters<KernelScopedClient["workingDraftPut"]>[0], "workspaceId"> & { workspaceId?: string }): Promise<Record<string, unknown>>;
    draftGet(recordId: string): Promise<Record<string, unknown> | null>;
    draftList(): Promise<Record<string, unknown>[]>;
    draftRelease(operationId: string, recordId: string): Promise<Record<string, unknown>>;
    verificationPut(input: Omit<Parameters<KernelScopedClient["workingVerificationPut"]>[0], "workspaceId"> & { workspaceId?: string }): Promise<Record<string, unknown>>;
    verificationList(threadId: string, kind: "child" | "parent"): Promise<Record<string, unknown>[]>;
    verificationRelease(operationId: string, recordId: string): Promise<Record<string, unknown>>;
    reviewPut(input: Omit<Parameters<KernelScopedClient["workingReviewPut"]>[0], "workspaceId"> & { workspaceId?: string }): Promise<Record<string, unknown>>;
    reviewList(threadId: string): Promise<Record<string, unknown>[]>;
    reviewRelease(operationId: string, recordId: string): Promise<Record<string, unknown>>;
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

const normalizeViewPath = (value: string): string => {
  const raw = value.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!raw || raw === ".") return "";
  return normalize(raw);
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

const checkRead = (options?: { signal?: AbortSignal; deadlineAt?: number }): void => {
  options?.signal?.throwIfAborted();
  if (options?.deadlineAt !== undefined && Date.now() >= options.deadlineAt) {
    throw new DOMException("Explore query deadline exceeded", "AbortError");
  }
};

const transientStateIdentity = (states: Record<string, RecoveryState>): string => {
  const hash = createHash("sha256");
  for (const [path, state] of Object.entries(states).sort(([left], [right]) => left.localeCompare(right))) {
    hash.update(path).update("\0").update(JSON.stringify(state)).update("\0");
  }
  return `sha256-${hash.digest("hex")}`;
};

const compactTreeWrites = (writes: Record<string, RecoveryState>): Record<string, RecoveryState> => {
  const entries = Object.entries(writes).sort(([left], [right]) => left.localeCompare(right));
  return Object.fromEntries(entries.filter(([path]) => {
    let parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    while (parent) {
      const ancestor = writes[parent];
      if (ancestor && ancestor.kind !== "directory") return false;
      parent = parent.includes("/") ? parent.slice(0, parent.lastIndexOf("/")) : "";
    }
    return true;
  }));
};

const branchMissing = (error: unknown): boolean => /branch not found/i.test(error instanceof Error ? error.message : String(error));
const pinAlreadyReleasedWithGrant = (error: unknown): boolean => /grant is revoked|grant.*stale/i.test(error instanceof Error ? error.message : String(error));

interface KernelPinTreeRead {
  pinId: string;
  branchId: string;
  workspaceId: string;
  revision: number;
  writeRevision: number;
  view: "current" | "revision";
  root: string;
  entries: KernelEntry[];
  nextCursor?: number | null;
}

const parsePinTreeRead = (value: Record<string, unknown>): KernelPinTreeRead => {
  const view = value.view;
  const entries = Array.isArray(value.entries) ? value.entries.map((item) => {
    const entry = asRecord(item);
    if (typeof entry.path !== "string" || !entry.state || typeof entry.state !== "object" || Array.isArray(entry.state)) {
      throw new Error("Kernel returned an invalid pinned tree entry");
    }
    return { path: entry.path, state: entry.state as KernelBranchState };
  }) : [];
  if (typeof value.pinId !== "string" || typeof value.branchId !== "string" || typeof value.workspaceId !== "string"
    || typeof value.root !== "string" || (view !== "current" && view !== "revision")
    || !Number.isSafeInteger(value.revision) || !Number.isSafeInteger(value.writeRevision)) {
    throw new Error("Kernel returned an invalid pinned tree read");
  }
  return {
    pinId: value.pinId,
    branchId: value.branchId,
    workspaceId: value.workspaceId,
    revision: Number(value.revision),
    writeRevision: Number(value.writeRevision),
    view,
    root: value.root,
    entries,
    ...(value.nextCursor === undefined || value.nextCursor === null ? {} : { nextCursor: Number(value.nextCursor) }),
  };
};

/** Rust-kernel root/path authority. It retains no expanded branch or result tree. */
export class KernelWorkingStateRootStore implements WorkingStateRootStore {
  private readonly ownerByHash = new Map<string, string>();
  private readonly sourceByHash = new Map<string, { branchId?: string; path?: string; revision?: number; ownerId?: string }>();

  constructor(private readonly context: KernelStorageContext) {}

  private async metadata(branchId: string): Promise<{ baseRef?: string; draftBasePaths: string[]; captureScopes: string[]; createdAt: string; updatedAt: string }> {
    const record = await this.context.records.get(`working-branch:${branchId}`);
    const payload = record ? asRecord(parsePayload(record)) : {};
    const createdAt = typeof payload.createdAt === "string" ? payload.createdAt : "";
    return {
      ...(typeof payload.baseRef === "string" ? { baseRef: payload.baseRef } : {}),
      draftBasePaths: Array.isArray(payload.draftBasePaths) ? payload.draftBasePaths.filter((item): item is string => typeof item === "string") : [],
      captureScopes: Array.isArray(payload.captureScopes) ? payload.captureScopes.filter((item): item is string => typeof item === "string") : [],
      createdAt,
      updatedAt: typeof payload.updatedAt === "string" ? payload.updatedAt : createdAt,
    };
  }

  private async readRoot(branchId: string, revision: number | undefined, signal?: AbortSignal): Promise<KernelBranchReadResult | null> {
    try {
      return await this.context.client.readBranch({ branchId, ...(revision === undefined ? {} : { revision }) }, signal);
    } catch (error) {
      if (branchMissing(error)) return null;
      throw error;
    }
  }

  async getBranchRoot(branchId: string, options?: { signal?: AbortSignal }): Promise<WorkingBranchRoot | null> {
    const [current, base, metadata] = await Promise.all([
      this.readRoot(branchId, undefined, options?.signal),
      this.readRoot(branchId, 0, options?.signal),
      this.metadata(branchId),
    ]);
    if (!current || !base) return null;
    return {
      branchId,
      workspaceId: current.workspaceId,
      ...metadata,
      baseRoot: base.root,
      root: current.root,
      headRevision: current.headRevision,
      writeRevision: current.writeRevision,
    };
  }

  async readStateSlice(branchId: string, paths: readonly string[], options?: WorkingStateReadOptions): Promise<Record<string, RecoveryState> | null> {
    checkRead(options);
    const read = await this.context.client.readBranch({
      branchId,
      ...(options?.revision === undefined ? {} : { revision: options.revision }),
      paths: paths.map(normalizeViewPath),
      includeEntries: true,
    }, options?.signal);
    const result: Record<string, RecoveryState> = {};
    for (const entry of read.entries) {
      checkRead(options);
      result[normalize(entry.path)] = fromKernelState(entry.state);
    }
    return result;
  }

  async getResult(branchId: string, revision: number, options?: { signal?: AbortSignal }): Promise<WorkingResult | null> {
    const record = await this.context.working.resultGet(`working-result:${branchId}@${revision}`);
    if (!record) return null;
    const document = asRecord(record.record);
    if (document.branchId !== branchId || Number(document.resultRevision) !== revision || typeof document.root !== "string") return null;
    const changedPaths = Array.isArray(document.changedPaths) ? document.changedPaths.filter((value): value is string => typeof value === "string") : [];
    const [base, fixed] = await Promise.all([
      this.context.client.readBranch({ branchId, revision: 0, paths: changedPaths, includeEntries: true }, options?.signal),
      this.context.client.readBranch({ branchId, revision, paths: changedPaths, includeEntries: true }, options?.signal),
    ]);
    const states = (page: KernelBranchReadResult): Record<string, RecoveryState> => Object.fromEntries(page.entries.map((entry) => [normalize(entry.path), fromKernelState(entry.state)]));
    for (const [file, state] of Object.entries(states(fixed))) if (state.kind === "regular-file") this.sourceByHash.set(state.objectHash, { branchId, path: file, revision });
    for (const [file, state] of Object.entries(states(base))) if (state.kind === "regular-file") this.sourceByHash.set(state.objectHash, { branchId, path: file, revision: 0 });
    return {
      resultRevision: revision,
      branchId,
      ...(typeof document.parentRef === "string" ? { parentRef: document.parentRef } : {}),
      changedPaths,
      baseStates: states(base),
      pathStates: states(fixed),
      diffStats: asRecord(document.diffStats) as unknown as WorkingResult["diffStats"],
      createdAt: typeof document.createdAt === "string" ? document.createdAt : nowIso(),
      root: document.root,
    };
  }

  private async selected(branchId: string, paths: readonly string[], revision: number | undefined, signal?: AbortSignal): Promise<KernelBranchReadResult | null> {
    try {
      return await this.context.client.readBranch({
        branchId,
        ...(revision === undefined ? {} : { revision }),
        paths: [...paths],
      }, signal);
    } catch (error) {
      if (branchMissing(error)) return null;
      throw error;
    }
  }

  private async selectedPin(pinId: string, paths: readonly string[], signal?: AbortSignal): Promise<KernelPinTreeRead> {
    return parsePinTreeRead(await this.context.client.readPin({ pinId, paths: [...paths] }, signal));
  }

  private contentSource(branchId: string, path: string, revision: number | undefined, pin?: WorkingStateReadOptions["pin"]): WorkingStateContentSource {
    return pin
      ? { kind: "pin", pinId: pin.pinId, path }
      : { kind: "branch", branchId, path, ...(revision === undefined ? {} : { revision }) };
  }

  private origin(path: string, state: RecoveryState, base: RecoveryState, branch: WorkingBranchRoot): "base" | "delta" | "draft-base" {
    if (!sameState(state, base)) return "delta";
    return branch.draftBasePaths.includes(path) ? "draft-base" : "base";
  }

  async readPath(branchId: string, rawPath: string, options?: WorkingStateReadOptions): Promise<WorkingStateTreeEntry | null> {
    checkRead(options);
    const path = normalizeViewPath(rawPath);
    const revision = options?.revision;
    const branch = options?.pin?.branch ?? await this.getBranchRoot(branchId, options?.signal ? { signal: options.signal } : undefined);
    if (!branch) return null;
    const [current, base] = await Promise.all([
      options?.pin
        ? this.selectedPin(options.pin.pinId, path ? [path] : [], options.signal)
        : path ? this.selected(branchId, [path], revision, options?.signal) : this.readRoot(branchId, revision, options?.signal),
      path ? this.selected(branchId, [path], 0, options?.signal) : this.readRoot(branchId, 0, options?.signal),
    ]);
    if (!current) return null;
    if (options?.pin && current.root !== options.pin.root) {
      throw new Error(`Working-state pin root mismatch for ${branchId}@${options.pin.revision}`);
    }
    const state = path ? fromKernelState(current.entries[0]?.state ?? { kind: "missing" }) : { kind: "directory" as const };
    const baseState = base
      ? path ? fromKernelState(base.entries[0]?.state ?? { kind: "missing" }) : { kind: "directory" as const }
      : state;
    const origin = this.origin(path, state, baseState, branch);
    return {
      path,
      state,
      origin,
      root: current.root,
      viewRevision: options?.pin?.writeRevision ?? options?.revision ?? current.writeRevision,
      ...(state.kind === "regular-file" ? { contentSource: this.contentSource(branchId, path, revision, options?.pin) } : {}),
    };
  }

  private async pagedEntries(
    branchId: string,
    revision: number | undefined,
    roots: readonly string[],
    options?: { signal?: AbortSignal; deadlineAt?: number },
  ): Promise<{ read: KernelBranchReadResult; entries: KernelEntry[] } | null> {
    const entries: KernelEntry[] = [];
    let cursor: number | undefined;
    let first: KernelBranchReadResult | undefined;
    do {
      checkRead(options);
      let page: KernelBranchReadResult;
      try {
        page = await this.context.client.readBranch({
          branchId,
          ...(revision === undefined ? {} : { revision }),
          includeEntries: true,
          ...(cursor === undefined ? {} : { cursor }),
          pageSize: 256,
        }, options?.signal);
      } catch (error) {
        if (branchMissing(error)) return null;
        throw error;
      }
      first ??= page;
      if (page.root !== first.root) throw new Error(`Working branch ${branchId} changed while listing paths`);
      for (const entry of page.entries) {
        const path = normalize(entry.path);
        if (roots.some((root) => !root || path === root || path.startsWith(`${root}/`) || root.startsWith(`${path}/`))) {
          entries.push({ path, state: entry.state });
        }
      }
      cursor = page.nextCursor === null || page.nextCursor === undefined ? undefined : page.nextCursor;
    } while (cursor !== undefined);
    return first ? { read: first, entries } : null;
  }

  private async pagedPinEntries(
    pinId: string,
    roots: readonly string[],
    options?: { signal?: AbortSignal; deadlineAt?: number },
  ): Promise<{ read: KernelPinTreeRead; entries: KernelEntry[] }> {
    const entries: KernelEntry[] = [];
    let cursor: number | undefined;
    let first: KernelPinTreeRead | undefined;
    do {
      checkRead(options);
      const page = parsePinTreeRead(await this.context.client.readPin({
        pinId,
        includeEntries: true,
        ...(cursor === undefined ? {} : { cursor }),
        pageSize: 256,
      }, options?.signal));
      first ??= page;
      if (page.root !== first.root) throw new Error(`Working-state pin ${pinId} changed identity`);
      for (const entry of page.entries) {
        const path = normalize(entry.path);
        if (roots.some((root) => !root || path === root || path.startsWith(`${root}/`) || root.startsWith(`${path}/`))) {
          entries.push({ path, state: entry.state });
        }
      }
      cursor = page.nextCursor === null || page.nextCursor === undefined ? undefined : page.nextCursor;
    } while (cursor !== undefined);
    if (!first) throw new Error(`Working-state pin is unavailable: ${pinId}`);
    return { read: first, entries };
  }

  async listPaths(branchId: string, rawRoots: readonly string[], options?: WorkingStateReadOptions): Promise<WorkingStateTreeRead | null> {
    const roots = (rawRoots.length ? rawRoots : [""]).map(normalizeViewPath);
    const revision = options?.revision;
    const branch = options?.pin?.branch ?? await this.getBranchRoot(branchId, options?.signal ? { signal: options.signal } : undefined);
    if (!branch) return null;
    const [current, base] = await Promise.all([
      options?.pin ? this.pagedPinEntries(options.pin.pinId, roots, options) : this.pagedEntries(branchId, revision, roots, options),
      this.pagedEntries(branchId, 0, roots, options),
    ]);
    if (!current) return null;
    if (options?.pin && current.read.root !== options.pin.root) {
      throw new Error(`Working-state pin root mismatch for ${branchId}@${options.pin.revision}`);
    }
    const baseByPath = new Map((base?.entries ?? current.entries).map((entry) => [entry.path, fromKernelState(entry.state)]));
    return {
      branch,
      root: current.read.root,
      viewRevision: options?.pin?.writeRevision ?? options?.revision ?? current.read.writeRevision,
      entries: current.entries.map((entry) => {
        const state = fromKernelState(entry.state);
        const origin = this.origin(entry.path, state, baseByPath.get(entry.path) ?? { kind: "missing" }, branch);
        return {
          path: entry.path,
          state,
          origin,
          ...(state.kind === "regular-file" ? { contentSource: this.contentSource(branchId, entry.path, revision, options?.pin) } : {}),
        };
      }),
    };
  }

  async readContent(entry: WorkingStateTreeEntry, options?: { offset?: number; length?: number; signal?: AbortSignal }): Promise<Buffer | null> {
    if (entry.state.kind !== "regular-file" || !entry.contentSource) return null;
    const source = entry.contentSource.kind === "pin"
      ? { pinId: entry.contentSource.pinId, path: entry.contentSource.path }
      : { branchId: entry.contentSource.branchId, path: entry.contentSource.path, ...(entry.contentSource.revision === undefined ? {} : { revision: entry.contentSource.revision }) };
    try {
      const slice = await this.context.client.getBlob(entry.state.objectHash, source, {
        ...(options?.offset === undefined ? {} : { offset: options.offset }),
        ...(options?.length === undefined ? {} : { length: options.length }),
        ...(options?.signal ? { signal: options.signal } : {}),
      });
      return Buffer.from(slice.bytesBase64, "base64");
    } catch (error) {
      if ((error as { code?: string }).code === "object-not-found") return null;
      throw error;
    }
  }

  async getObject(hash: string): Promise<Buffer | null> {
    const ownerId = this.ownerByHash.get(hash);
    const source = this.sourceByHash.get(hash);
    if (!ownerId && !source?.branchId) return null;
    const slice = await this.context.client.getBlob(hash, ownerId ? { ownerId } : { branchId: source!.branchId!, path: source!.path!, ...(source!.revision === undefined ? {} : { revision: source!.revision }) });
    return Buffer.from(slice.bytesBase64, "base64");
  }

  async pinBranch(branchId: string, options?: { revision?: number; signal?: AbortSignal }): Promise<WorkingStatePin> {
    const branch = await this.getBranchRoot(branchId, options?.signal ? { signal: options.signal } : undefined);
    if (!branch) throw new Error(`Working branch not found: ${branchId}`);
    const expected = options?.revision === undefined ? branch : null;
    const operationId = `branch-query-pin:${branchId}:${randomUUID()}`;
    const raw = await this.context.client.pinBranch({
      operationId,
      branchId,
      ...(options?.revision === undefined
        ? { expectedWriteRevision: expected!.writeRevision, expectedRoot: expected!.root }
        : { revision: options.revision }),
    }, options?.signal);
    if (raw.status === "conflict") {
      throw new Error(`Working branch changed while pinning ${branchId}; current write revision is ${String(raw.writeRevision)}`);
    }
    const pinId = String(raw.pinId ?? "");
    const workspaceId = String(raw.workspaceId ?? "");
    const revision = Number(raw.revision);
    const view = raw.view;
    const rawWriteRevision = Number(raw.writeRevision);
    const writeRevision = view === "current" ? rawWriteRevision : revision;
    const root = String(raw.root ?? "");
    if (!pinId || !workspaceId || !Number.isSafeInteger(revision) || revision < 0 || !Number.isSafeInteger(writeRevision)
      || writeRevision < 0 || (view !== "current" && view !== "revision") || !root) {
      throw new Error(`Kernel returned an invalid pin for ${branchId}`);
    }
    if (expected && (root !== expected.root || writeRevision !== expected.writeRevision || view !== "current")) {
      await this.context.client.unpinBranch({ operationId: `branch-query-unpin-mismatch:${branchId}:${pinId}`, branchId, pinId });
      throw new Error(`Kernel cannot pin unpublished working root ${branchId}@${expected.writeRevision}`);
    }
    let releasePromise: Promise<void> | undefined;
    return {
      pinId,
      branchId,
      workspaceId,
      revision,
      writeRevision,
      root,
      branch,
      release: async () => {
        releasePromise ??= this.context.client
          .unpinBranch({ operationId: `branch-query-unpin:${branchId}:${pinId}`, branchId, pinId })
          .catch((error) => {
            if (!pinAlreadyReleasedWithGrant(error)) throw error;
          })
          .then(() => undefined);
        await releasePromise;
      },
    };
  }

  async putObject(bytes: Buffer): Promise<{ hash: string; byteLength: number }> {
    const value = await this.context.client.putBlob(bytes, `blob:${randomUUID()}`);
    this.ownerByHash.set(value.hash, value.ownerId);
    return { hash: value.hash, byteLength: value.byteLength };
  }

  async commitVirtualWrites(branchId: string, expectedWriteRevision: number, files: Record<string, RecoveryState>): Promise<{ status: "committed"; writeRevision: number } | { status: "conflict"; writeRevision: number }> {
    const normalized = Object.fromEntries(Object.entries(files).map(([file, state]) => [normalize(file), state]));
    const ancestorPaths = new Set<string>();
    for (const file of Object.keys(normalized)) {
      let parent = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "";
      while (parent) {
        ancestorPaths.add(parent);
        parent = parent.includes("/") ? parent.slice(0, parent.lastIndexOf("/")) : "";
      }
    }
    const selectedPaths = [...new Set([...Object.keys(normalized), ...ancestorPaths])];
    const [currentRead, baseRead] = await Promise.all([
      this.selected(branchId, selectedPaths, undefined),
      this.selected(branchId, selectedPaths, 0),
    ]);
    if (!currentRead || !baseRead) throw new Error(`Working branch not found: ${branchId}`);
    if (currentRead.writeRevision !== expectedWriteRevision) return { status: "conflict", writeRevision: currentRead.writeRevision };
    const current = Object.fromEntries(currentRead.entries.map((entry) => [normalize(entry.path), fromKernelState(entry.state)]));
    const base = Object.fromEntries(baseRead.entries.map((entry) => [normalize(entry.path), fromKernelState(entry.state)]));
    assertVirtualWriteTree(current, normalized);
    const closed = { ...normalized };
    for (const [file, state] of Object.entries(normalized)) {
      if (state.kind === "missing") continue;
      let parent = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "";
      while (parent) {
        if (!closed[parent] && !current[parent]) {
          const baseParent = base[parent];
          closed[parent] = baseParent?.kind === "directory" ? baseParent : { kind: "directory" };
        }
        parent = parent.includes("/") ? parent.slice(0, parent.lastIndexOf("/")) : "";
      }
    }
    const committedWrites = compactTreeWrites(closed);
    const retainedHashes = new Set(Object.values(committedWrites).flatMap((state) => (
      state.kind === "regular-file" ? [state.objectHash] : []
    )));
    for (const state of Object.values(normalized)) {
      if (state.kind !== "regular-file" || retainedHashes.has(state.objectHash)) continue;
      const ownerId = this.ownerByHash.get(state.objectHash);
      if (!ownerId) continue;
      await this.context.client.releaseBlob(ownerId);
      this.ownerByHash.delete(state.objectHash);
    }
    const changes = Object.entries(committedWrites).map(([path, state]) => ({
      path,
      state: toKernelState(state),
      ...(state.kind === "regular-file" && this.ownerByHash.has(state.objectHash) ? { ownerId: this.ownerByHash.get(state.objectHash)! } : {}),
    }));
    const result = await this.context.client.writeBranch({ operationId: `branch-write:${branchId}:${expectedWriteRevision + 1}:${randomUUID()}`, branchId, expectedWriteRevision, changes });
    if (result.status === "committed") {
      for (const state of Object.values(committedWrites)) if (state.kind === "regular-file") this.ownerByHash.delete(state.objectHash);
    }
    return { status: result.status, writeRevision: result.writeRevision };
  }

  async materializeResult(branchId: string, revision: number, directory: string): Promise<MaterializeResult> {
    const read = await this.listPaths(branchId, [""], { revision });
    if (!read) throw new Error(`Working result not found: ${branchId}@${revision}`);
    const entries = new Map(read.entries.map((entry) => [entry.state, entry]));
    return materializeWorkingState({
      targetDir: directory,
      states: Object.fromEntries(read.entries.map((entry) => [entry.path, entry.state])),
      readContent: async (state) => {
        const entry = entries.get(state);
        return entry ? this.readContent(entry) : null;
      },
      objectPathFor: () => null,
      cleanUnreferenced: true,
    });
  }

  async materializePin(pin: WorkingStatePin, directory: string): Promise<MaterializeResult> {
    const read = await this.listPaths(pin.branchId, [""], { pin });
    if (!read) throw new Error(`Working-state pin is unavailable: ${pin.pinId}`);
    const entries = new Map(read.entries.map((entry) => [entry.state, entry]));
    return materializeWorkingState({
      targetDir: directory,
      states: Object.fromEntries(read.entries.map((entry) => [entry.path, entry.state])),
      readContent: async (state) => {
        const entry = entries.get(state);
        return entry ? this.readContent(entry) : null;
      },
      objectPathFor: () => null,
      cleanUnreferenced: true,
    });
  }

  private async captureDirectory(directory: string, relativePaths?: string[], options?: { signal?: AbortSignal; onProgress?: (done: number, total: number) => void; store?: boolean; indexModes?: Map<string, string> | Record<string, string> }): Promise<Record<string, RecoveryState>> {
    const files = relativePaths?.map(normalize) ?? await this.scanDirectory(directory);
    const result: Record<string, RecoveryState> = {};
    let done = 0;
    for (const file of files) {
      options?.signal?.throwIfAborted();
      const captured = await this.context.fileStore.captureState({ ...this.context.identity, canonicalRoot: directory }, this.context.root, file, { store: false });
      let state = captured.state;
      if (state.kind === "regular-file" && options?.store !== false) {
        const object = await this.putObject(await fs.promises.readFile(path.join(directory, ...file.split("/"))));
        state = { ...state, objectHash: object.hash, byteLength: object.byteLength };
      }
      result[file] = state;
      done += 1;
      options?.onProgress?.(done, files.length);
    }
    return applyIndexModes(result, options?.indexModes);
  }

  private async scanDirectory(directory: string, base = directory): Promise<string[]> {
    const output: string[] = [];
    for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === ".piarium") continue;
      const absolute = path.join(directory, entry.name);
      const relative = normalize(path.relative(base, absolute));
      output.push(relative);
      if (entry.isDirectory()) output.push(...await this.scanDirectory(absolute, base));
    }
    return output.sort();
  }

  private async publishCaptured(branchId: string, captured: Record<string, RecoveryState>, changedPaths?: string[]): Promise<WorkingResult> {
    const branch = await this.getBranchRoot(branchId);
    if (!branch) throw new Error(`Working branch not found: ${branchId}`);
    const candidates = (changedPaths?.map(normalize) ?? Object.keys(captured).map(normalize)).sort();
    const [base, current] = await Promise.all([
      this.context.client.readBranch({ branchId, revision: 0, paths: candidates, includeEntries: true }),
      this.context.client.readBranch({ branchId, paths: candidates, includeEntries: true }),
    ]);
    const states = (page: KernelBranchReadResult): Record<string, RecoveryState> => Object.fromEntries(page.entries.map((entry) => [normalize(entry.path), fromKernelState(entry.state)]));
    const baseStates = states(base);
    const currentStates = states(current);
    const changed = candidates.filter((file) => !sameState(baseStates[file] ?? { kind: "missing" }, captured[file] ?? currentStates[file] ?? { kind: "missing" }));
    const writes = Object.fromEntries(candidates.filter((file) => !sameState(currentStates[file] ?? { kind: "missing" }, captured[file] ?? { kind: "missing" })).map((file) => [file, captured[file] ?? { kind: "missing" as const}]));
    if (Object.keys(writes).length > 0) {
      const committed = await this.commitVirtualWrites(branchId, branch.writeRevision, writes);
      if (committed.status === "conflict") throw new Error(`Working branch changed while publishing result: ${branchId}`);
    }
    const published = await this.context.client.publishBranch({ operationId: `branch-publish:${branchId}:${branch.headRevision + 1}`, branchId, expectedWriteRevision: (await this.getBranchRoot(branchId))!.writeRevision, expectedRoot: (await this.getBranchRoot(branchId))!.root });
    const revision = Number(published.revision);
    const root = String(published.root ?? "");
    if (!Number.isSafeInteger(revision) || revision <= 0 || !root) throw new Error("Kernel returned an invalid published result identity");
    const pathStates = Object.fromEntries(changed.map((file) => [file, captured[file] ?? { kind: "missing" as const }]));
    const result: WorkingResult = { resultRevision: revision, branchId, changedPaths: changed, baseStates: Object.fromEntries(changed.map((file) => [file, baseStates[file] ?? { kind: "missing" as const }])), pathStates, diffStats: { files: changed.length, insertions: 0, deletions: 0 }, createdAt: nowIso(), root };
    const references = [
      ...Object.entries(result.baseStates).flatMap(([file, state]) => state.kind === "regular-file" ? [{ slot: `base:${file}`, objectHash: state.objectHash }] : []),
      ...Object.entries(result.pathStates).flatMap(([file, state]) => state.kind === "regular-file" ? [{ slot: `result:${file}`, objectHash: state.objectHash }] : []),
    ];
    await this.context.working.resultPut({ operationId: `result:${branchId}:${revision}`, recordId: `working-result:${branchId}@${revision}`, branchId, resultRevision: revision, root, changedPaths: changed, diffStats: result.diffStats, createdAt: result.createdAt, document: { resultRevision: revision, branchId, changedPaths: changed, diffStats: result.diffStats, createdAt: result.createdAt, root }, ownerIds: [], references });
    return result;
  }

  async publishHeadResult(branchId: string): Promise<WorkingResult> {
    const branch = await this.getBranchRoot(branchId);
    if (!branch) throw new Error(`Working branch not found: ${branchId}`);
    const diff = asRecord(await this.context.client.diffRoots({ leftRoot: branch.baseRoot, rightRoot: branch.root }));
    const changedPaths = [
      ...(Array.isArray(diff.added) ? diff.added : []),
      ...(Array.isArray(diff.removed) ? diff.removed : []),
      ...(Array.isArray(diff.changed) ? diff.changed : []),
    ].filter((value): value is string => typeof value === "string").map(normalize);
    const read = await this.context.client.readBranch({ branchId, paths: changedPaths, includeEntries: true });
    return this.publishCaptured(branchId, Object.fromEntries(read.entries.map((entry) => [normalize(entry.path), fromKernelState(entry.state)])), changedPaths);
  }

  async publishDirectoryResult(branchId: string, directory: string, changedPaths?: string[], options?: { indexModes?: Map<string, string> | Record<string, string>; validateFixedSource?: () => Promise<boolean> }): Promise<WorkingResult> {
    const captured = await this.captureDirectory(directory, changedPaths, options);
    if (options?.validateFixedSource && !await options.validateFixedSource()) throw new Error("Working-state source changed while it was being captured");
    return this.publishCaptured(branchId, captured, changedPaths);
  }

  async captureBranchCandidateIdentity(branchId: string, directory: string, changedPaths: string[]): Promise<string | null> {
    const branch = await this.getBranchRoot(branchId);
    if (!branch) return null;
    const hash = createHash("sha256");
    for (const file of [...new Set(changedPaths.map(normalize))].sort()) {
      const captured = await this.context.fileStore.captureState({ ...this.context.identity, canonicalRoot: directory }, this.context.root, file, { store: false });
      hash.update(file).update("\0").update(JSON.stringify(captured.state)).update("\0");
    }
    hash.update(branch.root);
    return `sha256-${hash.digest("hex")}`;
  }
}

/**
 * Compatibility adapter for consumers that have not yet moved to the async root API.
 * It is intentionally callback-scoped and is not a storage authority. Production paths that have
 * migrated use `withBranchStore`; this adapter remains only for the bounded migration surface.
 */
class KernelWorkingStateCompatibilityAdapter {
  private readonly branches = new Map<string, BranchProjection>();
  private readonly results = new Map<string, WorkingResult>();
  private readonly drafts = new Map<string, DraftBaseline>();
  private readonly verifications = new Map<string, ResultVerificationBundle[]>();
  private readonly parentVerifications = new Map<string, ParentVerificationBundle[]>();
  private readonly reviews = new Map<string, ResultReviewRecord[]>();
  private readonly ownerByHash = new Map<string, string>();
  private readonly sourceByHash = new Map<string, { branchId?: string; path?: string; revision?: number; recordId?: string; slot?: string; ownerId?: string }>();
  private readonly fileStore: RecoveryFileStore;

  private constructor(private readonly context: KernelStorageContext) {
    this.fileStore = context.fileStore;
  }

  static async open(context: KernelStorageContext): Promise<KernelWorkingStateCompatibilityAdapter> {
    const store = new KernelWorkingStateCompatibilityAdapter(context);
    const snapshot = await context.client.snapshot(context.identity.workspaceId);
    const branches = Array.isArray(asRecord(snapshot).branches) ? asRecord(snapshot).branches as unknown[] : [];
    for (const item of branches) await store.loadBranch(asRecord(item));
    const typedRecord = (record: Record<string, unknown>): KernelRecordResult => ({
      recordId: String(record.recordId ?? ""), workspaceId: String(record.workspaceId ?? context.identity.workspaceId),
      recordType: "working.record", state: "recorded", recordRevision: Number(record.recordRevision ?? 1),
      payloadJson: JSON.stringify(record.record ?? {}), references: Array.isArray(record.references) ? record.references as KernelRecordResult["references"] : [],
      createdAt: 0, updatedAt: 0,
    });
    for (const record of await context.working.resultList()) await store.loadResultRecord(typedRecord(record));
    for (const record of await context.working.draftList()) store.loadDraftRecord(typedRecord(record));
    for (const record of await context.working.verificationList(context.actor?.threadId ?? "", "child")) store.loadVerificationRecord(typedRecord(record), "child");
    for (const record of await context.working.verificationList(context.actor?.threadId ?? "", "parent")) store.loadVerificationRecord(typedRecord(record), "parent");
    for (const record of await context.working.reviewList(context.actor?.threadId ?? "")) store.loadVerificationRecord(typedRecord(record), "review");
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

  private async loadResultRecord(record: KernelRecordResult): Promise<void> {
    const payload = asRecord(parsePayload(record));
    const branchId = typeof payload.branchId === "string" ? payload.branchId : record.branchId;
    const revision = Number(payload.resultRevision ?? record.resultRevision ?? 0);
    if (!branchId || !Number.isSafeInteger(revision) || revision <= 0) return;
    let result = payload as unknown as WorkingResult;
    if (result.branchId !== branchId || result.resultRevision !== revision || typeof result.root !== "string" || !result.root) return;
    if (!result.pathStates || !result.baseStates) {
      const changedPaths = Array.isArray(result.changedPaths) ? result.changedPaths : [];
      const [base, fixed] = await Promise.all([
        this.context.client.readBranch({ branchId, revision: 0, paths: changedPaths, includeEntries: true }),
        this.context.client.readBranch({ branchId, revision, paths: changedPaths, includeEntries: true }),
      ]);
      const states = (page: KernelBranchReadResult): Record<string, RecoveryState> => Object.fromEntries(page.entries.map((entry) => [normalize(entry.path), fromKernelState(entry.state)]));
      result = { ...result, baseStates: states(base), pathStates: states(fixed) };
    }
    this.results.set(`${branchId}@${revision}`, clone(result));
    for (const [file, state] of Object.entries(result.pathStates ?? {})) if (state.kind === "regular-file") {
      const reference = record.references.find((item) => item.slot === `result:${file}`);
      if (reference) this.sourceByHash.set(state.objectHash, { recordId: record.recordId, slot: reference.slot });
    }
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

  private branchEntries(branch: BranchProjection): Array<{ path: string; state: KernelBranchState; ownerId?: string; sourcePath?: string; sourceRecordId?: string; sourceSlot?: string }> {
    return Object.entries(branch.deltas).map(([file, state]) => {
      const entry = { path: file, state: toKernelState(state) } as { path: string; state: KernelBranchState; ownerId?: string; sourcePath?: string; sourceRecordId?: string; sourceSlot?: string };
      if (state.kind === "regular-file") {
        const ownerId = this.ownerByHash.get(state.objectHash);
        if (ownerId) entry.ownerId = ownerId;
        else {
          const source = this.sourceByHash.get(state.objectHash);
          if (source?.path) entry.sourcePath = source.path;
          else if (source?.recordId && source.slot) {
            entry.sourceRecordId = source.recordId;
            entry.sourceSlot = source.slot;
          }
        }
      }
      return entry;
    });
  }

  private async putMetadata(branch: BranchProjection): Promise<void> {
    const recordId = `working-branch:${branch.branchId}`;
    const existing = await this.context.records.get(recordId);
    await this.context.records.put({
      operationId: `branch-meta:${branch.branchId}:${existing ? existing.recordRevision + 1 : 1}:${randomUUID()}`,
      recordId,
      recordType: "working.branch",
      state: "active",
      branchId: branch.branchId,
      ...(existing ? { expectedRecordRevision: existing.recordRevision } : {}),
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
  resultTreeIdentity(branchId: string, revision: number): string | null { return this.results.get(`${branchId}@${revision}`)?.root ?? null; }

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
      if (state.kind === "regular-file" && options?.store !== false) {
        const object = await this.putObject(await fs.promises.readFile(path.join(directory, ...file.split("/"))));
        state = { ...state, objectHash: object.hash, byteLength: object.byteLength };
      }
      result[file] = state;
      done += 1; options?.onProgress?.(done, files.length);
    }
    return applyIndexModes(result, options?.indexModes);
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
  async listCaptureScopePaths(directory: string, scopes: readonly string[]): Promise<string[]> {
    const output = new Set<string>();
    for (const rawScope of scopes) {
      const scope = normalize(rawScope);
      const absolute = path.join(directory, ...scope.split("/"));
      let stat: fs.Stats;
      try { stat = await fs.promises.lstat(absolute); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      output.add(scope);
      if (stat.isDirectory() && !stat.isSymbolicLink()) for (const child of await this.scanDirectory(absolute, directory)) output.add(child);
    }
    return [...output].sort();
  }
  async listWorkspaceBaselinePaths(directory: string): Promise<string[]> { return this.scanDirectory(directory); }

  async createBranch(workspaceId: string, branchId: string, baseState: Record<string, RecoveryState>, baseRef?: string, draftBasePaths: string[] = [], captureScopes: string[] = []): Promise<WorkingBranch> {
    if (workspaceId !== this.context.identity.workspaceId) throw new Error("Working-state workspace mismatch");
    const existing = this.getBranch(branchId);
    if (existing) {
      const paths = new Set([...Object.keys(existing.baseState), ...Object.keys(baseState)]);
      if ([...paths].some((file) => !sameState(existing.baseState[file] ?? { kind: "missing" }, baseState[file] ?? { kind: "missing" }))) {
        throw new Error(`Working branch ${branchId} already exists with another baseline`);
      }
      const requestedDraftBasePaths = draftBasePaths.map(normalize);
      const requestedCaptureScopes = captureScopes.map(normalize);
      const metadata = await this.context.records.get(`working-branch:${branchId}`);
      if (metadata) {
        const payload = asRecord(parsePayload(metadata));
        const storedBaseRef = typeof payload.baseRef === "string" ? payload.baseRef : undefined;
        const storedDraftBasePaths = Array.isArray(payload.draftBasePaths)
          ? payload.draftBasePaths.filter((item): item is string => typeof item === "string")
          : [];
        const storedCaptureScopes = Array.isArray(payload.captureScopes)
          ? payload.captureScopes.filter((item): item is string => typeof item === "string")
          : [];
        if (
          storedBaseRef !== baseRef
          || JSON.stringify(storedDraftBasePaths) !== JSON.stringify(requestedDraftBasePaths)
          || JSON.stringify(storedCaptureScopes) !== JSON.stringify(requestedCaptureScopes)
        ) {
          throw new Error(`Working branch ${branchId} already exists with different metadata`);
        }
        return existing;
      }
      const row = this.branches.get(branchId)!;
      if (baseRef === undefined) delete row.baseRef;
      else row.baseRef = baseRef;
      row.draftBasePaths = requestedDraftBasePaths;
      row.captureScopes = requestedCaptureScopes;
      row.updatedAt = nowIso();
      await this.putMetadata(row);
      return this.getBranch(branchId)!;
    }
    const branchRefSplit = baseRef?.lastIndexOf("@") ?? -1;
    const parentId = baseRef && branchRefSplit > 0 ? baseRef.slice(0, branchRefSplit) : "";
    const parentRevision = baseRef && branchRefSplit > 0 ? Number(baseRef.slice(branchRefSplit + 1)) : undefined;
    const parent = parentId && Number.isSafeInteger(parentRevision) ? this.effectiveState(parentId, parentRevision) : null;
    const kernelBaseRef = baseRef && (/^sha256-[a-f0-9]+$/i.test(baseRef) || baseRef.startsWith("pin:") || parent) ? baseRef : undefined;
    let entriesState = baseState;
    if (parent) entriesState = Object.fromEntries(Object.entries(baseState).filter(([file, state]) => !sameState(parent[file] ?? { kind: "missing" }, state)));
    const entries = Object.entries(entriesState).map(([file, state]) => {
      const source = state.kind === "regular-file" ? this.sourceByHash.get(state.objectHash) : undefined;
      return {
        path: normalize(file),
        state: toKernelState(state),
        ...(state.kind === "regular-file" && this.ownerByHash.has(state.objectHash) ? { ownerId: this.ownerByHash.get(state.objectHash)! } : {}),
        ...(state.kind === "regular-file" && !this.ownerByHash.has(state.objectHash) && source?.path ? { sourcePath: source.path } : {}),
        ...(state.kind === "regular-file" && !this.ownerByHash.has(state.objectHash) && !source?.path && source?.recordId && source.slot
          ? { sourceRecordId: source.recordId, sourceSlot: source.slot }
          : {}),
      };
    });
    const created = await this.context.client.createBranch({ operationId: `branch-create:${branchId}`, branchId, workspaceId, entries, ...(kernelBaseRef ? { baseRef: kernelBaseRef } : {}) });
    const now = nowIso();
    let baseRoot = String(asRecord(created).root);
    if (kernelBaseRef) {
      const split = kernelBaseRef.lastIndexOf("@");
      if (split > 0) baseRoot = (await this.context.client.readBranch({ branchId: kernelBaseRef.slice(0, split), revision: Number(kernelBaseRef.slice(split + 1)) })).root;
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
    await this.context.working.draftPut({ operationId: `draft:${id}`, recordId: id, document: baseline, createdAt: baseline.createdAt, ownerIds, references }); this.drafts.set(id, baseline); for (const state of Object.values(pathStates)) if (state.kind === "regular-file") { this.ownerByHash.delete(state.objectHash); this.sourceByHash.set(state.objectHash, { recordId: id, slot: `draft:${Object.entries(pathStates).find(([, value]) => value === state)?.[0] ?? ""}` }); } return clone(baseline);
  }

  async commitVirtualWrites(branchId: string, expectedWriteRevision: number, files: Record<string, RecoveryState>): Promise<{ status: "committed"; writeRevision: number } | { status: "conflict"; writeRevision: number }> {
    const branch = this.branches.get(branchId); if (!branch) throw new Error(`Working branch not found: ${branchId}`);
    if (branch.writeRevision !== expectedWriteRevision) return { status: "conflict", writeRevision: branch.writeRevision };
    const current = { ...branch.baseState, ...branch.deltas };
    const normalized = Object.fromEntries(Object.entries(files).map(([file, state]) => [normalize(file), state]));
    assertVirtualWriteTree(current, normalized);
    const closed = { ...normalized };
    for (const [file, state] of Object.entries(normalized)) {
      if (state.kind === "missing") continue;
      let parent = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "";
      while (parent) {
        const visible = closed[parent] ?? current[parent];
        if (!visible || visible.kind === "missing") {
          closed[parent] = branch.baseState[parent]?.kind === "directory" ? branch.baseState[parent]! : { kind: "directory" };
        }
        parent = parent.includes("/") ? parent.slice(0, parent.lastIndexOf("/")) : "";
      }
    }
    const committedWrites = compactTreeWrites(closed);
    const changes = Object.entries(committedWrites).map(([file, state]) => {
      const source = state.kind === "regular-file" ? this.sourceByHash.get(state.objectHash) : undefined;
      return {
        path: file,
        state: toKernelState(state),
        ...(state.kind === "regular-file" && this.ownerByHash.has(state.objectHash) ? { ownerId: this.ownerByHash.get(state.objectHash)! } : {}),
        ...(state.kind === "regular-file" && !this.ownerByHash.has(state.objectHash) && source?.path ? { sourcePath: source.path } : {}),
        ...(state.kind === "regular-file" && !this.ownerByHash.has(state.objectHash) && !source?.path && source?.recordId && source.slot
          ? { sourceRecordId: source.recordId, sourceSlot: source.slot }
          : {}),
      };
    });
    const result = await this.context.client.writeBranch({ operationId: `branch-write:${branchId}:${expectedWriteRevision + 1}:${randomUUID()}`, branchId, expectedWriteRevision, changes });
    if (result.status === "conflict") return { status: "conflict", writeRevision: result.writeRevision };
    for (const [file, state] of Object.entries(committedWrites)) {
      const normalized = normalize(file);
      if (state.kind !== "directory") for (const existing of Object.keys(branch.deltas)) if (existing.startsWith(`${normalized}/`)) delete branch.deltas[existing];
      if (state.kind === "missing" && !Object.hasOwn(branch.baseState, normalized)) delete branch.deltas[normalized]; else branch.deltas[normalized] = clone(state);
      if (state.kind === "regular-file") { this.ownerByHash.delete(state.objectHash); this.sourceByHash.set(state.objectHash, { branchId, path: normalized }); }
    }
    branch.writeRevision = result.writeRevision; branch.root = result.root; branch.updatedAt = nowIso(); this.branches.set(branchId, branch); await this.putMetadata(branch); return { status: "committed", writeRevision: result.writeRevision };
  }
  async commitVirtualWrite(branchId: string, expectedWriteRevision: number, file: string, state: RecoveryState) { return this.commitVirtualWrites(branchId, expectedWriteRevision, { [file]: state }); }

  async publishStates(branchId: string, capturedState: Record<string, RecoveryState>, knownChangedPaths?: string[]): Promise<WorkingResult> {
    const branch = this.branches.get(branchId); if (!branch) throw new Error(`Working branch not found: ${branchId}`);
    const candidates = knownChangedPaths?.map(normalize) ?? [...new Set([...Object.keys(branch.baseState), ...Object.keys(branch.deltas), ...Object.keys(capturedState)])];
    const changedPaths = candidates.filter((file) => !sameState(branch.baseState[file] ?? { kind: "missing" }, capturedState[file] ?? { kind: "missing" })).sort();
    const clearedDeltaPaths = candidates.filter((file) => Object.hasOwn(branch.deltas, file) && sameState(branch.baseState[file] ?? { kind: "missing" }, capturedState[file] ?? { kind: "missing" }));
    const baseStates = Object.fromEntries(changedPaths.map((file) => [file, branch.baseState[file] ?? { kind: "missing" as const}]));
    const pathStates = Object.fromEntries(changedPaths.map((file) => [file, capturedState[file] ?? { kind: "missing" as const}]));
    const currentState = { ...branch.baseState, ...branch.deltas };
    const kernelChanges = Object.fromEntries(candidates
      .filter((file) => !sameState(currentState[file] ?? { kind: "missing" }, capturedState[file] ?? { kind: "missing" }))
      .map((file) => [file, capturedState[file] ?? { kind: "missing" as const}]));
    const written = Object.keys(kernelChanges).length > 0 ? await this.commitVirtualWrites(branchId, branch.writeRevision, kernelChanges) : { status: "committed" as const, writeRevision: branch.writeRevision };
    if (written.status === "conflict") throw new Error("Working branch changed while publishing result");
    for (const file of clearedDeltaPaths) delete branch.deltas[file];
    if (clearedDeltaPaths.length > 0) await this.putMetadata(branch);
    const published = await this.context.client.publishBranch({ operationId: `branch-publish:${branchId}:${branch.headRevision + 1}`, branchId, expectedWriteRevision: written.writeRevision, expectedRoot: branch.root });
    if (asRecord(published).status === "conflict") throw new Error("Working branch publish CAS conflict");
    const revision = Number(asRecord(published).revision); const publishedRoot = String(asRecord(published).root ?? "");
    if (!Number.isSafeInteger(revision) || revision <= 0 || !publishedRoot) throw new Error("Kernel returned an invalid published branch identity");
    const result: WorkingResult = { resultRevision: revision, branchId, ...(branch.baseRef ? { parentRef: branch.baseRef } : {}), changedPaths, baseStates, pathStates, diffStats: { files: changedPaths.length, insertions: 0, deletions: 0 }, createdAt: nowIso(), root: publishedRoot };
    branch.headRevision = revision; branch.root = publishedRoot; branch.updatedAt = result.createdAt; this.branches.set(branchId, branch); this.results.set(`${branchId}@${revision}`, result);
    const refs = [
      ...Object.entries(baseStates).flatMap(([file, state]) => state.kind === "regular-file" ? [{ slot: `base:${file}`, objectHash: state.objectHash }] : []),
      ...Object.entries(pathStates).flatMap(([file, state]) => state.kind === "regular-file" ? [{ slot: `result:${file}`, objectHash: state.objectHash }] : []),
    ];
    const persistedResult = { resultRevision: result.resultRevision, branchId: result.branchId, ...(result.parentRef ? { parentRef: result.parentRef } : {}), changedPaths: result.changedPaths, diffStats: result.diffStats, createdAt: result.createdAt, root: result.root };
    await this.context.working.resultPut({ operationId: `result:${branchId}:${revision}`, recordId: `working-result:${branchId}@${revision}`, branchId, resultRevision: revision, root: publishedRoot, ...(result.parentRef ? { parentRef: result.parentRef } : {}), changedPaths: result.changedPaths, diffStats: result.diffStats, createdAt: result.createdAt, document: persistedResult, ownerIds: [], references: refs });
    for (const reference of refs) this.sourceByHash.set(reference.objectHash, { recordId: `working-result:${branchId}@${revision}`, slot: reference.slot });
    return clone(result);
  }
  async publishHeadResult(branchId: string): Promise<WorkingResult> { const states = this.effectiveState(branchId); if (!states) throw new Error(`Working branch not found: ${branchId}`); return this.publishStates(branchId, states); }
  async publishDirectoryResult(branchId: string, directory: string, changedPaths?: string[], options?: { indexModes?: Map<string, string> | Record<string, string>; validateFixedSource?: () => Promise<boolean> }): Promise<WorkingResult> {
    const branch = this.branches.get(branchId); if (!branch) throw new Error(`Working branch not found: ${branchId}`);
    const requested = changedPaths?.map(normalize);
    const ancestors = requested?.flatMap((file) => {
      const paths: string[] = [];
      let parent = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "";
      while (parent) { paths.push(parent); parent = parent.includes("/") ? parent.slice(0, parent.lastIndexOf("/")) : ""; }
      return paths;
    }) ?? [];
    const candidates = requested ? [...new Set([...requested, ...ancestors, ...branch.draftBasePaths, ...Object.keys(branch.deltas)])] : undefined;
    const captured = await this.captureDirectory(directory, candidates, options);
    if (options?.validateFixedSource && !await options.validateFixedSource()) throw new Error("Working-state source changed while it was being captured");
    return this.publishStates(branchId, captured, candidates);
  }
  async captureBranchCandidateIdentity(branchId: string, directory: string, changedPaths: string[]): Promise<string | null> { const captured = await this.captureDirectory(directory, changedPaths); const branch = this.branches.get(branchId); if (!branch) return null; return transientStateIdentity({ ...branch.baseState, ...captured }); }
  async captureSeededPathIdentity(directory: string, changedPaths: string[], seed: string): Promise<string> { const captured = await this.captureDirectory(directory, changedPaths); return `sha256-${createHash("sha256").update(seed).update("\0").update(transientStateIdentity(captured)).digest("hex")}`; }

  async materializeResult(branchId: string, revision: number, directory: string): Promise<MaterializeResult> { const states = this.resultState(branchId, revision); if (!states) throw new Error(`Working result not found: ${branchId}@${revision}`); return this.materializeStates(states, directory); }
  async materializeStates(states: Record<string, RecoveryState>, directory: string): Promise<MaterializeResult> { return materializeWorkingState({ targetDir: directory, states, readContent: async (state) => state.kind === "regular-file" ? this.getObject(state.objectHash) : null, objectPathFor: () => null, cleanUnreferenced: true }); }
  async directoryMatchesResult(branchId: string, revision: number, directory: string): Promise<boolean> { const expected = this.resultState(branchId, revision); if (!expected) return false; const actual = await this.captureDirectory(directory); const files = new Set([...Object.keys(expected), ...Object.keys(actual)]); return [...files].every((file) => sameState(actual[file] ?? { kind: "missing" }, expected[file] ?? { kind: "missing" })); }

  async deleteBranch(branchId: string): Promise<void> { if (!this.branches.has(branchId)) return; await this.context.client.deleteBranch({ operationId: `branch-delete:${branchId}`, branchId }); await this.context.records.release(`branch-release:${branchId}`, `working-branch:${branchId}`); this.branches.delete(branchId); }
  async deleteDraftBaseline(id: string): Promise<void> { await this.context.working.draftRelease(`draft-release:${id}`, id); this.drafts.delete(id); }
  async deleteResult(branchId: string, revision: number): Promise<void> { await this.deleteResults(branchId, [revision]); }
  async deleteResults(branchId: string, revisions: readonly number[]): Promise<number[]> { const removed: number[] = []; for (const revision of revisions) { if (!this.results.has(`${branchId}@${revision}`)) continue; await this.context.working.resultRelease(`result-release:${branchId}@${revision}`, `working-result:${branchId}@${revision}`); this.results.delete(`${branchId}@${revision}`); removed.push(revision); } return removed; }
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
  private async putVerification(recordType: string, threadId: string, revision: number, payload: unknown): Promise<void> {
    const recordId = `${recordType}:${threadId}:${revision}`;
    const document = asRecord(payload);
    const branchId = typeof document.branchId === "string" ? document.branchId : typeof document.mergedResultRevision === "number" ? `merge:${document.mergedResultRevision}` : "unknown";
    const root = typeof document.resultTreeHash === "string" ? document.resultTreeHash : typeof document.parentTreeHash === "string" ? document.parentTreeHash : "root:unbound";
    if (recordType === "working.review") {
      await this.context.working.reviewPut({ operationId: `${recordId}:${randomUUID()}`, recordId, threadId, branchId, resultRevision: revision, root, document, ownerIds: [], references: [] });
    } else {
      await this.context.working.verificationPut({ operationId: `${recordId}:${randomUUID()}`, recordId, kind: recordType.endsWith("child") ? "child" : "parent", threadId, branchId, resultRevision: revision, root, document, ownerIds: [], references: [] });
    }
  }
}

export interface KernelStorageAdapterOptions {
  client: KernelClient;
  hostId: string;
  hostGeneration?: string;
  resolveWorkspaceRoot: (workspaceId: string) => Promise<string>;
  fileStore?: RecoveryFileStore;
  storageRoot: string;
  resolveActor?: (workspaceId: string, purpose: string, hint?: KernelActorIdentity) => KernelActorIdentity | Promise<KernelActorIdentity>;
  durableRecoveryStore?: RecoveryDurableOperationPort;
}

export class KernelStorageAdapter {
  readonly client: KernelClient;
  private readonly options: KernelStorageAdapterOptions;
  private readonly grants = new Map<string, Promise<KernelGrantHandle>>();
  private boundFileStore: RecoveryFileStore | undefined;
  private readonly fileStoreProxy: RecoveryFileStore;
  constructor(options: KernelStorageAdapterOptions) {
    this.options = options;
    this.client = options.client;
    this.boundFileStore = options.fileStore;
    this.fileStoreProxy = {
      applyState: (...args) => this.boundFileStore?.applyState(...args) ?? Promise.reject(new Error("Kernel recovery file store is not bound")),
      captureState: (...args) => this.boundFileStore?.captureState(...args) ?? Promise.reject(new Error("Kernel recovery file store is not bound")),
      hashFile: (...args) => this.boundFileStore?.hashFile(...args) ?? Promise.reject(new Error("Kernel recovery file store is not bound")),
      relativePathFor: (...args) => this.boundFileStore?.relativePathFor(...args) ?? Promise.reject(new Error("Kernel recovery file store is not bound")),
      verifyObject: (...args) => this.boundFileStore?.verifyObject(...args) ?? Promise.reject(new Error("Kernel recovery file store is not bound")),
    };
  }

  bindFileStore(fileStore: RecoveryFileStore): void {
    if (this.boundFileStore && this.boundFileStore !== fileStore) {
      throw new Error("Kernel recovery file store is already bound");
    }
    this.boundFileStore = fileStore;
  }
  private async grantFor(workspaceId: string, purpose: string, actorOverride?: KernelActorIdentity): Promise<KernelGrantHandle> {
    const actor = this.options.resolveActor
      ? await this.options.resolveActor(workspaceId, purpose, actorOverride)
      : actorOverride ?? { owningWorkspace: workspaceId, executionWorkspace: workspaceId, pathScopes: [""] };
    const capabilities = [...new Set(["storage.read", "storage.write", "recovery", ...(actor.capabilities ?? []), ...(purpose === "recovery-maintenance" ? ["recovery.maintenance", "storage.gc"] : purpose.includes("gc") ? ["storage.gc"] : [])])].sort();
    const key = JSON.stringify({ workspaceId, actor, capabilities });
    const existing = this.grants.get(key); if (existing) return existing;
    const grant = (async () => {
      const actorKey = createHash("sha256").update(JSON.stringify(actor)).digest("hex").slice(0, 24);
      const capabilityKey = createHash("sha256").update(JSON.stringify(capabilities)).digest("hex").slice(0, 12);
      return this.client.issueGrant({ grantId: `product:${this.options.hostId}:${this.options.hostGeneration ?? process.pid}:${workspaceId}:${actorKey}:${capabilityKey}`, ...actor, capabilities, pathScopes: actor.pathScopes ?? [""] });
    })();
    this.grants.set(key, grant); return grant;
  }
  async context(workspaceId: string, purpose: string, actorOverride?: KernelActorIdentity): Promise<KernelStorageContext & { client: KernelScopedClient }> {
    const root = this.options.storageRoot;
    const identity: RecoveryIdentity = { authorityId: this.options.hostId, canonicalRoot: await this.options.resolveWorkspaceRoot(workspaceId), filesystemProfile: process.platform === "win32" ? "windows-local" : `${process.platform}-local`, workspaceId };
    const grant = await this.grantFor(workspaceId, purpose, actorOverride);
    const scoped = this.client.scoped(grant);
    const records = {
      get: (recordId: string) => scoped.getRecord(workspaceId, recordId),
      list: async (input: { recordType?: string; threadId?: string; runId?: string; branchId?: string }) => { const all: KernelRecordResult[] = []; let cursor: number | undefined; do { const page = await scoped.listRecords({ workspaceId, ...input, ...(cursor === undefined ? {} : { cursor }), pageSize: 128 }); all.push(...page.records); cursor = page.nextCursor === null ? undefined : page.nextCursor; } while (cursor !== undefined); return all; },
      put: (input: Omit<Parameters<KernelScopedClient["putRecord"]>[0], "ownerIds" | "references"> & { ownerIds?: string[]; references?: KernelStorageReference[] }) => scoped.putRecord({ ...input, workspaceId, ownerIds: input.ownerIds ?? [], references: input.references ?? [] }),
      release: (operationId: string, recordId: string) => scoped.releaseRecord(operationId, workspaceId, recordId),
    };
    const working = {
      resultPut: (input: Omit<Parameters<KernelScopedClient["workingResultPut"]>[0], "workspaceId"> & { workspaceId?: string }) => scoped.workingResultPut({ ...input, workspaceId }),
      resultGet: async (recordId: string) => scoped.workingResultGet({ workspaceId, recordId }),
      resultList: async (branchId?: string) => {
        const result = await scoped.workingResultList({ workspaceId, ...(branchId === undefined ? {} : { branchId }) });
        return Array.isArray(result.records) ? result.records as Record<string, unknown>[] : [];
      },
      resultRelease: (operationId: string, recordId: string) => scoped.workingResultRelease({ operationId, workspaceId, recordId }),
      draftPut: (input: Omit<Parameters<KernelScopedClient["workingDraftPut"]>[0], "workspaceId"> & { workspaceId?: string }) => scoped.workingDraftPut({ ...input, workspaceId }),
      draftGet: async (recordId: string) => scoped.workingDraftGet({ workspaceId, recordId }),
      draftList: async () => {
        const result = await scoped.workingDraftList({ workspaceId });
        return Array.isArray(result.records) ? result.records as Record<string, unknown>[] : [];
      },
      draftRelease: (operationId: string, recordId: string) => scoped.workingDraftRelease({ operationId, workspaceId, recordId }),
      verificationPut: (input: Omit<Parameters<KernelScopedClient["workingVerificationPut"]>[0], "workspaceId"> & { workspaceId?: string }) => scoped.workingVerificationPut({ ...input, workspaceId }),
      verificationList: async (threadId: string, kind: "child" | "parent") => {
        const result = await scoped.workingVerificationList({ workspaceId, threadId, kind });
        return Array.isArray(result.records) ? result.records as Record<string, unknown>[] : [];
      },
      verificationRelease: (operationId: string, recordId: string) => scoped.workingVerificationRelease({ operationId, workspaceId, recordId }),
      reviewPut: (input: Omit<Parameters<KernelScopedClient["workingReviewPut"]>[0], "workspaceId"> & { workspaceId?: string }) => scoped.workingReviewPut({ ...input, workspaceId }),
      reviewList: async (threadId: string) => {
        const result = await scoped.workingReviewList({ workspaceId, threadId });
        return Array.isArray(result.records) ? result.records as Record<string, unknown>[] : [];
      },
      reviewRelease: (operationId: string, recordId: string) => scoped.workingReviewRelease({ operationId, workspaceId, recordId }),
    };
    return {
      identity,
      root,
      actor: {
        ...(grant.sessionId ? { sessionId: grant.sessionId } : {}),
        ...(grant.authorityInstanceId ? { authorityInstanceId: grant.authorityInstanceId } : {}),
        ...(grant.workerId ? { workerId: grant.workerId } : {}),
        ...(grant.workerGeneration === null ? {} : { workerGeneration: grant.workerGeneration }),
        ...(grant.threadId ? { threadId: grant.threadId } : {}),
        ...(grant.runId ? { runId: grant.runId } : {}),
        owningWorkspace: grant.owningWorkspace ?? workspaceId,
        ...(grant.executionWorkspace ? { executionWorkspace: grant.executionWorkspace } : {}),
        pathScopes: [...grant.pathScopes],
        capabilities: [...grant.capabilities],
      },
      fileStore: this.fileStoreProxy,
      resourceOperationGate: {
        run: async () => { throw new Error("Kernel resource operation gate is not bound"); },
      },
      collectUnreachableObjects: async () => {
        const maintenance = await this.context(workspaceId, "recovery-maintenance", { owningWorkspace: workspaceId, executionWorkspace: workspaceId, pathScopes: [""], capabilities: ["recovery.maintenance", "storage.gc"] });
        const result = await maintenance.client.gc(`kernel-gc:${workspaceId}:${randomUUID()}`);
        return { byteLengthReclaimed: Number(result.byteLengthReclaimed ?? 0), objectsDeleted: Number(result.deletedBlobs ?? result.objectsDeleted ?? 0) };
      },
      ...(this.options.durableRecoveryStore ? { durableRecoveryStore: this.options.durableRecoveryStore } : {}),
      records,
      working,
      client: scoped,
    };
  }
  async dispose(): Promise<void> {
    const grants = await Promise.allSettled([...this.grants.values()].map(async (grant) => this.client.revokeGrant((await grant).grantId)));
    this.grants.clear();
    const failures = grants.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failures.length > 0) throw new Error(`One or more kernel storage grants failed to revoke: ${failures.map((failure) => String(failure.reason)).join("; ")}`);
  }

  async revokeSession(sessionId: string): Promise<void> {
    const candidates = [...this.grants.entries()];
    for (const [key, promise] of candidates) {
      const grant = await promise.catch(() => null);
      if (!grant || grant.sessionId !== sessionId) continue;
      await this.client.revokeGrant(grant.grantId).catch(() => undefined);
      this.grants.delete(key);
    }
  }
}

export const createKernelWorkspaceWorkingStateAccess = (
  adapter: KernelStorageAdapter,
  recoveryEngine?: WorkspaceRecoveryEngine,
  durableRecoveryStore?: RecoveryDurableOperationPort,
): WorkspaceWorkingStateAccess & WorkspaceWorkingStateRootAccess => {
  const withStore: WorkspaceWorkingStateAccess["withStore"] = async (workspaceId, purpose, operation, mode: Mode = "exclusive") => {
    const context = await adapter.context(workspaceId, purpose, { owningWorkspace: workspaceId, executionWorkspace: workspaceId, pathScopes: [""], capabilities: ["storage.maintenance"] });
    const projection = await KernelWorkingStateCompatibilityAdapter.open(context);
    if (!recoveryEngine) return Reflect.apply(operation, undefined, [projection, context]);
    return recoveryEngine.withWorkspaceStorage(
      workspaceId,
      { mode, purpose, create: true },
      (recoveryContext) => Reflect.apply(operation, undefined, [projection, {
        ...context,
        ...(durableRecoveryStore ? {} : { database: recoveryContext.database }),
        ...(durableRecoveryStore ? { durableRecoveryStore } : {}),
        resourceOperationGate: recoveryContext.resourceOperationGate,
      } as unknown as import("../recovery/journal-engine.js").WorkspaceRecoveryStorageContext]),
    );
  };
  return {
    withStore,
    withBranchStore: async (workspaceId, purpose, operation, _mode: Mode = "exclusive", actor) => {
      const context = await adapter.context(workspaceId, purpose, {
        owningWorkspace: workspaceId,
        executionWorkspace: workspaceId,
        pathScopes: [""],
        ...(actor ?? {}),
        capabilities: actor ? [] : ["storage.maintenance"],
      });
      return operation(new KernelWorkingStateRootStore(context), context);
    },
  };
};
