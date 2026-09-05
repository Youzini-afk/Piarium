import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  RecoveryState,
  RegularFileState,
  SymlinkState,
  WorkingBranch,
  WorkingResult,
} from "./types.js";
import type { SqliteDatabase } from "../../recovery/journal-catalog.js";
import {
  replaceObjectReferences,
  deleteObjectReferences,
} from "../../recovery/journal-catalog.js";

export interface WorkingStateStoreOptions {
  storageDir: string;
  database?: SqliteDatabase | undefined;
  fsPromises?: typeof fs.promises | undefined;
  pathModule?: typeof path | undefined;
}

export class WorkingStateStore {
  private readonly storageDir: string;
  private readonly objectsDir: string;
  private readonly database?: SqliteDatabase | undefined;
  private readonly fsPromises: typeof fs.promises;
  private readonly pathModule: typeof path;

  private readonly branches = new Map<string, WorkingBranch>();
  private readonly results = new Map<string, WorkingResult>();

  constructor(options: WorkingStateStoreOptions) {
    this.storageDir = options.storageDir;
    this.pathModule = options.pathModule ?? path;
    this.objectsDir = this.pathModule.join(this.storageDir, "objects");
    this.database = options.database;
    this.fsPromises = options.fsPromises ?? fs.promises;
    this.loadMetadata();
  }

  private loadMetadata(): void {
    try {
      const branchesFile = this.pathModule.join(this.storageDir, "branches.json");
      if (fs.existsSync(branchesFile)) {
        const raw = fs.readFileSync(branchesFile, "utf8");
        const parsed = JSON.parse(raw);
        for (const [k, v] of Object.entries(parsed)) {
          this.branches.set(k, v as WorkingBranch);
        }
      }
      const resultsFile = this.pathModule.join(this.storageDir, "results.json");
      if (fs.existsSync(resultsFile)) {
        const raw = fs.readFileSync(resultsFile, "utf8");
        const parsed = JSON.parse(raw);
        for (const [k, v] of Object.entries(parsed)) {
          this.results.set(k, v as WorkingResult);
        }
      }
    } catch {
      // Best effort load
    }
  }

  private persistMetadata(): void {
    try {
      if (!fs.existsSync(this.storageDir)) {
        fs.mkdirSync(this.storageDir, { recursive: true });
      }
      const branchesFile = this.pathModule.join(this.storageDir, "branches.json");
      const resultsFile = this.pathModule.join(this.storageDir, "results.json");
      const branchesObj = Object.fromEntries(this.branches.entries());
      const resultsObj = Object.fromEntries(this.results.entries());
      fs.writeFileSync(branchesFile, JSON.stringify(branchesObj, null, 2), "utf8");
      fs.writeFileSync(resultsFile, JSON.stringify(resultsObj, null, 2), "utf8");
    } catch {
      // Best effort persist
    }
  }

  private objectPath(hash: string): string {
    const raw = hash.startsWith("sha256-") ? hash.slice(7) : hash;
    const prefix = raw.slice(0, 2);
    const remainder = raw.slice(2);
    return this.pathModule.join(this.objectsDir, prefix, remainder);
  }

  async putObject(bytes: Buffer): Promise<{ hash: string; byteLength: number }> {
    const hex = createHash("sha256").update(bytes).digest("hex");
    const hash = `sha256-${hex}`;
    const target = this.objectPath(hash);
    await this.fsPromises.mkdir(this.pathModule.dirname(target), { recursive: true });
    try {
      await this.fsPromises.stat(target);
    } catch {
      await this.fsPromises.writeFile(target, bytes);
    }
    return { hash, byteLength: bytes.length };
  }

  async getObject(hash: string): Promise<Buffer | null> {
    const target = this.objectPath(hash);
    try {
      return await this.fsPromises.readFile(target);
    } catch {
      return null;
    }
  }

  async hasObject(hash: string): Promise<boolean> {
    const target = this.objectPath(hash);
    try {
      await this.fsPromises.stat(target);
      return true;
    } catch {
      return false;
    }
  }

  createBranch(
    workspaceId: string,
    branchId: string,
    baseState: Record<string, RecoveryState> = {},
    baseRef?: string,
  ): WorkingBranch {
    const now = new Date().toISOString();
    const branch: WorkingBranch = {
      branchId,
      workspaceId,
      baseRef,
      baseState: { ...baseState },
      deltas: {},
      headRevision: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.branches.set(branchId, branch);
    this.protectBranchObjects(branch);
    this.persistMetadata();
    return branch;
  }

  getBranch(branchId: string): WorkingBranch | null {
    return this.branches.get(branchId) ?? null;
  }

  updateBranchDeltas(
    branchId: string,
    deltas: Record<string, RecoveryState>,
  ): WorkingBranch {
    const branch = this.branches.get(branchId);
    if (!branch) throw new Error(`Working branch not found: ${branchId}`);

    branch.deltas = { ...branch.deltas, ...deltas };
    branch.updatedAt = new Date().toISOString();
    this.protectBranchObjects(branch);
    this.persistMetadata();
    return branch;
  }

  commitRevision(
    branchId: string,
    changedPaths: string[],
  ): WorkingResult {
    const branch = this.branches.get(branchId);
    if (!branch) throw new Error(`Working branch not found: ${branchId}`);

    branch.headRevision += 1;
    const rev = branch.headRevision;

    // Collect effective path states for this revision
    const pathStates: Record<string, RecoveryState> = {};
    for (const p of changedPaths) {
      pathStates[p] = branch.deltas[p] ?? branch.baseState[p] ?? { kind: "missing" };
    }

    const result: WorkingResult = {
      resultRevision: rev,
      branchId,
      parentRef: branch.baseRef,
      changedPaths: [...changedPaths],
      pathStates,
      diffStats: {
        files: changedPaths.length,
        insertions: 0,
        deletions: 0,
      },
      createdAt: new Date().toISOString(),
    };

    this.results.set(`${branchId}@${rev}`, result);
    this.protectResultObjects(branch.workspaceId, branchId, rev, result);
    this.persistMetadata();
    return result;
  }

  getResult(branchId: string, revision: number): WorkingResult | null {
    return this.results.get(`${branchId}@${revision}`) ?? null;
  }

  deleteBranch(workspaceId: string, branchId: string): void {
    this.branches.delete(branchId);
    if (this.database) {
      deleteObjectReferences(this.database, workspaceId, "work-branch", branchId);
    }
    this.persistMetadata();
  }

  deleteResult(workspaceId: string, branchId: string, revision: number): void {
    this.results.delete(`${branchId}@${revision}`);
    if (this.database) {
      deleteObjectReferences(this.database, workspaceId, "thread-result", `${branchId}@${revision}`);
    }
    this.persistMetadata();
  }

  private protectBranchObjects(branch: WorkingBranch): void {
    if (!this.database) return;
    const refs: Array<{ slot: string; objectHash: string }> = [];
    for (const [path, state] of Object.entries(branch.deltas)) {
      if (state.kind === "regular-file") {
        refs.push({ slot: `delta:${path}`, objectHash: state.objectHash });
      }
    }
    replaceObjectReferences(this.database, branch.workspaceId, "work-branch", branch.branchId, refs);
  }

  private protectResultObjects(
    workspaceId: string,
    branchId: string,
    revision: number,
    result: WorkingResult,
  ): void {
    if (!this.database) return;
    const refs: Array<{ slot: string; objectHash: string }> = [];
    for (const [path, state] of Object.entries(result.pathStates)) {
      if (state.kind === "regular-file") {
        refs.push({ slot: `result:${path}`, objectHash: state.objectHash });
      }
    }
    replaceObjectReferences(
      this.database,
      workspaceId,
      "thread-result",
      `${branchId}@${revision}`,
      refs,
    );
  }

  /**
   * Captures path states from an existing directory (fallback or non-git workspaces).
   */
  async captureDirectory(
    root: string,
    relativePaths?: string[],
  ): Promise<Record<string, RecoveryState>> {
    const result: Record<string, RecoveryState> = {};
    const pathsToScan = relativePaths ?? (await this.scanDirectoryRelative(root));

    for (const rel of pathsToScan) {
      const abs = this.pathModule.resolve(root, rel);
      try {
        const info = await this.fsPromises.lstat(abs);
        if (info.isSymbolicLink()) {
          const target = await this.fsPromises.readlink(abs);
          result[rel] = { kind: "symlink", symlinkTarget: target, mode: info.mode };
        } else if (info.isDirectory()) {
          result[rel] = { kind: "directory", mode: info.mode };
        } else if (info.isFile()) {
          const bytes = await this.fsPromises.readFile(abs);
          const { hash, byteLength } = await this.putObject(bytes);
          result[rel] = { kind: "regular-file", objectHash: hash, byteLength, mode: info.mode };
        } else {
          result[rel] = { kind: "unsupported" };
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          result[rel] = { kind: "missing" };
        } else {
          result[rel] = { kind: "unsupported" };
        }
      }
    }

    return result;
  }

  private async scanDirectoryRelative(dir: string, baseDir = dir): Promise<string[]> {
    const list: string[] = [];
    let entries: fs.Dirent[];
    try {
      entries = await this.fsPromises.readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const full = this.pathModule.join(dir, entry.name);
      const rel = this.pathModule.relative(baseDir, full).replace(/\\/g, "/");
      if (entry.isDirectory()) {
        const sub = await this.scanDirectoryRelative(full, baseDir);
        list.push(...sub);
      } else {
        list.push(rel);
      }
    }
    return list;
  }
}
