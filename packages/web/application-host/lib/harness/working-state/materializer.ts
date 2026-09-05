import fs from "node:fs";
import path from "node:path";
import type { RecoveryState } from "./types.js";
import { assertAbsolutePathInWorkspace } from "../../workspace/path-safety.js";

export interface MaterializeOptions {
  targetDir: string;
  states: Record<string, RecoveryState>;
  readContent: (state: RecoveryState) => Promise<Buffer | null>;
  cleanUnreferenced?: boolean;
  preservePermissions?: boolean;
  fsPromises?: typeof fs.promises;
  pathModule?: typeof path;
}

export interface MaterializeResult {
  targetDir: string;
  materializedPaths: string[];
  cleanedPaths: string[];
  removedPaths: string[];
}

const normalizeRelPath = (p: string): string => p.replace(/\\/g, "/");

/**
 * Scans target directory recursively for relative paths (excluding .git and .piarium).
 */
async function scanDirectory(
  dir: string,
  fsPromises: typeof fs.promises,
  pathModule: typeof path,
  baseDir = dir,
): Promise<string[]> {
  const result: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = await fsPromises.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === ".piarium") continue;
    const full = pathModule.join(dir, entry.name);
    const rel = normalizeRelPath(pathModule.relative(baseDir, full));
    if (entry.isDirectory()) {
      const sub = await scanDirectory(full, fsPromises, pathModule, baseDir);
      result.push(...sub);
      result.push(rel);
    } else {
      result.push(rel);
    }
  }
  return result;
}

/**
 * Materializes a set of RecoveryState records into targetDir on disk.
 */
export async function materializeWorkingState(
  options: MaterializeOptions,
): Promise<MaterializeResult> {
  const {
    targetDir,
    states,
    readContent,
    cleanUnreferenced = false,
    preservePermissions = true,
  } = options;

  const fsPromises = options.fsPromises ?? fs.promises;
  const pathModule = options.pathModule ?? path;

  await fsPromises.mkdir(targetDir, { recursive: true });

  const materializedPaths: string[] = [];
  const removedPaths: string[] = [];
  const expectedRelPaths = new Set<string>();

  for (const [relPathRaw, state] of Object.entries(states)) {
    const relPath = normalizeRelPath(relPathRaw);
    const absPath = pathModule.resolve(targetDir, relPath);

    await assertAbsolutePathInWorkspace(absPath, {
      root: targetDir,
      fsPromises,
      pathModule,
      allowMissing: true,
    });

    if (state.kind === "missing") {
      try {
        await fsPromises.rm(absPath, { recursive: true, force: true });
        removedPaths.push(relPath);
      } catch {
        // Ignored if file didn't exist
      }
      continue;
    }

    expectedRelPaths.add(relPath);
    // Add all ancestor directories to expected set so they are not pruned
    let parentRel = pathModule.dirname(relPath).replace(/\\/g, "/");
    while (parentRel && parentRel !== "." && parentRel !== "/") {
      expectedRelPaths.add(parentRel);
      parentRel = pathModule.dirname(parentRel).replace(/\\/g, "/");
    }

    if (state.kind === "directory") {
      try {
        const existing = await fsPromises.lstat(absPath);
        if (!existing.isDirectory() || existing.isSymbolicLink()) {
          await fsPromises.rm(absPath, { recursive: true, force: true });
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await fsPromises.mkdir(absPath, { recursive: true });
      if (preservePermissions && state.mode !== undefined) {
        await fsPromises.chmod(absPath, state.mode).catch(() => {});
      }
      materializedPaths.push(relPath);
    } else if (state.kind === "regular-file") {
      const parentDir = pathModule.dirname(absPath);
      await fsPromises.mkdir(parentDir, { recursive: true });
      try {
        const existing = await fsPromises.lstat(absPath);
        if (!existing.isFile() || existing.isSymbolicLink()) {
          await fsPromises.rm(absPath, { recursive: true, force: true });
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }

      const content = await readContent(state);
      if (content === null) {
        throw new Error(`Content missing for file: ${relPath}`);
      }

      await fsPromises.writeFile(absPath, content);
      if (preservePermissions && state.mode !== undefined) {
        await fsPromises.chmod(absPath, state.mode).catch(() => {});
      }
      materializedPaths.push(relPath);
    } else if (state.kind === "symlink") {
      const parentDir = pathModule.dirname(absPath);
      await fsPromises.mkdir(parentDir, { recursive: true });

      // Remove destination if it exists
      await fsPromises.rm(absPath, { recursive: true, force: true }).catch(() => {});
      await fsPromises.symlink(state.symlinkTarget, absPath);
      materializedPaths.push(relPath);
    }
  }

  // Phase 2: Prune unreferenced paths if cleanUnreferenced is true
  const cleanedPaths: string[] = [];
  if (cleanUnreferenced) {
    const existing = await scanDirectory(targetDir, fsPromises, pathModule);
    // Sort reverse so child paths are removed before parent directories
    existing.sort((a, b) => b.length - a.length);

    for (const rel of existing) {
      if (!expectedRelPaths.has(rel)) {
        const abs = pathModule.resolve(targetDir, rel);
        try {
          await fsPromises.rm(abs, { recursive: true, force: true });
          cleanedPaths.push(rel);
        } catch {
          // Best-effort cleanup
        }
      }
    }
  }

  return {
    targetDir,
    materializedPaths,
    cleanedPaths,
    removedPaths,
  };
}
