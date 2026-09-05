import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  IntegrationApplyResult,
  RecoveryState,
  RegularFileState,
  ThreeWayMergePlan,
  ThreeWayPathPlan,
} from "./types.js";
import type { SqliteDatabase } from "../../recovery/journal-catalog.js";
import {
  writeOperationRow,
  initOperationFiles,
  updateOperationFilePhase,
  replaceObjectReferences,
  deleteObjectReferences,
} from "../../recovery/journal-catalog.js";
import {
  assertAbsolutePathInWorkspace,
} from "../../workspace/path-safety.js";

export interface IntegrationCoordinatorOptions {
  workspaceRoot: string;
  fsPromises?: typeof fs.promises | undefined;
  pathModule?: typeof path | undefined;
  database?: SqliteDatabase | undefined;
  journalDir?: string | undefined;
  readContent: (state: RecoveryState) => Promise<Buffer | null>;
}

interface WrittenRecord {
  path: string;
  kind: "regular-file" | "symlink" | "deleted";
  bytes?: Buffer | undefined;
  symlinkTarget?: string | undefined;
  mode?: number | undefined;
  checksum: string;
}

interface BeforeRecord {
  path: string;
  state: RecoveryState;
  bytes?: Buffer | undefined;
  checksum: string;
}

const computeChecksum = (data?: Buffer | string): string => {
  if (!data) return "";
  const buf = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  return createHash("sha256").update(buf).digest("hex");
};

export class IntegrationCoordinator {
  private readonly workspaceRoot: string;
  private readonly fsPromises: typeof fs.promises;
  private readonly pathModule: typeof path;
  private readonly database?: SqliteDatabase | undefined;
  private readonly journalDir?: string | undefined;
  private readonly readContent: (state: RecoveryState) => Promise<Buffer | null>;

  constructor(options: IntegrationCoordinatorOptions) {
    this.workspaceRoot = options.workspaceRoot;
    this.fsPromises = options.fsPromises ?? fs.promises;
    this.pathModule = options.pathModule ?? path;
    this.database = options.database;
    this.journalDir = options.journalDir;
    this.readContent = options.readContent;
  }

  private resolveWorkspaceFile(relative: string): string {
    const normalized = relative.replace(/\\/g, "/");
    return this.pathModule.resolve(this.workspaceRoot, normalized);
  }

  async captureCurrentDiskState(absPath: string): Promise<{ state: RecoveryState; bytes?: Buffer }> {
    try {
      const stat = await this.fsPromises.lstat(absPath);
      if (stat.isSymbolicLink()) {
        const target = await this.fsPromises.readlink(absPath);
        return {
          state: { kind: "symlink", symlinkTarget: target, mode: stat.mode },
        };
      }
      if (stat.isDirectory()) {
        return {
          state: { kind: "directory", mode: stat.mode },
        };
      }
      if (stat.isFile()) {
        const bytes = await this.fsPromises.readFile(absPath);
        return {
          state: {
            kind: "regular-file",
            objectHash: "", // local bytes
            byteLength: bytes.length,
            mode: stat.mode,
          },
          bytes,
        };
      }
      return { state: { kind: "unsupported" } };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { state: { kind: "missing" } };
      }
      throw error;
    }
  }

  private async persistJournalRecord(record: unknown): Promise<void> {
    try {
      const journalDir =
        this.journalDir ??
        this.pathModule.join(this.workspaceRoot, ".piarium", "journal", "operations");
      await this.fsPromises.mkdir(journalDir, { recursive: true });
      const opId = (record as { operationId: string }).operationId;
      const filePath = this.pathModule.join(journalDir, `${opId}.json`);
      await this.fsPromises.writeFile(filePath, JSON.stringify(record, null, 2), "utf8");
    } catch {
      // Best-effort journal persistence
    }
  }

  async apply(plan: ThreeWayMergePlan): Promise<IntegrationApplyResult> {
    const beforeStates = new Map<string, BeforeRecord>();
    const writtenRecords = new Map<string, WrittenRecord>();
    const appliedPaths: string[] = [];
    const conflictPaths: string[] = [];
    const now = new Date().toISOString();

    // Phase 1: Preflight and capture before-states
    for (const pathPlan of plan.paths) {
      const rel = pathPlan.path;
      const abs = this.resolveWorkspaceFile(rel);
      await assertAbsolutePathInWorkspace(abs, {
        root: this.workspaceRoot,
        fsPromises: this.fsPromises,
        pathModule: this.pathModule,
        allowMissing: true,
      });
      const current = await this.captureCurrentDiskState(abs);
      const checksum = current.bytes
        ? computeChecksum(current.bytes)
        : current.state.kind === "symlink"
        ? computeChecksum(current.state.symlinkTarget)
        : "";
      beforeStates.set(rel, {
        path: rel,
        state: current.state,
        bytes: current.bytes,
        checksum,
      });
    }

    // Persist operation start to database if present
    if (this.database) {
      try {
        writeOperationRow(this.database, {
          id: plan.operationId,
          workspaceId: plan.workspaceId,
          kind: "integration",
          state: "applying",
          data: {
            operationId: plan.operationId,
            threadId: plan.threadId,
            resultRevision: plan.resultRevision,
            paths: plan.paths.map((p) => ({
              path: p.path,
              decision: p.decision,
              isText: p.isText,
            })),
            diffStats: plan.diffStats,
          },
          createdAt: now,
          updatedAt: now,
        });

        const targets: Record<string, { expected?: unknown; target?: unknown }> = {};
        for (const pathPlan of plan.paths) {
          const before = beforeStates.get(pathPlan.path);
          targets[pathPlan.path] = {
            expected: before?.state,
            target: pathPlan.childState,
          };
        }
        initOperationFiles(this.database, plan.operationId, targets);
      } catch {
        // Fallback gracefully if database table is missing or readonly
      }
    }

    // Phase 2: Execute path changes with rollback protection
    try {
      for (const pathPlan of plan.paths) {
        const rel = pathPlan.path;
        const abs = this.resolveWorkspaceFile(rel);

        switch (pathPlan.decision) {
          case "identical":
          case "keep-parent":
            // No operation
            break;

          case "apply-child": {
            const childState = pathPlan.childState;
            if (childState.kind === "regular-file") {
              const content = await this.readContent(childState);
              if (!content) throw new Error(`Missing content for child file: ${rel}`);
              await this.fsPromises.mkdir(this.pathModule.dirname(abs), { recursive: true });
              await this.fsPromises.writeFile(abs, content);
              if (childState.mode !== undefined) {
                await this.fsPromises.chmod(abs, childState.mode).catch(() => {});
              }
              const checksum = computeChecksum(content);
              writtenRecords.set(rel, {
                path: rel,
                kind: "regular-file",
                bytes: content,
                mode: childState.mode,
                checksum,
              });
              if (this.database) {
                try {
                  updateOperationFilePhase(this.database, plan.operationId, rel, "target-observed", {
                    observedFingerprint: checksum,
                  });
                } catch {}
              }
              appliedPaths.push(rel);
            } else if (childState.kind === "symlink") {
              const target = childState.symlinkTarget;
              if (this.pathModule.isAbsolute(target) || path.win32.isAbsolute(target)) {
                throw new Error(`Unsafe absolute symlink target for ${rel}: ${target}`);
              }
              await this.fsPromises.mkdir(this.pathModule.dirname(abs), { recursive: true });
              await this.fsPromises.unlink(abs).catch(() => {});
              await this.fsPromises.symlink(target, abs);
              const checksum = computeChecksum(target);
              writtenRecords.set(rel, {
                path: rel,
                kind: "symlink",
                symlinkTarget: target,
                checksum,
              });
              if (this.database) {
                try {
                  updateOperationFilePhase(this.database, plan.operationId, rel, "target-observed", {
                    observedFingerprint: checksum,
                  });
                } catch {}
              }
              appliedPaths.push(rel);
            } else if (childState.kind === "missing") {
              await this.fsPromises.rm(abs, { recursive: true, force: true });
              writtenRecords.set(rel, {
                path: rel,
                kind: "deleted",
                checksum: "",
              });
              if (this.database) {
                try {
                  updateOperationFilePhase(this.database, plan.operationId, rel, "target-observed", {
                    observedFingerprint: "deleted",
                  });
                } catch {}
              }
              appliedPaths.push(rel);
            }
            break;
          }

          case "merge-clean": {
            if (pathPlan.mergedText !== undefined) {
              await this.fsPromises.mkdir(this.pathModule.dirname(abs), { recursive: true });
              const content = Buffer.from(pathPlan.mergedText, "utf8");
              await this.fsPromises.writeFile(abs, content);
              const mode =
                pathPlan.childState.kind === "regular-file" ? pathPlan.childState.mode : undefined;
              if (mode !== undefined) {
                await this.fsPromises.chmod(abs, mode).catch(() => {});
              }
              const checksum = computeChecksum(content);
              writtenRecords.set(rel, {
                path: rel,
                kind: "regular-file",
                bytes: content,
                mode,
                checksum,
              });
              if (this.database) {
                try {
                  updateOperationFilePhase(this.database, plan.operationId, rel, "target-observed", {
                    observedFingerprint: checksum,
                  });
                } catch {}
              }
              appliedPaths.push(rel);
            }
            break;
          }

          case "conflict": {
            conflictPaths.push(rel);
            if (pathPlan.isText && pathPlan.conflictMarkers !== undefined) {
              await this.fsPromises.mkdir(this.pathModule.dirname(abs), { recursive: true });
              const content = Buffer.from(pathPlan.conflictMarkers, "utf8");
              await this.fsPromises.writeFile(abs, content);
              const checksum = computeChecksum(content);
              writtenRecords.set(rel, {
                path: rel,
                kind: "regular-file",
                bytes: content,
                checksum,
              });
              if (this.database) {
                try {
                  updateOperationFilePhase(this.database, plan.operationId, rel, "target-observed", {
                    observedFingerprint: checksum,
                  });
                } catch {}
              }
            }
            break;
          }
        }
      }
    } catch (unexpectedError) {
      // Phase 3: True conditional compensation on unexpected failure
      const compensatedPaths: string[] = [];
      const needsAttentionPaths: string[] = [];

      for (const [rel, written] of writtenRecords.entries()) {
        const abs = this.resolveWorkspaceFile(rel);
        const before = beforeStates.get(rel);
        if (!before) continue;

        if (this.database) {
          try {
            updateOperationFilePhase(this.database, plan.operationId, rel, "compensate-intent");
          } catch {}
        }

        try {
          // Check if current file matches written state exactly
          const current = await this.captureCurrentDiskState(abs);
          let canCompensate = false;

          if (written.kind === "regular-file") {
            if (
              current.state.kind === "regular-file" &&
              current.bytes &&
              written.bytes &&
              current.bytes.equals(written.bytes)
            ) {
              canCompensate = true;
            }
          } else if (written.kind === "symlink") {
            if (
              current.state.kind === "symlink" &&
              current.state.symlinkTarget === written.symlinkTarget
            ) {
              canCompensate = true;
            }
          } else if (written.kind === "deleted") {
            if (current.state.kind === "missing") {
              canCompensate = true;
            }
          }

          if (!canCompensate) {
            // Content has been further edited by user or another process.
            // Do NOT overwrite user modifications. Preserve on disk and mark needs-attention.
            needsAttentionPaths.push(rel);
            if (this.database) {
              const currentFp = current.bytes
                ? computeChecksum(current.bytes)
                : current.state.kind === "symlink"
                ? computeChecksum(current.state.symlinkTarget)
                : "missing";
              try {
                updateOperationFilePhase(this.database, plan.operationId, rel, "needs-attention", {
                  observedFingerprint: currentFp,
                });
              } catch {}
            }
            continue;
          }

          // Condition verified: restore before-state
          if (before.state.kind === "missing") {
            await this.fsPromises.rm(abs, { recursive: true, force: true });
            compensatedPaths.push(rel);
          } else if (before.state.kind === "regular-file" && before.bytes) {
            await this.fsPromises.writeFile(abs, before.bytes);
            if (before.state.mode !== undefined) {
              await this.fsPromises.chmod(abs, before.state.mode).catch(() => {});
            }
            compensatedPaths.push(rel);
          } else if (before.state.kind === "symlink") {
            await this.fsPromises.unlink(abs).catch(() => {});
            await this.fsPromises.symlink(before.state.symlinkTarget, abs);
            compensatedPaths.push(rel);
          } else {
            needsAttentionPaths.push(rel);
          }

          if (this.database) {
            try {
              updateOperationFilePhase(this.database, plan.operationId, rel, "safety-observed", {
                observedFingerprint: before.checksum,
              });
            } catch {}
          }
        } catch {
          needsAttentionPaths.push(rel);
          if (this.database) {
            try {
              updateOperationFilePhase(this.database, plan.operationId, rel, "needs-attention");
            } catch {}
          }
        }
      }

      const status = needsAttentionPaths.length > 0 ? "needs-attention" : "compensated";
      const errMessage =
        unexpectedError instanceof Error ? unexpectedError.message : String(unexpectedError);

      if (this.database) {
        try {
          writeOperationRow(this.database, {
            id: plan.operationId,
            workspaceId: plan.workspaceId,
            kind: "integration",
            state: status,
            data: {
              operationId: plan.operationId,
              status,
              error: errMessage,
              compensatedPaths,
              needsAttentionPaths,
              diffStats: plan.diffStats,
            },
            createdAt: now,
            updatedAt: new Date().toISOString(),
          });
        } catch {}
      }

      await this.persistJournalRecord({
        operationId: plan.operationId,
        workspaceId: plan.workspaceId,
        status,
        appliedPaths: [],
        conflictPaths: [...plan.conflictPaths],
        compensatedPaths,
        needsAttentionPaths,
        diffStats: plan.diffStats,
        error: errMessage,
        writtenRecords: Array.from(writtenRecords.values()).map((r) => ({
          path: r.path,
          kind: r.kind,
          checksum: r.checksum,
        })),
      });

      return {
        operationId: plan.operationId,
        status,
        appliedPaths: [],
        conflictPaths: [...plan.conflictPaths],
        compensatedPaths,
        needsAttentionPaths,
        diffStats: plan.diffStats,
        text: `Merge operation ${plan.operationId} failed unexpectedly (${errMessage}). Applied compensation with status: ${status}.`,
      };
    }

    // Protect written objects in database if applicable
    if (this.database) {
      try {
        const refs: Array<{ slot: string; objectHash: string }> = [];
        for (const pathPlan of plan.paths) {
          if (pathPlan.childState.kind === "regular-file" && pathPlan.childState.objectHash) {
            refs.push({ slot: `applied:${pathPlan.path}`, objectHash: pathPlan.childState.objectHash });
          }
        }
        if (refs.length > 0) {
          replaceObjectReferences(
            this.database,
            plan.workspaceId,
            "integration",
            plan.operationId,
            refs,
          );
        }

        writeOperationRow(this.database, {
          id: plan.operationId,
          workspaceId: plan.workspaceId,
          kind: "integration",
          state: conflictPaths.length > 0 ? "conflict" : "complete",
          data: {
            operationId: plan.operationId,
            status: conflictPaths.length > 0 ? "conflict" : "applied",
            appliedPaths,
            conflictPaths,
            diffStats: plan.diffStats,
          },
          createdAt: now,
          updatedAt: new Date().toISOString(),
        });
      } catch {}
    }

    await this.persistJournalRecord({
      operationId: plan.operationId,
      workspaceId: plan.workspaceId,
      status: conflictPaths.length > 0 ? "conflict" : "applied",
      appliedPaths,
      conflictPaths,
      diffStats: plan.diffStats,
      writtenRecords: Array.from(writtenRecords.values()).map((r) => ({
        path: r.path,
        kind: r.kind,
        checksum: r.checksum,
      })),
    });

    if (conflictPaths.length > 0) {
      const textConflicts = plan.paths.filter((p) => p.decision === "conflict" && p.isText);
      const structuralConflicts = plan.paths.filter((p) => p.decision === "conflict" && !p.isText);

      let details = `merge encountered ${conflictPaths.length} conflicts:\n${conflictPaths.join("\n")}`;
      if (textConflicts.length > 0) {
        details += `\nConflict markers were written to ${textConflicts.length} text file(s). Resolve them and save.`;
      }
      if (structuralConflicts.length > 0) {
        details += `\n${structuralConflicts.length} non-text / structural conflict(s) were left unchanged in the parent workspace.`;
      }

      return {
        operationId: plan.operationId,
        status: "conflict",
        appliedPaths,
        conflictPaths,
        diffStats: plan.diffStats,
        text: details,
      };
    }

    return {
      operationId: plan.operationId,
      status: "applied",
      appliedPaths,
      conflictPaths: [],
      diffStats: plan.diffStats,
      text: `Cleanly merged ${appliedPaths.length} file(s) for operation ${plan.operationId}.`,
    };
  }
}
