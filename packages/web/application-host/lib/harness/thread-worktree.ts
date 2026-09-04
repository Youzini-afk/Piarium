import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import type { ThreadDiffStats, ThreadWorktree } from "@piarium/protocol";
import type { WorktreeBootstrapState } from "../git/types.js";

export interface ThreadWorktreeCreateResult {
  path: string;
}

export interface ThreadWorktreeRuntimeOptions {
  createWorktree(
    directory: string,
    input: Record<string, unknown>,
  ): Promise<ThreadWorktreeCreateResult>;
  getWorktreeBootstrapStatus(directory: string): Promise<WorktreeBootstrapState>;
  gitBinary?: string;
  env?: NodeJS.ProcessEnv;
  fsPromises?: Pick<typeof fs.promises, "copyFile" | "lstat" | "mkdir" | "readFile" | "readlink" | "realpath" | "symlink">;
  pathModule?: typeof path;
  runGit?: (cwd: string, args: string[], input?: Buffer | string) => Promise<{ stdout: string; stderr: string }>;
}

export interface PrepareThreadWorktreeInput {
  mode: "none" | "shared" | "isolated";
  sourceRoot: string;
  threadId: string;
  signal?: AbortSignal;
}

export interface PreparedThreadWorktree {
  cwd: string;
  worktree: ThreadWorktree | null;
}

export interface MergeThreadWorktreeResult {
  merged: number;
  conflicts: string[];
  conflictState: "none" | "markers" | "parent-unchanged";
  changedFiles: string[];
  diffStats: ThreadDiffStats;
}

const abortError = (): DOMException => new DOMException("Thread worktree preparation aborted", "AbortError");

const wait = (milliseconds: number, signal?: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
  if (signal?.aborted) {
    reject(abortError());
    return;
  }
  const timer = setTimeout(resolve, milliseconds);
  signal?.addEventListener("abort", () => {
    clearTimeout(timer);
    reject(abortError());
  }, { once: true });
});

const parseNullList = (value: string): string[] => value.split("\0").filter(Boolean);

const normalizeRelative = (value: string, pathModule: typeof path): string => {
  const normalized = value.replace(/\\/g, "/");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").includes("..")) {
    throw new Error(`Unsafe Git path: ${value}`);
  }
  const resolved = pathModule.normalize(normalized);
  if (pathModule.isAbsolute(resolved)) throw new Error(`Unsafe Git path: ${value}`);
  return resolved;
};

const parseNumstat = (value: string): ThreadDiffStats => {
  let files = 0;
  let insertions = 0;
  let deletions = 0;
  for (const line of value.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [added, removed] = line.split("\t");
    files += 1;
    if (added !== "-") insertions += Number.parseInt(added ?? "0", 10) || 0;
    if (removed !== "-") deletions += Number.parseInt(removed ?? "0", 10) || 0;
  }
  return { files, insertions, deletions };
};

const defaultRunGit = (
  gitBinary: string,
  env: NodeJS.ProcessEnv,
) => (cwd: string, args: string[], input?: Buffer | string): Promise<{ stdout: string; stderr: string }> => new Promise((resolve, reject) => {
  const child = spawn(gitBinary, args, {
    cwd,
    env,
    shell: false,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout?.on("data", (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
  child.stderr?.on("data", (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
  child.once("error", reject);
  child.once("close", (code) => {
    const result = { stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") };
    if (code === 0) resolve(result);
    else reject(new Error(result.stderr.trim() || `git ${args[0] ?? "command"} exited ${String(code)}`));
  });
  if (input !== undefined) child.stdin?.end(input);
});

export function createThreadWorktreeRuntime(options: ThreadWorktreeRuntimeOptions) {
  const fsPromises = options.fsPromises ?? fs.promises;
  const pathModule = options.pathModule ?? path;
  const runGit = options.runGit ?? defaultRunGit(options.gitBinary ?? "git", options.env ?? process.env);

  const waitUntilReady = async (directory: string, signal?: AbortSignal): Promise<void> => {
    for (;;) {
      if (signal?.aborted) throw abortError();
      const state = await options.getWorktreeBootstrapStatus(directory);
      if (state.status === "ready") return;
      if (state.status === "failed") throw new Error(state.error || "Thread worktree setup failed");
      await wait(100, signal);
    }
  };

  const copyUntracked = async (sourceRoot: string, destinationRoot: string, relativePaths: string[]): Promise<void> => {
    for (const relativeValue of relativePaths) {
      const relative = normalizeRelative(relativeValue, pathModule);
      const source = pathModule.resolve(sourceRoot, relative);
      const destination = pathModule.resolve(destinationRoot, relative);
      const sourceRootReal = await fsPromises.realpath(sourceRoot);
      const sourceReal = await fsPromises.realpath(source);
      if (sourceReal !== sourceRootReal && !sourceReal.startsWith(`${sourceRootReal}${pathModule.sep}`)) {
        throw new Error(`Untracked source escapes workspace: ${relativeValue}`);
      }
      const info = await fsPromises.lstat(source);
      await fsPromises.mkdir(pathModule.dirname(destination), { recursive: true });
      if (info.isSymbolicLink()) {
        await fsPromises.symlink(await fsPromises.readlink(source), destination);
      } else if (info.isFile()) {
        await fsPromises.copyFile(source, destination);
      }
    }
  };

  const prepare = async ({ mode, sourceRoot, threadId, signal }: PrepareThreadWorktreeInput): Promise<PreparedThreadWorktree> => {
    if (mode === "none" || mode === "shared") return { cwd: sourceRoot, worktree: null };
    const [{ stdout: baseOutput }, { stdout: patch }, { stdout: untrackedOutput }] = await Promise.all([
      runGit(sourceRoot, ["rev-parse", "HEAD"]),
      runGit(sourceRoot, ["diff", "--binary", "HEAD"]),
      runGit(sourceRoot, ["ls-files", "--others", "--exclude-standard", "-z"]),
    ]);
    const parentHead = baseOutput.trim();
    if (!parentHead) throw new Error("Unable to resolve parent HEAD for thread worktree");
    const created = await options.createWorktree(sourceRoot, {
      mode: "new",
      worktreeName: threadId,
      branchName: `piarium/${threadId}`,
      startRef: parentHead,
    });
    await waitUntilReady(created.path, signal);
    if (patch.length > 0) await runGit(created.path, ["apply", "--binary", "--whitespace=nowarn", "-"], patch);
    const untracked = parseNullList(untrackedOutput);
    await copyUntracked(sourceRoot, created.path, untracked);
    let base = parentHead;
    if (patch.length > 0 || untracked.length > 0) {
      await runGit(created.path, ["add", "-A"]);
      await runGit(created.path, [
        "-c", "user.name=Piarium Thread Baseline",
        "-c", "user.email=thread-baseline@piarium.local",
        "commit", "--no-verify", "--no-gpg-sign", "-m", "Piarium thread baseline",
      ]);
      base = (await runGit(created.path, ["rev-parse", "HEAD"])).stdout.trim();
    }
    return { cwd: created.path, worktree: { path: created.path, base } };
  };

  const inspect = async (worktree: ThreadWorktree): Promise<Pick<MergeThreadWorktreeResult, "changedFiles" | "diffStats"> & { patch: string; untracked: string[] }> => {
    const [{ stdout: patch }, { stdout: changed }, { stdout: untracked }, { stdout: numstat }] = await Promise.all([
      runGit(worktree.path, ["diff", "--binary", worktree.base]),
      runGit(worktree.path, ["diff", "--name-only", "-z", worktree.base]),
      runGit(worktree.path, ["ls-files", "--others", "--exclude-standard", "-z"]),
      runGit(worktree.path, ["diff", "--numstat", worktree.base]),
    ]);
    const untrackedPaths = parseNullList(untracked);
    const changedFiles = [...new Set([...parseNullList(changed), ...untrackedPaths])];
    const diffStats = parseNumstat(numstat);
    diffStats.files = changedFiles.length;
    return { patch, untracked: untrackedPaths, changedFiles, diffStats };
  };

  const merge = async (parentRoot: string, worktree: ThreadWorktree): Promise<MergeThreadWorktreeResult> => {
    const state = await inspect(worktree);
    const untrackedToCopy: Array<{ source: string; destination: string }> = [];
    const untrackedConflicts: string[] = [];
    for (const relativeValue of state.untracked) {
      const relative = normalizeRelative(relativeValue, pathModule);
      const source = pathModule.resolve(worktree.path, relative);
      const destination = pathModule.resolve(parentRoot, relative);
      try {
        const [sourceBytes, destinationBytes] = await Promise.all([
          fsPromises.readFile(source),
          fsPromises.readFile(destination),
        ]);
        if (!sourceBytes.equals(destinationBytes)) untrackedConflicts.push(relativeValue);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          untrackedConflicts.push(relativeValue);
          continue;
        }
        untrackedToCopy.push({ source, destination });
      }
    }
    if (untrackedConflicts.length > 0) {
      return {
        merged: 0,
        conflicts: untrackedConflicts,
        conflictState: "parent-unchanged",
        changedFiles: state.changedFiles,
        diffStats: state.diffStats,
      };
    }
    if (state.patch.length > 0) {
      try {
        // The parent working tree already contains the captured baseline while
        // its index may still point at the user's original HEAD. A plain apply
        // therefore has the correct first chance and does not stage files.
        await runGit(parentRoot, ["apply", "--binary", "--whitespace=nowarn", "-"], state.patch);
      } catch {
        try {
          await runGit(parentRoot, ["apply", "--3way", "--binary", "--whitespace=nowarn", "-"], state.patch);
        } catch {
          const conflicts = await runGit(parentRoot, ["diff", "--name-only", "--diff-filter=U", "-z"])
            .then(({ stdout }) => parseNullList(stdout))
            .catch(() => []);
          if (conflicts.length > 0) {
            return {
              merged: 0,
              conflicts,
              conflictState: "markers",
              changedFiles: state.changedFiles,
              diffStats: state.diffStats,
            };
          }
          return {
            merged: 0,
            conflicts: state.changedFiles,
            conflictState: "parent-unchanged",
            changedFiles: state.changedFiles,
            diffStats: state.diffStats,
          };
        }
      }
    }
    for (const { source, destination } of untrackedToCopy) {
      await fsPromises.mkdir(pathModule.dirname(destination), { recursive: true });
      await fsPromises.copyFile(source, destination);
    }
    return {
      merged: state.changedFiles.length,
      conflicts: [],
      conflictState: "none",
      changedFiles: state.changedFiles,
      diffStats: state.diffStats,
    };
  };

  return { prepare, inspect, merge };
}

export type ThreadWorktreeRuntime = ReturnType<typeof createThreadWorktreeRuntime>;
