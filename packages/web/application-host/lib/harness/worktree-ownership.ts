import fs from "node:fs";
import path from "node:path";
import type { ThreadWorktree } from "@piarium/protocol";

const normalizeComparePath = (value: string, pathModule: typeof path): string => {
  const resolved = pathModule.resolve(value).replace(/\\/g, "/");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
};

const canonicalizeAllowMissing = async (
  candidate: string,
  fsPromises: Pick<typeof fs.promises, "realpath">,
  pathModule: typeof path,
): Promise<string> => {
  let current = pathModule.resolve(candidate);
  const suffix: string[] = [];
  for (;;) {
    try {
      const canonical = await fsPromises.realpath(current);
      return pathModule.resolve(canonical, ...suffix.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = pathModule.dirname(current);
      if (parent === current) throw error;
      suffix.push(pathModule.basename(current));
      current = parent;
    }
  }
};

export async function assertManagedWorktreeOwnership(
  worktree: ThreadWorktree,
  operation: string,
  candidates: readonly string[] = [],
  options: {
    fsPromises?: Pick<typeof fs.promises, "realpath">;
    pathModule?: typeof path;
    authorizeManagedRoot: (managedRoot: string) => boolean | Promise<boolean>;
  },
): Promise<void> {
  const fsPromises = options.fsPromises ?? fs.promises;
  const pathModule = options.pathModule ?? path;
  if (!worktree.managedRoot || !pathModule.isAbsolute(worktree.managedRoot)) {
    throw new Error(`Refusing ${operation}: worktree has no persistent managed ownership root`);
  }
  if (!await options.authorizeManagedRoot(worktree.managedRoot)) {
    throw new Error(`Refusing ${operation}: managed ownership root is not registered by the Host backend`);
  }
  if (!pathModule.isAbsolute(worktree.path)) {
    throw new Error(`Refusing ${operation}: worktree path is not absolute`);
  }
  const canonicalRoot = normalizeComparePath(await fsPromises.realpath(worktree.managedRoot), pathModule);
  for (const candidate of [worktree.path, ...candidates]) {
    if (!pathModule.isAbsolute(candidate)) {
      throw new Error(`Refusing ${operation}: managed path is not absolute: ${candidate}`);
    }
    const canonicalCandidate = normalizeComparePath(
      await canonicalizeAllowMissing(candidate, fsPromises, pathModule),
      pathModule,
    );
    const relative = pathModule.relative(canonicalRoot, canonicalCandidate);
    if (!relative || relative.startsWith("..") || pathModule.isAbsolute(relative)) {
      throw new Error(`Refusing ${operation}: path is outside the persistent managed root: ${candidate}`);
    }
  }
}
