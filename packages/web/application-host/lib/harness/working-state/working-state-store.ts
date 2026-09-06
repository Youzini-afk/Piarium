import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { WorkspaceRecoveryEngine, WorkspaceRecoveryStorageContext } from "../../recovery/journal-engine.js";
import { objectPath, replaceObjectReferences, deleteObjectReferences } from "../../recovery/journal-catalog.js";
import { parseRecoveryState, sameState } from "../../recovery/journal-files.js";
import { readRecoveryJsonAtomic, writeRecoveryJsonAtomic } from "../../recovery/locations.js";
import type {
  DraftBaseline,
  DraftBaselinePathProvenance,
  RecoveryState,
  WorkingBranch,
  WorkingResult,
} from "./types.js";
import { materializeWorkingState } from "./materializer.js";

const SCHEMA_VERSION = 2;
const catalogName = (workspaceId: string): string => `${createHash("sha256").update(workspaceId).digest("hex")}.json`;

interface WorkingStateDocument {
  schemaVersion: typeof SCHEMA_VERSION;
  workspaceId: string;
  branches: Record<string, WorkingBranch>;
  draftBaselines: Record<string, DraftBaseline>;
  results: Record<string, WorkingResult>;
}

export interface CreateDraftBaselinePath {
  path: string;
  content: string | Buffer;
  mode?: number;
  provenance: DraftBaselinePathProvenance;
}

export interface WorkingStateStoreOptions extends WorkspaceRecoveryStorageContext {
  fsPromises?: typeof fs.promises;
  pathModule?: typeof path;
}

export interface WorkspaceWorkingStateAccess {
  withStore<T>(
    workspaceId: string,
    purpose: string,
    operation: (store: WorkingStateStore, context: WorkspaceRecoveryStorageContext) => Promise<T> | T,
    mode?: "exclusive" | "shared",
  ): Promise<T>;
}

const clone = <T>(value: T): T => structuredClone(value);
const normalizeRelative = (value: string): string => {
  const normalized = value.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").includes("..")) {
    throw new Error(`Invalid working-state path: ${value}`);
  }
  return normalized;
};

const assertNoDraftPathConflicts = (paths: readonly string[]): void => {
  const seen = new Set<string>();
  for (const file of paths) {
    if (seen.has(file)) throw new Error(`Draft baseline contains a duplicate path: ${file}`);
    seen.add(file);
  }
  for (const descendant of [...seen].sort()) {
    const parts = descendant.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      const ancestor = parts.slice(0, index).join("/");
      if (!seen.has(ancestor)) continue;
      throw new Error(`Draft baseline paths contain an ancestor/descendant conflict: ${ancestor} and ${descendant}`);
    }
  }
};

const parseStates = (value: unknown, label: string): Record<string, RecoveryState> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return Object.fromEntries(Object.entries(value).map(([file, state]) => [normalizeRelative(file), parseRecoveryState(state)]));
};

const parseBranch = (value: unknown, key: string, workspaceId: string, legacy = false): WorkingBranch => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Working branch ${key} is malformed`);
  const row = value as Record<string, unknown>;
  if (row.branchId !== key || row.workspaceId !== workspaceId || !Number.isSafeInteger(row.headRevision)
    || Number(row.headRevision) < 0 || typeof row.createdAt !== "string" || typeof row.updatedAt !== "string"
    || (row.baseRef !== undefined && typeof row.baseRef !== "string")
    || (!legacy && (!Array.isArray(row.draftBasePaths) || !row.draftBasePaths.every((entry) => typeof entry === "string")))) {
    throw new Error(`Working branch ${key} is malformed`);
  }
  const draftBasePaths = legacy ? [] : (row.draftBasePaths as string[]).map(normalizeRelative);
  if (new Set(draftBasePaths).size !== draftBasePaths.length) throw new Error(`Working branch ${key} draft baseline paths are malformed`);
  const baseState = parseStates(row.baseState, `Working branch ${key} baseline`);
  if (draftBasePaths.some((file) => !Object.hasOwn(baseState, file))) {
    throw new Error(`Working branch ${key} does not contain every draft baseline path`);
  }
  return {
    branchId: key,
    workspaceId,
    ...(row.baseRef === undefined ? {} : { baseRef: row.baseRef as string }),
    baseState,
    draftBasePaths,
    deltas: parseStates(row.deltas, `Working branch ${key} deltas`),
    headRevision: row.headRevision as number,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
};

const parseDraftProvenance = (value: unknown, label: string): DraftBaselinePathProvenance => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is malformed`);
  const row = value as Record<string, unknown>;
  if ((row.baseRevision !== null && typeof row.baseRevision !== "string")
    || row.encoding !== "utf-8" || typeof row.bom !== "boolean"
    || !Number.isSafeInteger(row.localEditRevision) || Number(row.localEditRevision) < 0
    || typeof row.revision !== "string" || !row.revision) throw new Error(`${label} is malformed`);
  return {
    baseRevision: row.baseRevision as string | null,
    encoding: "utf-8",
    bom: row.bom as boolean,
    localEditRevision: row.localEditRevision as number,
    revision: row.revision,
  };
};

const parseDraftBaseline = (value: unknown, key: string, workspaceId: string): DraftBaseline => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Draft baseline ${key} is malformed`);
  const row = value as Record<string, unknown>;
  if (row.id !== key || row.workspaceId !== workspaceId || typeof row.createdAt !== "string"
    || !row.provenance || typeof row.provenance !== "object" || Array.isArray(row.provenance)) {
    throw new Error(`Draft baseline ${key} is malformed`);
  }
  const pathStates = parseStates(row.pathStates, `Draft baseline ${key} paths`);
  if (Object.values(pathStates).some((state) => state.kind !== "regular-file")) {
    throw new Error(`Draft baseline ${key} contains a non-file state`);
  }
  const provenance = Object.fromEntries(Object.entries(row.provenance as Record<string, unknown>)
    .map(([file, item]) => [normalizeRelative(file), parseDraftProvenance(item, `Draft baseline ${key} provenance for ${file}`)]));
  const statePaths = Object.keys(pathStates).sort();
  const provenancePaths = Object.keys(provenance).sort();
  if (statePaths.length !== provenancePaths.length || statePaths.some((file, index) => file !== provenancePaths[index])) {
    throw new Error(`Draft baseline ${key} provenance does not match its paths`);
  }
  assertNoDraftPathConflicts(statePaths);
  return { id: key, workspaceId, createdAt: row.createdAt, pathStates, provenance };
};

const parseResult = (value: unknown, key: string): WorkingResult => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Working result ${key} is malformed`);
  const row = value as Record<string, unknown>;
  if (!Number.isSafeInteger(row.resultRevision) || Number(row.resultRevision) <= 0 || typeof row.branchId !== "string"
    || key !== `${row.branchId}@${row.resultRevision}` || !Array.isArray(row.changedPaths)
    || !(row.changedPaths as unknown[]).every((entry) => typeof entry === "string")
    || typeof row.createdAt !== "string" || !row.diffStats || typeof row.diffStats !== "object") {
    throw new Error(`Working result ${key} is malformed`);
  }
  const diff = row.diffStats as Record<string, unknown>;
  if (![diff.files, diff.insertions, diff.deletions].every((entry) => typeof entry === "number" && Number.isFinite(entry))) {
    throw new Error(`Working result ${key} diff stats are malformed`);
  }
  const changedPaths = (row.changedPaths as string[]).map(normalizeRelative);
  const baseStates = parseStates(row.baseStates, `Working result ${key} baseline`);
  const pathStates = parseStates(row.pathStates, `Working result ${key} paths`);
  if (changedPaths.some((file) => !baseStates[file] || !pathStates[file])) {
    throw new Error(`Working result ${key} does not contain every changed path`);
  }
  return {
    resultRevision: row.resultRevision as number,
    branchId: row.branchId,
    ...(typeof row.parentRef === "string" ? { parentRef: row.parentRef } : {}),
    changedPaths,
    baseStates,
    pathStates,
    diffStats: { files: diff.files as number, insertions: diff.insertions as number, deletions: diff.deletions as number },
    createdAt: row.createdAt,
  };
};

export class WorkingStateStore {
  private readonly context: WorkspaceRecoveryStorageContext;
  private readonly fsPromises: typeof fs.promises;
  private readonly pathModule: typeof path;
  private readonly catalogPath: string;
  private document: WorkingStateDocument;

  private constructor(options: WorkingStateStoreOptions, document: WorkingStateDocument) {
    this.context = options;
    this.fsPromises = options.fsPromises ?? fs.promises;
    this.pathModule = options.pathModule ?? path;
    this.catalogPath = this.pathModule.join(options.root, "working-state", catalogName(options.identity.workspaceId));
    this.document = document;
  }

  static async open(options: WorkingStateStoreOptions): Promise<WorkingStateStore> {
    const catalogPath = (options.pathModule ?? path).join(options.root, "working-state", catalogName(options.identity.workspaceId));
    let raw: unknown;
    try {
      raw = await readRecoveryJsonAtomic(catalogPath, { fsPromises: options.fsPromises ?? fs.promises });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      raw = null;
    }
    if (raw === null) {
      return new WorkingStateStore(options, {
        schemaVersion: SCHEMA_VERSION,
        workspaceId: options.identity.workspaceId,
        branches: {},
        draftBaselines: {},
        results: {},
      });
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Working-state catalog is malformed");
    const record = raw as Record<string, unknown>;
    if ((record.schemaVersion !== 1 && record.schemaVersion !== SCHEMA_VERSION) || record.workspaceId !== options.identity.workspaceId
      || !record.branches || typeof record.branches !== "object" || Array.isArray(record.branches)
      || !record.results || typeof record.results !== "object" || Array.isArray(record.results)
      || (record.schemaVersion === SCHEMA_VERSION
        && (!record.draftBaselines || typeof record.draftBaselines !== "object" || Array.isArray(record.draftBaselines)))) {
      throw new Error("Working-state catalog schema or workspace identity is malformed");
    }
    const legacy = record.schemaVersion === 1;
    const branches = Object.fromEntries(Object.entries(record.branches as Record<string, unknown>)
      .map(([key, value]) => [key, parseBranch(value, key, options.identity.workspaceId, legacy)]));
    const draftBaselines = legacy ? {} : Object.fromEntries(Object.entries(record.draftBaselines as Record<string, unknown>)
      .map(([key, value]) => [key, parseDraftBaseline(value, key, options.identity.workspaceId)]));
    const results = Object.fromEntries(Object.entries(record.results as Record<string, unknown>)
      .map(([key, value]) => [key, parseResult(value, key)]));
    return new WorkingStateStore(options, {
      schemaVersion: SCHEMA_VERSION,
      workspaceId: options.identity.workspaceId,
      branches,
      draftBaselines,
      results,
    });
  }

  private references(states: Record<string, RecoveryState>, prefix: string) {
    return Object.entries(states).flatMap(([file, state]) => state.kind === "regular-file"
      ? [{ slot: `${prefix}:${file}`, objectHash: state.objectHash }]
      : []);
  }

  private protectBranch(branch: WorkingBranch): void {
    replaceObjectReferences(this.context.database, branch.workspaceId, "work-branch", branch.branchId, [
      ...this.references(branch.baseState, "base"),
      ...this.references(branch.deltas, "delta"),
    ]);
  }

  private protectDraftBaseline(baseline: DraftBaseline): void {
    replaceObjectReferences(this.context.database, baseline.workspaceId, "draft-baseline", baseline.id, [
      ...this.references(baseline.pathStates, "draft"),
    ]);
  }

  private protectResult(result: WorkingResult): void {
    replaceObjectReferences(this.context.database, this.document.workspaceId, "thread-result", `${result.branchId}@${result.resultRevision}`, [
      ...this.references(result.baseStates, "base"),
      ...this.references(result.pathStates, "result"),
    ]);
  }

  private async persist(next: WorkingStateDocument, protect: () => void): Promise<void> {
    this.context.database.transaction(protect).immediate();
    await writeRecoveryJsonAtomic(this.catalogPath, next, { fsPromises: this.fsPromises, pathModule: this.pathModule });
    this.document = next;
  }

  async putObject(bytes: Buffer): Promise<{ hash: string; byteLength: number }> {
    const hash = `sha256-${createHash("sha256").update(bytes).digest("hex")}`;
    const target = objectPath(this.context.root, hash);
    await this.fsPromises.mkdir(this.pathModule.dirname(target), { recursive: true, mode: 0o700 });
    try {
      const existing = await this.fsPromises.readFile(target);
      const actual = `sha256-${createHash("sha256").update(existing).digest("hex")}`;
      if (actual !== hash) throw new Error(`Working-state object is corrupt: ${hash}`);
      return { hash, byteLength: bytes.length };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const staging = this.pathModule.join(this.context.root, "staging", `${randomUUID()}.working-object`);
    await this.fsPromises.mkdir(this.pathModule.dirname(staging), { recursive: true, mode: 0o700 });
    let handle: fs.promises.FileHandle | undefined;
    try {
      handle = await this.fsPromises.open(staging, "wx", 0o600);
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      handle = undefined;
      try {
        await this.fsPromises.rename(staging, target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        await this.fsPromises.rm(staging, { force: true });
      }
    } finally {
      await handle?.close().catch(() => undefined);
      await this.fsPromises.rm(staging, { force: true }).catch(() => undefined);
    }
    return { hash, byteLength: bytes.length };
  }

  async getObject(hash: string): Promise<Buffer | null> {
    try {
      const bytes = await this.fsPromises.readFile(objectPath(this.context.root, hash));
      const actual = `sha256-${createHash("sha256").update(bytes).digest("hex")}`;
      if (actual !== hash) throw new Error(`Working-state object is corrupt: ${hash}`);
      return bytes;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  getBranch(branchId: string): WorkingBranch | null {
    const branch = this.document.branches[branchId];
    return branch ? clone(branch) : null;
  }

  async getDraftBaseline(id: string): Promise<DraftBaseline | null> {
    const baseline = this.document.draftBaselines[id];
    if (!baseline) return null;
    for (const [file, state] of Object.entries(baseline.pathStates)) {
      if (state.kind !== "regular-file" || await this.getObject(state.objectHash) === null) {
        throw new Error(`Draft baseline ${id} content is missing for ${file}`);
      }
    }
    return clone(baseline);
  }

  getResult(branchId: string, revision: number): WorkingResult | null {
    const result = this.document.results[`${branchId}@${revision}`];
    return result ? clone(result) : null;
  }

  resultState(branchId: string, revision: number): Record<string, RecoveryState> | null {
    const branch = this.document.branches[branchId];
    const result = this.document.results[`${branchId}@${revision}`];
    if (!branch || !result) return null;
    return { ...clone(branch.baseState), ...clone(result.pathStates) };
  }

  async createBranch(
    workspaceId: string,
    branchId: string,
    baseState: Record<string, RecoveryState>,
    baseRef?: string,
    draftBasePaths: string[] = [],
  ): Promise<WorkingBranch> {
    if (workspaceId !== this.document.workspaceId) throw new Error(`Working-state workspace mismatch: ${workspaceId}`);
    const existing = this.document.branches[branchId];
    if (existing) return clone(existing);
    const normalizedDraftBasePaths = [...new Set(draftBasePaths.map(normalizeRelative))].sort();
    if (normalizedDraftBasePaths.some((file) => !Object.hasOwn(baseState, file))) {
      throw new Error(`Working branch ${branchId} does not contain every draft baseline path`);
    }
    const now = new Date().toISOString();
    const branch: WorkingBranch = {
      branchId,
      workspaceId,
      ...(baseRef ? { baseRef } : {}),
      baseState: clone(baseState),
      draftBasePaths: normalizedDraftBasePaths,
      deltas: {},
      headRevision: 0,
      createdAt: now,
      updatedAt: now,
    };
    const next = clone(this.document);
    next.branches[branchId] = branch;
    await this.persist(next, () => this.protectBranch(branch));
    return clone(branch);
  }

  async createDraftBaseline(workspaceId: string, paths: readonly CreateDraftBaselinePath[]): Promise<DraftBaseline> {
    if (workspaceId !== this.document.workspaceId) throw new Error(`Working-state workspace mismatch: ${workspaceId}`);
    const id = `draft-${randomUUID()}`;
    const pathStates: Record<string, RecoveryState> = {};
    const provenance: Record<string, DraftBaselinePathProvenance> = {};
    const normalizedPaths = paths.map((pathInput) => ({ ...pathInput, path: normalizeRelative(pathInput.path) }));
    assertNoDraftPathConflicts(normalizedPaths.map((pathInput) => pathInput.path));
    for (const pathInput of normalizedPaths) {
      const file = pathInput.path;
      const bytes = typeof pathInput.content === "string" ? Buffer.from(pathInput.content, "utf8") : pathInput.content;
      const object = await this.putObject(bytes);
      pathStates[file] = {
        kind: "regular-file",
        objectHash: object.hash,
        byteLength: object.byteLength,
        ...(pathInput.mode === undefined ? {} : { mode: pathInput.mode }),
      };
      provenance[file] = clone(pathInput.provenance);
    }
    const baseline: DraftBaseline = {
      id,
      workspaceId,
      createdAt: new Date().toISOString(),
      pathStates,
      provenance,
    };
    const next = clone(this.document);
    next.draftBaselines[id] = baseline;
    await this.persist(next, () => this.protectDraftBaseline(baseline));
    return clone(baseline);
  }

  async importFixedResult(workspaceId: string, branchId: string, baseState: Record<string, RecoveryState>, resultState: Record<string, RecoveryState>, changedPaths: string[], parentRef?: string): Promise<WorkingResult> {
    let branch = this.document.branches[branchId];
    if (!branch) branch = await this.createBranch(workspaceId, branchId, baseState, parentRef);
    return this.publishStates(branchId, resultState, changedPaths);
  }

  async publishStates(branchId: string, capturedState: Record<string, RecoveryState>, knownChangedPaths?: string[]): Promise<WorkingResult> {
    const branch = this.document.branches[branchId];
    if (!branch) throw new Error(`Working branch not found: ${branchId}`);
    const candidates = knownChangedPaths
      ? [...new Set(knownChangedPaths.map(normalizeRelative))]
      : [...new Set([...Object.keys(branch.baseState), ...Object.keys(capturedState)])];
    const changedPaths = candidates.filter((file) => !sameState(
      branch.baseState[file] ?? { kind: "missing" },
      capturedState[file] ?? { kind: "missing" },
    )).sort();
    const baseStates: Record<string, RecoveryState> = Object.fromEntries(changedPaths.map((file) => [
      file,
      clone(branch.baseState[file] ?? { kind: "missing" as const }),
    ]));
    const pathStates: Record<string, RecoveryState> = Object.fromEntries(changedPaths.map((file) => [
      file,
      clone(capturedState[file] ?? { kind: "missing" as const }),
    ]));
    const previous = this.document.results[`${branchId}@${branch.headRevision}`];
    if (previous && previous.changedPaths.length === changedPaths.length
      && previous.changedPaths.every((file, index) => file === changedPaths[index]
        && sameState(previous.baseStates[file]!, baseStates[file]!)
        && sameState(previous.pathStates[file]!, pathStates[file]!))) {
      return clone(previous);
    }
    const revision = branch.headRevision + 1;
    const result: WorkingResult = {
      resultRevision: revision,
      branchId,
      ...(branch.baseRef ? { parentRef: branch.baseRef } : {}),
      changedPaths,
      baseStates,
      pathStates,
      diffStats: { files: changedPaths.length, insertions: 0, deletions: 0 },
      createdAt: new Date().toISOString(),
    };
    const next = clone(this.document);
    next.branches[branchId] = { ...clone(branch), deltas: clone(pathStates), headRevision: revision, updatedAt: result.createdAt };
    next.results[`${branchId}@${revision}`] = result;
    await this.persist(next, () => {
      this.protectBranch(next.branches[branchId]!);
      this.protectResult(result);
    });
    return clone(result);
  }

  async publishDirectoryResult(branchId: string, directory: string, changedPaths?: string[]): Promise<WorkingResult> {
    if (!changedPaths) return this.publishStates(branchId, await this.captureDirectory(directory));
    const branch = this.document.branches[branchId];
    if (!branch) throw new Error(`Working branch not found: ${branchId}`);
    const changed = changedPaths.map(normalizeRelative);
    const ancestors = changed.flatMap((file) => {
      const result: string[] = [];
      let parent = this.pathModule.posix.dirname(file);
      while (parent !== "." && parent !== "/") {
        result.push(parent);
        parent = this.pathModule.posix.dirname(parent);
      }
      return result;
    });
    const candidates = [...new Set([
      ...branch.draftBasePaths,
      ...changed,
      ...ancestors,
    ])];
    return this.publishStates(branchId, await this.captureDirectory(directory, candidates), candidates);
  }

  async materializeResult(branchId: string, revision: number, directory: string): Promise<void> {
    const states = this.resultState(branchId, revision);
    if (!states) throw new Error(`Working result not found: ${branchId}@${revision}`);
    await materializeWorkingState({
      targetDir: directory,
      states,
      readContent: async (state) => state.kind === "regular-file" ? this.getObject(state.objectHash) : null,
      cleanUnreferenced: true,
      fsPromises: this.fsPromises,
      pathModule: this.pathModule,
    });
  }

  async materializeStates(states: Record<string, RecoveryState>, directory: string): Promise<void> {
    await materializeWorkingState({
      targetDir: directory,
      states,
      readContent: async (state) => state.kind === "regular-file" ? this.getObject(state.objectHash) : null,
      fsPromises: this.fsPromises,
      pathModule: this.pathModule,
    });
  }

  async directoryMatchesResult(branchId: string, revision: number, directory: string): Promise<boolean> {
    const expected = this.resultState(branchId, revision);
    if (!expected) return false;
    const files = await this.scanDirectoryRelative(directory);
    const candidates = new Set([...Object.keys(expected), ...files]);
    const identity = { ...this.context.identity, canonicalRoot: directory };
    for (const file of candidates) {
      const actual = (await this.context.fileStore.captureState(identity, this.context.root, file, { store: false })).state;
      if (!sameState(actual, expected[file] ?? { kind: "missing" })) return false;
    }
    return true;
  }

  async deleteBranch(branchId: string): Promise<void> {
    if (!this.document.branches[branchId]) return;
    const next = clone(this.document);
    delete next.branches[branchId];
    await this.persist(next, () => deleteObjectReferences(this.context.database, this.document.workspaceId, "work-branch", branchId));
  }

  async deleteDraftBaseline(id: string): Promise<void> {
    if (!this.document.draftBaselines[id]) return;
    const next = clone(this.document);
    delete next.draftBaselines[id];
    await this.persist(next, () => deleteObjectReferences(this.context.database, this.document.workspaceId, "draft-baseline", id));
  }

  async deleteResult(branchId: string, revision: number): Promise<void> {
    const key = `${branchId}@${revision}`;
    if (!this.document.results[key]) return;
    const next = clone(this.document);
    delete next.results[key];
    await this.persist(next, () => deleteObjectReferences(this.context.database, this.document.workspaceId, "thread-result", key));
  }

  async captureDirectory(directory: string, relativePaths?: string[]): Promise<Record<string, RecoveryState>> {
    const result: Record<string, RecoveryState> = {};
    const files = relativePaths?.map(normalizeRelative) ?? await this.scanDirectoryRelative(directory);
    const identity = { ...this.context.identity, canonicalRoot: directory };
    for (const file of files) {
      const captured = await this.context.fileStore.captureState(identity, this.context.root, file, { store: true });
      result[file] = captured.state;
    }
    return result;
  }

  private async scanDirectoryRelative(directory: string, base = directory): Promise<string[]> {
    const result: string[] = [];
    const entries = await this.fsPromises.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === ".piarium") continue;
      const absolute = this.pathModule.join(directory, entry.name);
      const relative = normalizeRelative(this.pathModule.relative(base, absolute));
      if (entry.isDirectory()) {
        result.push(relative);
        result.push(...await this.scanDirectoryRelative(absolute, base));
      } else {
        result.push(relative);
      }
    }
    return result.sort();
  }
}

export const createWorkspaceWorkingStateAccess = (recovery: Pick<WorkspaceRecoveryEngine, "withWorkspaceStorage">): WorkspaceWorkingStateAccess => ({
  withStore: (workspaceId, purpose, operation, mode = "exclusive") => recovery.withWorkspaceStorage(
    workspaceId,
    { mode, purpose },
    async (context) => operation(await WorkingStateStore.open(context), context),
  ),
});
