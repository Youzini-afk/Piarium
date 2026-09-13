import { createHash, randomUUID } from "node:crypto";
import { sameState } from "../../recovery/journal-files.js";
import type {
  RecoveryState,
  WorkingBranch,
  WorkingBranchRoot,
  WorkingStatePathOrigin,
  WorkingStatePin,
  WorkingStateReadOptions,
  WorkingStateRootStore,
  WorkingStateTreeEntry,
  WorkingStateTreeRead,
  WorkspaceWorkingStateRootAccess,
} from "./types.js";
import type { WorkingStateStore, WorkspaceWorkingStateAccess } from "./working-state-store.js";

export type CompatibleWorkingStateAccess = WorkspaceWorkingStateAccess | WorkspaceWorkingStateRootAccess;
export type CompatibleWorkingStateStore = WorkingStateStore | WorkingStateRootStore;

const normalizeRelative = (value: string): string => {
  const raw = value.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!raw || raw === ".") return "";
  const segments = raw.split("/").filter((segment) => segment && segment !== ".");
  if (raw.includes("\0") || raw.startsWith("/") || /^[A-Za-z]:/.test(raw) || segments.includes("..")) {
    throw new Error(`Invalid working-state path: ${value}`);
  }
  return segments.join("/");
};

const relevantTo = (file: string, roots: readonly string[]): boolean => roots.some((root) => (
  !root || file === root || file.startsWith(`${root}/`) || root.startsWith(`${file}/`)
));

const checkRead = (options?: WorkingStateReadOptions): void => {
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

const rootFromBranch = (branch: WorkingBranch): WorkingBranchRoot => ({
  branchId: branch.branchId,
  workspaceId: branch.workspaceId,
  ...(branch.baseRef ? { baseRef: branch.baseRef } : {}),
  baseRoot: transientStateIdentity(branch.baseState),
  root: transientStateIdentity({ ...branch.baseState, ...branch.deltas }),
  headRevision: branch.headRevision,
  writeRevision: branch.writeRevision,
  draftBasePaths: [...branch.draftBasePaths],
  captureScopes: [...branch.captureScopes],
  createdAt: branch.createdAt,
  updatedAt: branch.updatedAt,
});

/** Adapter for the local TS store and its tests. Production implements the root API directly. */
export class LegacyWorkingStateRootAdapter implements WorkingStateRootStore {
  private readonly pins = new Map<string, { branchId: string; revision: number; root: string; states: Record<string, RecoveryState> }>();

  constructor(private readonly store: WorkingStateStore) {}

  async getBranchRoot(branchId: string): Promise<WorkingBranchRoot | null> {
    const branch = this.store.getBranch(branchId);
    return branch ? rootFromBranch(branch) : null;
  }

  async getResult(branchId: string, revision: number): Promise<import("./types.js").WorkingResult | null> {
    return this.store.getResult(branchId, revision);
  }

  async readStateSlice(branchId: string, paths: readonly string[], options?: WorkingStateReadOptions): Promise<Record<string, RecoveryState> | null> {
    const state = options?.pin ? this.statesFor(branchId, options) : this.store.effectiveStateSlice(branchId, paths, options?.revision, options);
    return state ? structuredClone(state) : null;
  }

  private statesFor(branchId: string, options?: WorkingStateReadOptions): Record<string, RecoveryState> | null {
    if (options?.pin) {
      const pin = this.pins.get(options.pin.pinId);
      return pin?.branchId === branchId ? structuredClone(pin.states) : null;
    }
    return this.store.effectiveState(branchId, options?.revision);
  }

  private originFor(branchId: string, file: string, state: RecoveryState): WorkingStatePathOrigin {
    const branch = this.store.getBranch(branchId);
    if (!branch) return "base";
    if (branch.draftBasePaths.includes(file) && sameState(branch.baseState[file] ?? { kind: "missing" }, state)) return "draft-base";
    return sameState(branch.baseState[file] ?? { kind: "missing" }, state) ? "base" : "delta";
  }

  async readPath(branchId: string, rawPath: string, options?: WorkingStateReadOptions): Promise<WorkingStateTreeEntry | null> {
    checkRead(options);
    const branch = this.store.getBranch(branchId);
    if (!branch) return null;
    const path = normalizeRelative(rawPath);
    const states = options?.pin
      ? this.statesFor(branchId, options)
      : this.store.effectiveStateSlice(branchId, [path], options?.revision, options);
    if (!states) return null;
    let hidden = false;
    let parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    while (parent) {
      if (states[parent]?.kind === "missing") hidden = true;
      parent = parent.includes("/") ? parent.slice(0, parent.lastIndexOf("/")) : "";
    }
    const state = path && !hidden ? states[path] ?? { kind: "missing" as const } : path ? { kind: "missing" as const } : { kind: "directory" as const };
    const origin = this.originFor(branchId, path, state);
    return {
      path,
      state: structuredClone(state),
      origin,
      root: options?.pin?.root ?? transientStateIdentity(states),
      viewRevision: options?.pin?.writeRevision ?? options?.revision ?? branch.writeRevision,
      ...(state.kind === "regular-file" ? {
        contentSource: options?.pin
          ? { kind: "pin" as const, pinId: options.pin.pinId, path }
          : { kind: "branch" as const, branchId, path, ...(options?.revision === undefined ? {} : { revision: options.revision }) },
      } : {}),
    };
  }

  async listPaths(branchId: string, rawRoots: readonly string[], options?: WorkingStateReadOptions): Promise<WorkingStateTreeRead | null> {
    checkRead(options);
    const branch = this.store.getBranch(branchId);
    if (!branch) return null;
    const roots = (rawRoots.length ? rawRoots : [""]).map(normalizeRelative);
    const states = options?.pin
      ? this.statesFor(branchId, options)
      : this.store.effectiveStateSlice(branchId, roots, options?.revision, options);
    if (!states) return null;
    const entries: WorkingStateTreeEntry[] = [];
    for (const [path, state] of Object.entries(states)) {
      checkRead(options);
      if (!relevantTo(path, roots)) continue;
      const origin = this.originFor(branchId, path, state);
      entries.push({
        path,
        state: structuredClone(state),
        origin,
        ...(state.kind === "regular-file" ? {
          contentSource: options?.pin
            ? { kind: "pin" as const, pinId: options.pin.pinId, path }
            : { kind: "branch" as const, branchId, path, ...(options?.revision === undefined ? {} : { revision: options.revision }) },
        } : {}),
      });
    }
    const root = options?.pin?.root ?? transientStateIdentity(states);
    return {
      branch: rootFromBranch(branch),
      root,
      viewRevision: options?.pin?.writeRevision ?? options?.revision ?? branch.writeRevision,
      entries: entries.sort((left, right) => left.path.localeCompare(right.path)),
    };
  }

  async readContent(entry: WorkingStateTreeEntry, options?: { offset?: number; length?: number }): Promise<Buffer | null> {
    if (entry.state.kind !== "regular-file") return null;
    if (options?.offset !== undefined || options?.length !== undefined) {
      return this.store.getObjectSlice(
        entry.state.objectHash,
        entry.state.byteLength,
        options.offset ?? 0,
        options.length ?? entry.state.byteLength,
      );
    }
    return this.store.getObject(entry.state.objectHash);
  }

  getObject(hash: string): Promise<Buffer | null> { return this.store.getObject(hash); }

  async pinBranch(branchId: string, options?: { revision?: number }): Promise<WorkingStatePin> {
    const branch = this.store.getBranch(branchId);
    if (!branch) throw new Error(`Working branch not found: ${branchId}`);
    const revision = options?.revision ?? branch.writeRevision;
    const states = this.store.effectiveStateSlice(branchId, [""], options?.revision);
    if (!states) throw new Error(`Working branch revision not found: ${branchId}@${revision}`);
    const pinId = `local-pin-${randomUUID()}`;
    const root = transientStateIdentity(states);
    this.pins.set(pinId, { branchId, revision, root, states });
    return {
      pinId,
      branchId,
      workspaceId: branch.workspaceId,
      revision,
      writeRevision: revision,
      root,
      branch: rootFromBranch(branch),
      release: async () => { this.pins.delete(pinId); },
    };
  }

  putObject(bytes: Buffer): Promise<{ hash: string; byteLength: number }> {
    return this.store.putObject(bytes);
  }

  commitVirtualWrites(branchId: string, expectedWriteRevision: number, files: Record<string, RecoveryState>) {
    return this.store.commitVirtualWrites(branchId, expectedWriteRevision, files);
  }

  materializeResult(...args: Parameters<WorkingStateStore["materializeResult"]>): ReturnType<WorkingStateStore["materializeResult"]> { return this.store.materializeResult(...args); }
  captureBranchCandidateIdentity(...args: Parameters<WorkingStateStore["captureBranchCandidateIdentity"]>): ReturnType<WorkingStateStore["captureBranchCandidateIdentity"]> { return this.store.captureBranchCandidateIdentity(...args); }
}

export const isWorkingStateRootStore = (store: CompatibleWorkingStateStore): store is WorkingStateRootStore => (
  "getBranchRoot" in store && typeof store.getBranchRoot === "function"
);

export const asWorkingStateRootStore = (store: CompatibleWorkingStateStore): WorkingStateRootStore => (
  isWorkingStateRootStore(store) ? store : new LegacyWorkingStateRootAdapter(store)
);

export const isRootAccess = (access: CompatibleWorkingStateAccess): access is WorkspaceWorkingStateRootAccess => (
  "withBranchStore" in access && typeof access.withBranchStore === "function"
);

export const withWorkingStateRootStore = <T>(
  access: CompatibleWorkingStateAccess,
  workspaceId: string,
  purpose: string,
  operation: (store: WorkingStateRootStore) => Promise<T> | T,
  mode: "exclusive" | "shared" = "exclusive",
  actor?: { sessionId: string; threadId?: string; runId?: string },
): Promise<T> => (
  isRootAccess(access)
    ? access.withBranchStore(workspaceId, purpose, operation, mode, actor)
    : access.withStore(workspaceId, purpose, (store) => operation(new LegacyWorkingStateRootAdapter(store)), mode)
);
