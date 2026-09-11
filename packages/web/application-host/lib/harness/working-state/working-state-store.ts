import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { assertAbsolutePathInWorkspace } from "../../workspace/path-safety.js";
import type { WorkspaceRecoveryEngine, WorkspaceRecoveryStorageContext } from "../../recovery/journal-engine.js";
import { objectPath, replaceObjectReferences, deleteObjectReferences } from "../../recovery/journal-catalog.js";
import { parseRecoveryState, sameState } from "../../recovery/journal-files.js";
import { readRecoveryJsonAtomic, writeRecoveryJsonAtomic } from "../../recovery/locations.js";
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
  WorkingStateVerifications,
} from "./types.js";
import { materializeWorkingState } from "./materializer.js";

const SCHEMA_VERSION = 3;
const catalogName = (workspaceId: string): string => `${createHash("sha256").update(workspaceId).digest("hex")}.json`;

interface WorkingStateDocument {
  schemaVersion: typeof SCHEMA_VERSION;
  workspaceId: string;
  branches: Record<string, WorkingBranch>;
  draftBaselines: Record<string, DraftBaseline>;
  results: Record<string, WorkingResult>;
  verifications?: WorkingStateVerifications;
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
export const treeIdentityFromStates = (states: Record<string, RecoveryState>): string => {
  const hash = createHash("sha256");
  for (const file of Object.keys(states).sort()) {
    const state = states[file]!;
    hash.update(file);
    hash.update("\0");
    hash.update(JSON.stringify([
      state.kind,
      "mode" in state ? state.mode ?? null : null,
      state.kind === "regular-file" ? state.byteLength : null,
      state.kind === "regular-file" ? state.objectHash : null,
      state.kind === "symlink" ? state.symlinkTarget : null,
    ]));
    hash.update("\0");
  }
  return `sha256-${hash.digest("hex")}`;
};
const normalizeRelative = (value: string): string => {
  const raw = value.replace(/\\/g, "/");
  const segments = raw.split("/").filter((segment) => segment && segment !== ".");
  const normalized = segments.join("/");
  if (!normalized || raw.includes("\0") || raw.startsWith("/") || /^[A-Za-z]:/.test(raw) || segments.includes("..")) {
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

type WorkingStateSchemaVersion = 1 | 2 | 3;

const parseBranch = (
  value: unknown,
  key: string,
  workspaceId: string,
  schemaVersion: WorkingStateSchemaVersion,
): WorkingBranch => {
  const legacy = schemaVersion === 1;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Working branch ${key} is malformed`);
  const row = value as Record<string, unknown>;
  if (row.branchId !== key || row.workspaceId !== workspaceId || !Number.isSafeInteger(row.headRevision)
    || Number(row.headRevision) < 0 || typeof row.createdAt !== "string" || typeof row.updatedAt !== "string"
    || (row.baseRef !== undefined && typeof row.baseRef !== "string")
    || (!legacy && (!Array.isArray(row.draftBasePaths) || !row.draftBasePaths.every((entry) => typeof entry === "string")))
    || (schemaVersion === 3 && (!Array.isArray(row.captureScopes) || !row.captureScopes.every((entry) => typeof entry === "string")))) {
    throw new Error(`Working branch ${key} is malformed`);
  }
  const draftBasePaths = legacy ? [] : (row.draftBasePaths as string[]).map(normalizeRelative);
  if (new Set(draftBasePaths).size !== draftBasePaths.length) throw new Error(`Working branch ${key} draft baseline paths are malformed`);
  const rawCaptureScopes = schemaVersion === 3 ? row.captureScopes as string[] : [];
  const captureScopes = legacy ? [] : [...new Set(rawCaptureScopes.map(normalizeRelative))].sort();
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
    captureScopes,
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

const isSafeInt = (value: unknown): value is number => Number.isSafeInteger(value);
const isOptionalString = (value: unknown): value is string | undefined => value === undefined || typeof value === "string";

const parseCommandRecord = (value: unknown, label: string): CommandVerificationRecord => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is malformed`);
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "string" || typeof row.runId !== "string" || typeof row.command !== "string"
    || typeof row.cwd !== "string" || !isSafeInt(row.startedAt) || !isSafeInt(row.endedAt)
    || (row.exitCode !== null && !isSafeInt(row.exitCode)) || typeof row.cancelled !== "boolean"
    || (row.relationToPublished !== "same-run-matching-result"
      && row.relationToPublished !== "post-merge-matching-tree"
      && row.relationToPublished !== "same-run-before-publish"
      && row.relationToPublished !== "unbound"
      && row.relationToPublished !== "uncertain")
    || (row.inputChangedDuringRun !== null && typeof row.inputChangedDuringRun !== "boolean")
    || !row.inputIdentity || typeof row.inputIdentity !== "object" || Array.isArray(row.inputIdentity)) {
    throw new Error(`${label} is malformed`);
  }
  const identity = row.inputIdentity as Record<string, unknown>;
  if (identity.kind !== "tree" && identity.kind !== "published-revision" && identity.kind !== "unbound") {
    throw new Error(`${label} identity is malformed`);
  }
  const actor = row.actor && typeof row.actor === "object" && !Array.isArray(row.actor)
    ? row.actor as Record<string, unknown>
    : null;
  if (actor && (typeof actor.authorityInstanceId !== "string" || typeof actor.sessionId !== "string"
    || typeof actor.workerId !== "string" || !isSafeInt(actor.workerGeneration)
    || (actor.runId !== undefined && typeof actor.runId !== "string"))) {
    throw new Error(`${label} actor is malformed`);
  }
  const legacyIdentity = identity.kind === "published-revision" || row.relationToPublished === "same-run-before-publish";
  return {
    id: row.id,
    runId: row.runId,
    command: row.command,
    cwd: row.cwd,
    ...(row.envSummary && typeof row.envSummary === "object" && !Array.isArray(row.envSummary)
      ? { envSummary: row.envSummary as { PATH?: boolean; VIRTUAL_ENV?: string } }
      : {}),
    ...(typeof row.commandRunId === "string" ? { commandRunId: row.commandRunId } : {}),
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    exitCode: row.exitCode as number | null,
    cancelled: row.cancelled,
    ...(typeof row.outputHandle === "string" ? { outputHandle: row.outputHandle } : {}),
    ...(typeof row.outputPreview === "string" ? { outputPreview: row.outputPreview } : {}),
    actor: actor
      ? {
          authorityInstanceId: actor.authorityInstanceId as string,
          sessionId: actor.sessionId as string,
          workerId: actor.workerId as string,
          workerGeneration: actor.workerGeneration as number,
          ...(typeof actor.runId === "string" ? { runId: actor.runId } : {}),
        }
      : { authorityInstanceId: "unknown", sessionId: "unknown", workerId: "unknown", workerGeneration: 0 },
    bindingGeneration: isSafeInt(row.bindingGeneration) ? row.bindingGeneration : 0,
    inputIdentity: legacyIdentity
      ? { kind: "unbound", reason: "legacy command record has no captured tree identity" }
      : {
          kind: identity.kind as "tree" | "unbound",
          ...(typeof identity.branchId === "string" ? { branchId: identity.branchId } : {}),
          ...(typeof identity.root === "string" ? { root: identity.root } : {}),
          ...(typeof identity.startTreeHash === "string" ? { startTreeHash: identity.startTreeHash } : {}),
          ...(typeof identity.endTreeHash === "string" ? { endTreeHash: identity.endTreeHash } : {}),
          ...(typeof identity.reason === "string" ? { reason: identity.reason } : {}),
        },
    inputChangedDuringRun: legacyIdentity ? null : row.inputChangedDuringRun as boolean | null,
    relationToPublished: legacyIdentity ? "uncertain" : row.relationToPublished as CommandVerificationRecord["relationToPublished"],
  };
};

const parseChildBundle = (value: unknown, label: string): ResultVerificationBundle => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is malformed`);
  const row = value as Record<string, unknown>;
  if (!isSafeInt(row.resultRevision) || Number(row.resultRevision) <= 0 || typeof row.branchId !== "string"
    || !isSafeInt(row.recordedAt) || (row.binding !== "bound" && row.binding !== "uncertain")
    || !Array.isArray(row.checks) || !isOptionalString(row.bindingReason) || !isOptionalString(row.resultTreeHash)) {
    throw new Error(`${label} is malformed`);
  }
  return {
    resultRevision: row.resultRevision,
    branchId: row.branchId,
    ...(typeof row.resultTreeHash === "string" ? { resultTreeHash: row.resultTreeHash } : {}),
    recordedAt: row.recordedAt,
    binding: row.binding,
    ...(typeof row.bindingReason === "string" ? { bindingReason: row.bindingReason } : {}),
    checks: row.checks.map((check, index) => parseCommandRecord(check, `${label} check ${index}`)),
  };
};

const parseParentBundle = (value: unknown, label: string): ParentVerificationBundle => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is malformed`);
  const row = value as Record<string, unknown>;
  const bindings = new Set(["bound", "uncertain", "cannot-verify-unsaved-draft", "not-recorded", "not-integrated"]);
  if (!isSafeInt(row.mergedResultRevision) || Number(row.mergedResultRevision) <= 0 || !isSafeInt(row.recordedAt)
    || typeof row.draftUnsaved !== "boolean" || !bindings.has(row.binding as string) || !Array.isArray(row.checks)
    || !isOptionalString(row.note) || !isOptionalString(row.mergeOperationId)
    || !isOptionalString(row.parentTreeHash)
    || (row.windowOpenedAt !== undefined && !isSafeInt(row.windowOpenedAt))) {
    throw new Error(`${label} is malformed`);
  }
  return {
    mergedResultRevision: row.mergedResultRevision,
    ...(typeof row.mergeOperationId === "string" ? { mergeOperationId: row.mergeOperationId } : {}),
    ...(typeof row.parentTreeHash === "string" ? { parentTreeHash: row.parentTreeHash } : {}),
    ...(isSafeInt(row.windowOpenedAt) ? { windowOpenedAt: row.windowOpenedAt } : {}),
    recordedAt: row.recordedAt,
    draftUnsaved: row.draftUnsaved,
    binding: row.binding as ParentVerificationBundle["binding"],
    ...(typeof row.note === "string" ? { note: row.note } : {}),
    checks: row.checks.map((check, index) => parseCommandRecord(check, `${label} check ${index}`)),
  };
};

const parseReviewRecord = (value: unknown, label: string): ResultReviewRecord => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is malformed`);
  const row = value as Record<string, unknown>;
  const statuses = new Set(["running", "completed", "failed", "cancelled"]);
  if (!isSafeInt(row.resultRevision) || Number(row.resultRevision) <= 0 || !statuses.has(row.status as string)
    || !isSafeInt(row.recordedAt) || (row.gate !== undefined && typeof row.gate !== "boolean")) {
    throw new Error(`${label} is malformed`);
  }
  return {
    resultRevision: row.resultRevision,
    status: row.status as ResultReviewRecord["status"],
    recordedAt: row.recordedAt,
    ...(typeof row.reviewThreadId === "string" ? { reviewThreadId: row.reviewThreadId } : {}),
    ...(typeof row.reviewRunId === "string" ? { reviewRunId: row.reviewRunId } : {}),
    ...(typeof row.gate === "boolean" ? { gate: row.gate } : {}),
    ...(typeof row.conclusion === "string" ? { conclusion: row.conclusion } : {}),
    ...(Array.isArray(row.findings)
      ? {
          findings: row.findings.map((item) => {
            if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`${label} finding is malformed`);
            const finding = item as Record<string, unknown>;
            if (typeof finding.severity !== "string" || typeof finding.message !== "string") {
              throw new Error(`${label} finding is malformed`);
            }
            return {
              severity: finding.severity,
              message: finding.message,
              ...(typeof finding.file === "string" ? { file: finding.file } : {}),
              ...(isSafeInt(finding.line) ? { line: finding.line } : {}),
            };
          }),
        }
      : {}),
    ...(typeof row.error === "string" ? { error: row.error } : {}),
  };
};

const parseMap = <T>(value: unknown, label: string, parse: (item: unknown, itemLabel: string) => T): Record<string, T[]> => {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, items]) => {
    if (!Array.isArray(items)) throw new Error(`${label} ${key} must be an array`);
    return [key, items.map((item, index) => parse(item, `${label} ${key} ${index}`))];
  }));
};

const parseVerifications = (value: unknown): WorkingStateVerifications | undefined => {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Working-state verifications are malformed");
  const row = value as Record<string, unknown>;
  return {
    child: parseMap(row.child, "Working-state child verifications", parseChildBundle),
    parent: parseMap(row.parent, "Working-state parent verifications", parseParentBundle),
    reviews: parseMap(row.reviews, "Working-state reviews", parseReviewRecord),
  };
};

const emptyVerifications = (): WorkingStateVerifications => ({ child: {}, parent: {}, reviews: {} });

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
    if ((record.schemaVersion !== 1 && record.schemaVersion !== 2 && record.schemaVersion !== SCHEMA_VERSION) || record.workspaceId !== options.identity.workspaceId
      || !record.branches || typeof record.branches !== "object" || Array.isArray(record.branches)
      || !record.results || typeof record.results !== "object" || Array.isArray(record.results)
      || (record.schemaVersion !== 1
        && (!record.draftBaselines || typeof record.draftBaselines !== "object" || Array.isArray(record.draftBaselines)))) {
      throw new Error("Working-state catalog schema or workspace identity is malformed");
    }
    const legacy = record.schemaVersion === 1;
    const branches = Object.fromEntries(Object.entries(record.branches as Record<string, unknown>)
      .map(([key, value]) => [key, parseBranch(value, key, options.identity.workspaceId, record.schemaVersion as WorkingStateSchemaVersion)]));
    const draftBaselines = legacy ? {} : Object.fromEntries(Object.entries(record.draftBaselines as Record<string, unknown>)
      .map(([key, value]) => [key, parseDraftBaseline(value, key, options.identity.workspaceId)]));
    const results = Object.fromEntries(Object.entries(record.results as Record<string, unknown>)
      .map(([key, value]) => [key, parseResult(value, key)]));
    const verifications = parseVerifications(record.verifications);
    return new WorkingStateStore(options, {
      schemaVersion: SCHEMA_VERSION,
      workspaceId: options.identity.workspaceId,
      branches,
      draftBaselines,
      results,
      ...(verifications ? { verifications } : {}),
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

  getDraftBaselineRecord(id: string): DraftBaseline | null {
    const baseline = this.document.draftBaselines[id];
    return baseline ? clone(baseline) : null;
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

  listResults(branchId?: string): WorkingResult[] {
    return Object.values(this.document.results)
      .filter((result) => branchId === undefined || result.branchId === branchId)
      .map((result) => clone(result));
  }

  getResult(branchId: string, revision: number): WorkingResult | null {
    const result = this.document.results[`${branchId}@${revision}`];
    return result ? clone(result) : null;
  }

  getChildVerification(threadId: string, resultRevision: number): ResultVerificationBundle | null {
    const match = this.document.verifications?.child[threadId]?.find((bundle) => bundle.resultRevision === resultRevision);
    return match ? clone(match) : null;
  }

  listChildVerifications(threadId: string): ResultVerificationBundle[] {
    return (this.document.verifications?.child[threadId] ?? []).map((bundle) => clone(bundle));
  }

  getParentVerification(threadId: string, mergedResultRevision?: number): ParentVerificationBundle | null {
    const list = this.document.verifications?.parent[threadId] ?? [];
    const match = mergedResultRevision === undefined
      ? list.reduce<ParentVerificationBundle | undefined>((latest, bundle) => (
          !latest || (bundle.windowOpenedAt ?? bundle.recordedAt) >= (latest.windowOpenedAt ?? latest.recordedAt) ? bundle : latest
        ), undefined)
      : list.find((bundle) => bundle.mergedResultRevision === mergedResultRevision);
    return match ? clone(match) : null;
  }

  listParentVerifications(threadId: string): ParentVerificationBundle[] {
    return (this.document.verifications?.parent[threadId] ?? []).map((bundle) => clone(bundle));
  }

  getReviewRecord(threadId: string, resultRevision: number): ResultReviewRecord | null {
    const match = this.document.verifications?.reviews[threadId]?.find((record) => record.resultRevision === resultRevision);
    return match ? clone(match) : null;
  }

  listReviewRecords(threadId: string): ResultReviewRecord[] {
    return (this.document.verifications?.reviews[threadId] ?? []).map((record) => clone(record));
  }

  async putChildVerification(threadId: string, bundle: ResultVerificationBundle): Promise<void> {
    const next = clone(this.document);
    const verifications = next.verifications ?? emptyVerifications();
    const current = verifications.child[threadId] ?? [];
    verifications.child[threadId] = [
      ...current.filter((item) => item.resultRevision !== bundle.resultRevision),
      clone(bundle),
    ].sort((left, right) => left.resultRevision - right.resultRevision);
    next.verifications = verifications;
    await this.persist(next, () => undefined);
  }

  async putParentVerification(threadId: string, bundle: ParentVerificationBundle): Promise<void> {
    const next = clone(this.document);
    const verifications = next.verifications ?? emptyVerifications();
    const current = verifications.parent[threadId] ?? [];
    verifications.parent[threadId] = [
      ...current.filter((item) => item.mergedResultRevision !== bundle.mergedResultRevision),
      clone(bundle),
    ].sort((left, right) => left.mergedResultRevision - right.mergedResultRevision);
    next.verifications = verifications;
    await this.persist(next, () => undefined);
  }

  async putReviewRecord(threadId: string, record: ResultReviewRecord): Promise<void> {
    const next = clone(this.document);
    const verifications = next.verifications ?? emptyVerifications();
    const current = verifications.reviews[threadId] ?? [];
    verifications.reviews[threadId] = [
      ...current.filter((item) => item.resultRevision !== record.resultRevision),
      clone(record),
    ].sort((left, right) => left.resultRevision - right.resultRevision);
    next.verifications = verifications;
    await this.persist(next, () => undefined);
  }

  resultState(branchId: string, revision: number): Record<string, RecoveryState> | null {
    const branch = this.document.branches[branchId];
    const result = this.document.results[`${branchId}@${revision}`];
    if (!branch || !result) return null;
    return { ...clone(branch.baseState), ...clone(result.pathStates) };
  }

  /**
   * Current Host branch view: fixed base plus published/in-flight deltas.
   * Revision 0 (no published result) is a valid empty-delta view.
   */
  effectiveState(branchId: string, revision?: number): Record<string, RecoveryState> | null {
    const branch = this.document.branches[branchId];
    if (!branch) return null;
    if (revision !== undefined && revision > 0) return this.resultState(branchId, revision);
    return { ...clone(branch.baseState), ...clone(branch.deltas) };
  }

  pathOrigin(branchId: string, file: string): "base" | "delta" | "draft-base" | null {
    const branch = this.document.branches[branchId];
    if (!branch) return null;
    const normalized = normalizeRelative(file);
    if (Object.hasOwn(branch.deltas, normalized)) return "delta";
    if (branch.draftBasePaths.includes(normalized)) return "draft-base";
    if (Object.hasOwn(branch.baseState, normalized)) return "base";
    return null;
  }

  resultTreeIdentity(branchId: string, revision: number): string | null {
    const states = this.resultState(branchId, revision);
    return states ? treeIdentityFromStates(states) : null;
  }

  async captureBranchCandidateIdentity(branchId: string, directory: string, changedPaths: string[]): Promise<string | null> {
    const branch = this.document.branches[branchId];
    if (!branch) return null;
    const candidates = await this.branchCaptureCandidates(branch, directory, changedPaths);
    const captured: Record<string, RecoveryState> = {};
    const identity = { ...this.context.identity, canonicalRoot: directory };
    for (const file of candidates) {
      captured[file] = (await this.context.fileStore.captureState(identity, this.context.root, file, { store: false })).state;
    }
    const effective = clone(branch.baseState);
    for (const [file, state] of Object.entries(captured)) {
      if (state.kind === "missing" && !Object.hasOwn(branch.baseState, file)) delete effective[file];
      else effective[file] = state;
    }
    return treeIdentityFromStates(effective);
  }

  async captureSeededPathIdentity(directory: string, changedPaths: string[], seed: string): Promise<string> {
    const candidates = [...new Set(changedPaths.map(normalizeRelative).flatMap((file) => {
      const paths = [file];
      let parent = this.pathModule.posix.dirname(file);
      while (parent !== "." && parent !== "/") {
        paths.push(parent);
        parent = this.pathModule.posix.dirname(parent);
      }
      return paths;
    }))].sort();
    const captured: Record<string, RecoveryState> = {};
    const identity = { ...this.context.identity, canonicalRoot: directory };
    for (const file of candidates) {
      captured[file] = (await this.context.fileStore.captureState(identity, this.context.root, file, { store: false })).state;
    }
    return `sha256-${createHash("sha256").update(seed).update("\0").update(treeIdentityFromStates(captured)).digest("hex")}`;
  }

  async createBranch(
    workspaceId: string,
    branchId: string,
    baseState: Record<string, RecoveryState>,
    baseRef?: string,
    draftBasePaths: string[] = [],
    captureScopes: string[] = [],
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
      captureScopes: [...new Set(captureScopes.map(normalizeRelative))].sort(),
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

  async publishHeadResult(branchId: string): Promise<WorkingResult> {
    const states = this.effectiveState(branchId);
    if (!states) throw new Error(`Working branch not found: ${branchId}`);
    return this.publishStates(branchId, states);
  }

  async publishDirectoryResult(branchId: string, directory: string, changedPaths?: string[]): Promise<WorkingResult> {
    if (!changedPaths) return this.publishStates(branchId, await this.captureDirectory(directory));
    const branch = this.document.branches[branchId];
    if (!branch) throw new Error(`Working branch not found: ${branchId}`);
    const candidates = await this.branchCaptureCandidates(branch, directory, changedPaths);
    return this.publishStates(branchId, await this.captureDirectory(directory, candidates), candidates);
  }

  private async branchCaptureCandidates(branch: WorkingBranch, directory: string, changedPaths: string[]): Promise<string[]> {
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
    const currentPaths = await this.scanCaptureScopes(directory, branch.captureScopes);
    const scopePaths = branch.captureScopes.flatMap((scope) => [
      scope,
      ...Object.keys(branch.baseState).filter((file) => file === scope || file.startsWith(`${scope}/`)),
      ...currentPaths.filter((file) => file === scope || file.startsWith(`${scope}/`)),
    ]);
    return [...new Set([
      ...branch.draftBasePaths,
      ...scopePaths,
      ...changed,
      ...ancestors,
    ])];
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

  private async scanCaptureScopes(directory: string, scopes: readonly string[]): Promise<string[]> {
    const normalizedScopes = [...new Set(scopes.map(normalizeRelative))].sort();
    const minimalScopes = normalizedScopes.filter((scope, index) => (
      !normalizedScopes.slice(0, index).some((parent) => scope.startsWith(`${parent}/`))
    ));
    const result = new Set<string>();
    const visit = async (relative: string): Promise<void> => {
      const absolute = this.pathModule.resolve(directory, ...relative.split("/"));
      await assertAbsolutePathInWorkspace(absolute, {
        root: directory,
        fsPromises: this.fsPromises,
        pathModule: this.pathModule,
        allowMissing: true,
      });
      let stat: fs.Stats;
      try {
        stat = await this.fsPromises.lstat(absolute);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      result.add(relative);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return;
      const entries = await this.fsPromises.readdir(absolute, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name === ".git" || entry.name === ".piarium") continue;
        await visit(normalizeRelative(`${relative}/${entry.name}`));
      }
    };
    for (const scope of minimalScopes) await visit(scope);
    return [...result].sort();
  }
}

export const createWorkspaceWorkingStateAccess = (recovery: Pick<WorkspaceRecoveryEngine, "withWorkspaceStorage">): WorkspaceWorkingStateAccess => ({
  withStore: (workspaceId, purpose, operation, mode = "exclusive") => recovery.withWorkspaceStorage(
    workspaceId,
    { mode, purpose },
    async (context) => operation(await WorkingStateStore.open(context), context),
  ),
});
