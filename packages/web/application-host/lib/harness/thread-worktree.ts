import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import type { HarnessWorktreeSettings, ThreadDiffStats, ThreadWorktree } from "@piarium/protocol";
import type { WorktreeBootstrapState } from "../git/types.js";
import { assertAbsolutePathInWorkspace } from "../workspace/path-safety.js";
import { mergeText3Way } from "./working-state/three-way-merge.js";
import type { ShellInterpreter } from "./shell-supervisor.js";
import type { WorkingStateStore } from "./working-state/working-state-store.js";
import { captureGitChangedPaths, importGitPathsToStore } from "./working-state/git-migration.js";

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
  fsPromises?: Pick<typeof fs.promises, "chmod" | "copyFile" | "cp" | "lstat" | "mkdir" | "readdir" | "readFile" | "readlink" | "realpath" | "rename" | "rm" | "stat" | "symlink" | "unlink" | "writeFile">;
  pathModule?: typeof path;
  runGit?: (cwd: string, args: string[], input?: Buffer | string) => Promise<{ stdout: string; stderr: string; stdoutBuffer?: Buffer }>;
  interpreter?: ShellInterpreter | undefined;
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
  appliedPaths?: string[];
  status?: "applied" | "conflict" | "compensated" | "needs-attention";
  resultRevision?: number;
  operationId?: string;
}

interface SetupFailure extends Error {
  exitReason: "setup-failed";
  output?: string;
}

const asSetupFailure = (error: Error, output?: string): SetupFailure => Object.assign(error, {
  exitReason: "setup-failed" as const,
  ...(output === undefined ? {} : { output }),
});

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
) => (cwd: string, args: string[], input?: Buffer | string): Promise<{ stdout: string; stderr: string; stdoutBuffer: Buffer }> => new Promise((resolve, reject) => {
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
    const stdoutBuffer = Buffer.concat(stdout);
    const result = {
      stdout: stdoutBuffer.toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
      stdoutBuffer,
    };
    if (code === 0) resolve(result);
    else reject(new Error(result.stderr.trim() || `git ${args[0] ?? "command"} exited ${String(code)}`));
  });
  if (input !== undefined) child.stdin?.end(input);
});

interface GitTreeEntry {
  mode: string;
  type: string;
  objectHash: string;
  path: string;
}

const parseLsTree = (output: string): GitTreeEntry[] => {
  const entries: GitTreeEntry[] = [];
  const tokens = output.split("\0").filter(Boolean);
  for (const token of tokens) {
    const tabIndex = token.indexOf("\t");
    if (tabIndex === -1) continue;
    const meta = token.slice(0, tabIndex).trim().split(/\s+/);
    const entryPath = token.slice(tabIndex + 1);
    const [mode, type, objectHash] = meta;
    if (mode && type && objectHash) {
      entries.push({
        mode,
        type,
        objectHash,
        path: entryPath,
      });
    }
  }
  return entries;
};

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
      await assertAbsolutePathInWorkspace(source, { root: sourceRoot, fsPromises, pathModule });
      await assertAbsolutePathInWorkspace(destination, { root: destinationRoot, fsPromises, pathModule, allowMissing: true });
      const info = await fsPromises.lstat(source);
      await fsPromises.mkdir(pathModule.dirname(destination), { recursive: true });
      if (info.isSymbolicLink()) {
        await fsPromises.symlink(await fsPromises.readlink(source), destination);
      } else if (info.isFile()) {
        await fsPromises.copyFile(source, destination);
        await fsPromises.chmod(destination, info.mode & 0o7777);
      }
    }
  };

  const copyDirRecursive = async (src: string, dst: string): Promise<void> => {
    const readdirFn = (fsPromises as typeof fs.promises).readdir ?? fs.promises.readdir;
    const entries = await readdirFn(src, { withFileTypes: true });
    await fsPromises.mkdir(dst, { recursive: true });
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === ".piarium") continue;
      const s = pathModule.join(src, entry.name);
      const d = pathModule.join(dst, entry.name);
      if (entry.isSymbolicLink()) {
        await fsPromises.rm(d, { recursive: true, force: true }).catch(() => undefined);
        await fsPromises.symlink(await fsPromises.readlink(s), d);
      } else if (entry.isDirectory()) {
        await copyDirRecursive(s, d);
      } else if (entry.isFile()) {
        await fsPromises.copyFile(s, d);
        const mode = (await fsPromises.lstat(s)).mode & 0o7777;
        await fsPromises.chmod(d, mode);
      }
    }
  };

  const listAllFilesRelative = async (dir: string, prefix = ""): Promise<string[]> => {
    const readdirFn = (fsPromises as typeof fs.promises).readdir ?? fs.promises.readdir;
    const entries = await readdirFn(dir, { withFileTypes: true });
    const result: string[] = [];
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === ".piarium") continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = pathModule.join(dir, entry.name);
      if (entry.isDirectory()) {
        const nested = await listAllFilesRelative(full, rel);
        result.push(...nested);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        result.push(rel);
      }
    }
    return result;
  };

  const diffDirectories = async (
    baseDir: string,
    targetDir: string,
  ): Promise<{ added: string[]; changed: string[]; removed: string[]; diffStats: ThreadDiffStats }> => {
    const [baseFiles, targetFiles] = await Promise.all([
      listAllFilesRelative(baseDir),
      listAllFilesRelative(targetDir),
    ]);
    const baseSet = new Set(baseFiles);
    const targetSet = new Set(targetFiles);
    const added = targetFiles.filter((f) => !baseSet.has(f));
    const removed = baseFiles.filter((f) => !targetSet.has(f));
    const changed: string[] = [];
    let insertions = 0;
    let deletions = 0;

    for (const f of targetFiles) {
      if (!baseSet.has(f)) {
        try {
          const text = await fsPromises.readFile(pathModule.join(targetDir, f), "utf8");
          insertions += text.split(/\r?\n/).length;
        } catch {
          insertions += 1;
        }
      } else {
        try {
          const basePath = pathModule.join(baseDir, f);
          const targetPath = pathModule.join(targetDir, f);
          const [baseInfo, targetInfo] = await Promise.all([fsPromises.lstat(basePath), fsPromises.lstat(targetPath)]);
          const sameType = baseInfo.isFile() === targetInfo.isFile()
            && baseInfo.isSymbolicLink() === targetInfo.isSymbolicLink();
          const sameMode = (baseInfo.mode & 0o7777) === (targetInfo.mode & 0o7777);
          let sameContent = false;
          let baseBytes = Buffer.alloc(0);
          let targetBytes = Buffer.alloc(0);
          if (sameType && baseInfo.isSymbolicLink()) {
            const [baseTarget, targetTarget] = await Promise.all([
              fsPromises.readlink(basePath),
              fsPromises.readlink(targetPath),
            ]);
            sameContent = baseTarget === targetTarget;
          } else if (sameType && baseInfo.isFile()) {
            [baseBytes, targetBytes] = await Promise.all([
              fsPromises.readFile(basePath),
              fsPromises.readFile(targetPath),
            ]);
            sameContent = baseBytes.equals(targetBytes);
          }
          if (!sameType || !sameMode || !sameContent) {
            changed.push(f);
            const baseText = baseBytes.toString("utf8");
            const targetText = targetBytes.toString("utf8");
            const baseLines = baseText.split(/\r?\n/);
            const targetLines = targetText.split(/\r?\n/);
            insertions += Math.max(0, targetLines.length - baseLines.length);
            deletions += Math.max(0, baseLines.length - targetLines.length);
            if (insertions === 0 && deletions === 0) {
              insertions += 1;
              deletions += 1;
            }
          }
        } catch {
          changed.push(f);
        }
      }
    }
    for (const f of removed) {
      try {
        const text = await fsPromises.readFile(pathModule.join(baseDir, f), "utf8");
        deletions += text.split(/\r?\n/).length;
      } catch {
        deletions += 1;
      }
    }
    const totalFiles = added.length + changed.length + removed.length;
    return {
      added,
      changed,
      removed,
      diffStats: { files: totalFiles, insertions, deletions },
    };
  };

  const prepare = async ({ mode, sourceRoot, threadId, signal }: PrepareThreadWorktreeInput): Promise<PreparedThreadWorktree> => {
    if (mode === "none" || mode === "shared") return { cwd: sourceRoot, worktree: null };

    let isGit = true;
    let parentHead = "";
    let patch = "";
    let untrackedOutput = "";

    try {
      const [baseRes, patchRes, untrackedRes] = await Promise.all([
        runGit(sourceRoot, ["rev-parse", "HEAD"]),
        runGit(sourceRoot, ["diff", "--binary", "HEAD"]),
        runGit(sourceRoot, ["ls-files", "--others", "--exclude-standard", "-z"]),
      ]);
      parentHead = baseRes.stdout.trim();
      patch = patchRes.stdout;
      untrackedOutput = untrackedRes.stdout;
    } catch {
      isGit = false;
    }

    if (!isGit || !parentHead) {
      // Non-git or zero-commit workspace: fallback to directory copy backend
      let targetDir: string;
      try {
        const res = await options.createWorktree(sourceRoot, {
          mode: "new",
          worktreeName: threadId,
          branchName: `piarium/${threadId}`,
        });
        targetDir = res.path;
      } catch {
        targetDir = pathModule.resolve(sourceRoot, ".piarium", "worktrees", threadId);
        await fsPromises.mkdir(targetDir, { recursive: true });
      }

      await copyDirRecursive(sourceRoot, targetDir);
      await copyDirRecursive(targetDir, `${targetDir}.baseline`);
      return {
        cwd: targetDir,
        worktree: {
          path: targetDir,
          base: "zero-commit",
          branch: `piarium/${threadId}`,
          materialized: true,
        },
      };
    }

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
    return {
      cwd: created.path,
      worktree: { path: created.path, base, branch: `piarium/${threadId}`, materialized: true },
    };
  };

  const inspect = async (worktree: ThreadWorktree): Promise<Pick<MergeThreadWorktreeResult, "changedFiles" | "diffStats"> & { patch: string; untracked: string[] }> => {
    if (worktree.base === "zero-commit") {
      const baselineDir = `${worktree.path}.baseline`;
      const currentDir = worktree.resultPath
        ? worktree.resultPath
        : worktree.path;
      const diff = await diffDirectories(baselineDir, currentDir);
      return {
        patch: "",
        untracked: diff.added,
        changedFiles: [...diff.added, ...diff.changed, ...diff.removed],
        diffStats: diff.diffStats,
      };
    }

    const targetRef = worktree.resultCommit;
    let newPaths: string[];
    let trackedPatchArgs: string[];
    let changedResult: string;
    let numstatResult: string;
    let patchResult: string;

    if (targetRef) {
      // Result is fixed in resultCommit. Read diffs strictly against resultCommit.
      const [{ stdout: added }, { stdout: changed }, { stdout: numstat }] = await Promise.all([
        runGit(worktree.path, ["diff", "--name-only", "--diff-filter=A", "-z", worktree.base, targetRef]),
        runGit(worktree.path, ["diff", "--name-only", "-z", worktree.base, targetRef]),
        runGit(worktree.path, ["diff", "--numstat", worktree.base, targetRef]),
      ]);
      newPaths = parseNullList(added);
      trackedPatchArgs = [
        "diff", "--binary", worktree.base, targetRef, "--", ".",
        ...newPaths.map((relative) => `:(exclude,literal)${normalizeRelative(relative, pathModule).replace(/\\/g, "/")}`),
      ];
      patchResult = (await runGit(worktree.path, trackedPatchArgs)).stdout;
      changedResult = changed;
      numstatResult = numstat;
    } else {
      const [{ stdout: added }, { stdout: untracked }] = await Promise.all([
        runGit(worktree.path, ["diff", "--name-only", "--diff-filter=A", "-z", worktree.base]),
        runGit(worktree.path, ["ls-files", "--others", "--exclude-standard", "-z"]),
      ]);
      // A result snapshot commits formerly-untracked files onto the internal
      // branch. They must retain new-file preflight semantics during merge, not
      // silently become part of the tracked patch.
      newPaths = [...new Set([...parseNullList(added), ...parseNullList(untracked)])];
      trackedPatchArgs = [
        "diff", "--binary", worktree.base, "--", ".",
        ...newPaths.map((relative) => `:(exclude,literal)${normalizeRelative(relative, pathModule).replace(/\\/g, "/")}`),
      ];
      const [{ stdout: patch }, { stdout: changed }, { stdout: numstat }] = await Promise.all([
        runGit(worktree.path, trackedPatchArgs),
        runGit(worktree.path, ["diff", "--name-only", "-z", worktree.base]),
        runGit(worktree.path, ["diff", "--numstat", worktree.base]),
      ]);
      patchResult = patch;
      changedResult = changed;
      numstatResult = numstat;
    }
    const changedFiles = [...new Set([...parseNullList(changedResult), ...newPaths])];
    const diffStats = parseNumstat(numstatResult);
    diffStats.files = changedFiles.length;
    return { patch: patchResult, untracked: newPaths, changedFiles, diffStats };
  };

  const snapshot = async (worktree: ThreadWorktree): Promise<ThreadWorktree> => {
    if (worktree.base === "zero-commit") {
      const resultsRoot = `${worktree.path}.results`;
      const staging = pathModule.join(resultsRoot, `.staging-${randomUUID()}`);
      await fsPromises.mkdir(resultsRoot, { recursive: true });
      await copyDirRecursive(worktree.path, staging);
      const files = await listAllFilesRelative(staging);
      const hash = createHash("sha256");
      for (const f of files.sort()) {
        hash.update(f);
        try {
          const target = pathModule.join(staging, f);
          const stat = await fsPromises.lstat(target);
          hash.update(String(stat.mode & 0o7777));
          if (stat.isSymbolicLink()) hash.update(await fsPromises.readlink(target));
          else hash.update(await fsPromises.readFile(target));
        } catch { /* ignore */ }
      }
      const resultCommit = hash.digest("hex").slice(0, 40);
      const resultPath = pathModule.join(resultsRoot, resultCommit);
      try {
        await fsPromises.stat(resultPath);
        await fsPromises.rm(staging, { recursive: true, force: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await fsPromises.rename(staging, resultPath);
      }
      return { ...worktree, resultCommit, resultPath };
    }

    const status = (await runGit(worktree.path, ["status", "--porcelain", "-z"])).stdout;
    if (status.length > 0) {
      await runGit(worktree.path, ["add", "-A"]);
      await runGit(worktree.path, [
        "-c", "user.name=Piarium Thread Result",
        "-c", "user.email=thread-result@piarium.local",
        "commit", "--no-verify", "--no-gpg-sign", "-m", "Piarium thread result",
      ]);
    }
    const [commitResult, branchResult, cleanResult] = await Promise.all([
      runGit(worktree.path, ["rev-parse", "HEAD"]),
      runGit(worktree.path, ["branch", "--show-current"]),
      runGit(worktree.path, ["status", "--porcelain", "-z"]),
    ]);
    const resultCommit = commitResult.stdout.trim();
    const branch = branchResult.stdout.trim() || worktree.branch;
    if (!resultCommit) throw new Error("Unable to resolve the thread result commit");
    if (!branch) throw new Error("Thread worktree is not attached to a retained branch");
    if (cleanResult.stdout.length > 0) throw new Error("Thread worktree changed while its result was being snapshotted");
    return { ...worktree, branch, resultCommit };
  };

  const importFixedResult = async (
    workspaceId: string,
    threadId: string,
    worktree: ThreadWorktree,
    store: WorkingStateStore,
  ) => {
    if (!worktree.resultCommit) throw new Error("Legacy thread result has no fixed result reference");
    const branchId = `thread-${threadId}`;
    if (worktree.base !== "zero-commit") {
      const git = (args: string[]) => runGit(worktree.path, args).then((result) => ({ ...result, exitCode: 0 }));
      const changedPaths = await captureGitChangedPaths(git, worktree.base, worktree.resultCommit);
      const [baseState, resultState] = await Promise.all([
        importGitPathsToStore(store, git, worktree.base, changedPaths),
        importGitPathsToStore(store, git, worktree.resultCommit, changedPaths),
      ]);
      return store.importFixedResult(workspaceId, branchId, baseState, resultState, changedPaths, worktree.base);
    }

    const baselineDir = `${worktree.path}.baseline`;
    const resultDir = worktree.resultPath ?? `${worktree.path}.snapshot`;
    await fsPromises.stat(resultDir);
    if (!worktree.resultPath) {
      const files = await listAllFilesRelative(resultDir);
      const hash = createHash("sha256");
      for (const file of files.sort()) {
        hash.update(file);
        hash.update(await fsPromises.readFile(pathModule.join(resultDir, file)));
      }
      if (hash.digest("hex").slice(0, 40) !== worktree.resultCommit) {
        throw new Error("Legacy copy result no longer matches its recorded snapshot id");
      }
    }
    const diff = await diffDirectories(baselineDir, resultDir);
    const changedPaths = [...diff.added, ...diff.changed, ...diff.removed];
    const [baseState, resultState] = await Promise.all([
      store.captureDirectory(baselineDir, changedPaths),
      store.captureDirectory(resultDir, changedPaths),
    ]);
    return store.importFixedResult(workspaceId, branchId, baseState, resultState, changedPaths, worktree.base);
  };

  const merge = async (parentRoot: string, worktree: ThreadWorktree): Promise<MergeThreadWorktreeResult> => {
    const state = await inspect(worktree);
    const untrackedToCopy: Array<
      | { kind: "file"; source?: string; bytes?: Buffer; mode?: string; destination: string }
      | { kind: "symlink"; target: string; destination: string }
      | { kind: "delete"; destination: string }
    > = [];
    const untrackedConflicts: string[] = [];

    const resultCommit = worktree.resultCommit;
    let lsTreeMap: Map<string, GitTreeEntry> | null = null;
    if (worktree.base !== "zero-commit" && resultCommit && state.untracked.length > 0) {
      const { stdout: lsTreeOut } = await runGit(worktree.path, ["ls-tree", "-z", "-r", resultCommit]);
      const entries = parseLsTree(lsTreeOut);
      lsTreeMap = new Map(entries.map((e) => [e.path.replace(/\\/g, "/"), e]));
    }

    const filesToProcess = worktree.base === "zero-commit" ? state.changedFiles : state.untracked;
    for (const relativeValue of filesToProcess) {
      const relative = normalizeRelative(relativeValue, pathModule);
      const destination = pathModule.resolve(parentRoot, relative);
      const normalizedKey = relative.replace(/\\/g, "/");

      if (worktree.base !== "zero-commit" && resultCommit && lsTreeMap) {
        const treeEntry = lsTreeMap.get(normalizedKey);
        if (!treeEntry) {
          untrackedConflicts.push(relativeValue);
          continue;
        }
        try {
          await assertAbsolutePathInWorkspace(destination, { root: parentRoot, fsPromises, pathModule, allowMissing: true });
          const isSymlink = treeEntry.mode === "120000";
          const catRes = await runGit(worktree.path, ["cat-file", "-p", treeEntry.objectHash]);
          const sourceBytes = catRes.stdoutBuffer ?? Buffer.from(catRes.stdout, "utf8");

          try {
            const destinationInfo = await fsPromises.lstat(destination);
            if (isSymlink && destinationInfo.isSymbolicLink()) {
              const destinationTarget = await fsPromises.readlink(destination);
              const sourceTarget = sourceBytes.toString("utf8");
              if (sourceTarget !== destinationTarget) untrackedConflicts.push(relativeValue);
            } else if (!isSymlink && destinationInfo.isFile()) {
              const destinationBytes = await fsPromises.readFile(destination);
              if (!sourceBytes.equals(destinationBytes)) untrackedConflicts.push(relativeValue);
            } else {
              untrackedConflicts.push(relativeValue);
            }
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            if (isSymlink) {
              const target = sourceBytes.toString("utf8");
              if (pathModule.isAbsolute(target) || path.win32.isAbsolute(target)) untrackedConflicts.push(relativeValue);
              else untrackedToCopy.push({ kind: "symlink", target, destination });
            } else {
              untrackedToCopy.push({ kind: "file", bytes: sourceBytes, mode: treeEntry.mode, destination });
            }
          }
        } catch {
          untrackedConflicts.push(relativeValue);
        }
      } else {
        const sourceDir = worktree.resultPath
          ? worktree.resultPath
          : worktree.path;
        const source = pathModule.resolve(sourceDir, relative);
        try {
          await assertAbsolutePathInWorkspace(source, { root: sourceDir, fsPromises, pathModule, allowMissing: true });
          await assertAbsolutePathInWorkspace(destination, { root: parentRoot, fsPromises, pathModule, allowMissing: true });
          let sourceInfo: fs.Stats | null = null;
          try {
            sourceInfo = await fsPromises.lstat(source);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }

          if (!sourceInfo) {
            // File was deleted in child
            try {
              const destinationInfo = await fsPromises.lstat(destination);
              if (destinationInfo.isFile()) {
                const [destBytes, baselineBytes] = await Promise.all([
                  fsPromises.readFile(destination),
                  fsPromises.readFile(pathModule.resolve(`${worktree.path}.baseline`, relative)).catch(() => null),
                ]);
                if (baselineBytes && destBytes.equals(baselineBytes)) {
                  untrackedToCopy.push({ kind: "delete", destination });
                } else {
                  untrackedConflicts.push(relativeValue);
                }
              } else {
                untrackedConflicts.push(relativeValue);
              }
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            }
            continue;
          }

          try {
            const destinationInfo = await fsPromises.lstat(destination);
            if (sourceInfo.isSymbolicLink() && destinationInfo.isSymbolicLink()) {
              const [sourceTarget, destinationTarget] = await Promise.all([
                fsPromises.readlink(source),
                fsPromises.readlink(destination),
              ]);
              if (sourceTarget !== destinationTarget) untrackedConflicts.push(relativeValue);
            } else if (sourceInfo.isFile() && destinationInfo.isFile()) {
              const [sourceBytes, destinationBytes] = await Promise.all([
                fsPromises.readFile(source),
                fsPromises.readFile(destination),
              ]);
              if (!sourceBytes.equals(destinationBytes)) {
                const baselineFile = pathModule.resolve(`${worktree.path}.baseline`, relative);
                let baseText = "";
                try {
                  baseText = await fsPromises.readFile(baselineFile, "utf8");
                } catch { /* new file */ }
                const isChildText = !sourceBytes.includes(0);
                const isParentText = !destinationBytes.includes(0);
                if (isChildText && isParentText) {
                  const mergeRes = mergeText3Way(baseText, destinationBytes.toString("utf8"), sourceBytes.toString("utf8"));
                  if (mergeRes.clean) {
                    untrackedToCopy.push({ kind: "file", bytes: Buffer.from(mergeRes.text, "utf8"), destination });
                  } else {
                    untrackedToCopy.push({ kind: "file", bytes: Buffer.from(mergeRes.text, "utf8"), destination });
                    untrackedConflicts.push(relativeValue);
                  }
                } else {
                  untrackedConflicts.push(relativeValue);
                }
              }
            } else {
              untrackedConflicts.push(relativeValue);
            }
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            if (sourceInfo.isSymbolicLink()) {
              const target = await fsPromises.readlink(source);
              if (pathModule.isAbsolute(target) || path.win32.isAbsolute(target)) untrackedConflicts.push(relativeValue);
              else untrackedToCopy.push({ kind: "symlink", target, destination });
            } else if (sourceInfo.isFile()) {
              untrackedToCopy.push({ kind: "file", source, destination });
            } else {
              untrackedConflicts.push(relativeValue);
            }
          }
        } catch {
          // Missing/changed source, unsafe aliases, and unreadable destinations
          // all preserve the parent and surface the exact path as a conflict.
          untrackedConflicts.push(relativeValue);
        }
      }
    }
    if (untrackedConflicts.length > 0) {
      return {
        merged: 0,
        conflicts: untrackedConflicts,
        conflictState: "parent-unchanged",
        changedFiles: state.changedFiles,
        diffStats: state.diffStats,
        status: "conflict",
        appliedPaths: [],
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
              status: "conflict",
              appliedPaths: [],
            };
          }
          return {
            merged: 0,
            conflicts: state.changedFiles,
            conflictState: "parent-unchanged",
            changedFiles: state.changedFiles,
            diffStats: state.diffStats,
            status: "conflict",
            appliedPaths: [],
          };
        }
      }
    }
    for (const entry of untrackedToCopy) {
      if (entry.kind === "delete") {
        try {
          await fsPromises.unlink(entry.destination);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        continue;
      }
      await fsPromises.mkdir(pathModule.dirname(entry.destination), { recursive: true });
      if (entry.kind === "symlink") {
        await fsPromises.symlink(entry.target, entry.destination);
      } else if (entry.bytes) {
        if (fsPromises.writeFile) {
          await fsPromises.writeFile(entry.destination, entry.bytes);
        } else {
          await fs.promises.writeFile(entry.destination, entry.bytes);
        }
        if (entry.mode === "100755") {
          try {
            await (fsPromises.chmod ? fsPromises.chmod(entry.destination, 0o755) : fs.promises.chmod(entry.destination, 0o755));
          } catch { /* platform ignore */ }
        }
      } else if (entry.source) {
        await fsPromises.copyFile(entry.source, entry.destination);
      }
    }
    return {
      merged: state.changedFiles.length,
      conflicts: [],
      conflictState: "none",
      changedFiles: state.changedFiles,
      diffStats: state.diffStats,
      status: "applied",
      appliedPaths: state.changedFiles,
    };
  };

  const reclaim = async (worktree: ThreadWorktree): Promise<{ reclaimed: boolean; reason?: string }> => {
    if (worktree.materialized === false) return { reclaimed: true };
    if (!worktree.resultCommit) {
      return { reclaimed: false, reason: "Thread worktree result has not been snapshotted" };
    }
    if (worktree.base === "zero-commit") {
      const snapshotDir = worktree.resultPath;
      try {
        if (!snapshotDir) throw new Error("Thread worktree result path missing");
        await fsPromises.stat(snapshotDir);
        const diff = await diffDirectories(snapshotDir, worktree.path);
        if (diff.diffStats.files > 0) {
          return { reclaimed: false, reason: "Thread worktree has uncommitted modifications" };
        }
      } catch {
        return { reclaimed: false, reason: "Thread worktree snapshot missing" };
      }
    } else {
      try {
        const status = await runGit(worktree.path, ["status", "--porcelain", "-z"]);
        if (status.stdout.length > 0) {
          return { reclaimed: false, reason: "Thread worktree has uncommitted modifications" };
        }
      } catch {
        // Ignored if path already missing or not a git worktree
      }
    }
    try {
      const rmFn = (fsPromises as typeof fs.promises).rm ?? fs.promises.rm;
      await rmFn(worktree.path, { recursive: true, force: true });
      worktree.materialized = false;
      return { reclaimed: true };
    } catch (error) {
      return { reclaimed: false, reason: error instanceof Error ? error.message : String(error) };
    }
  };

  const materialize = async (
    sourceRoot: string,
    worktree: ThreadWorktree,
    signal?: AbortSignal,
  ): Promise<ThreadWorktree> => {
    if (worktree.materialized !== false) {
      try {
        await fsPromises.stat(worktree.path);
        return worktree;
      } catch {
        // Missing on disk, continue to materialize
      }
    }
    if (worktree.base !== "zero-commit") {
      const ref = worktree.branch || worktree.resultCommit || worktree.base;
      await runGit(sourceRoot, ["worktree", "prune"]).catch(() => {});
      try {
        await runGit(sourceRoot, ["worktree", "add", "--force", worktree.path, ref]);
      } catch {
        await options.createWorktree(sourceRoot, {
          mode: "existing",
          worktreeName: pathModule.basename(worktree.path),
          branchName: worktree.branch,
          startRef: ref,
        });
      }
      await waitUntilReady(worktree.path, signal);
    } else {
      const snapshotDir = worktree.resultPath;
      const baselineDir = `${worktree.path}.baseline`;
      let src = "";
      try {
        if (!snapshotDir) throw new Error("Thread worktree result path missing");
        await fsPromises.stat(snapshotDir);
        src = snapshotDir;
      } catch {
        try {
          await fsPromises.stat(baselineDir);
          src = baselineDir;
        } catch {
          src = sourceRoot;
        }
      }
      await copyDirRecursive(src, worktree.path);
    }
    worktree.materialized = true;
    return worktree;
  };

  const prepareInputs = async (
    sourceRoot: string,
    worktree: ThreadWorktree,
    settings?: HarnessWorktreeSettings,
  ): Promise<void> => {
    for (const rel of settings?.copyIgnored ?? []) {
      const src = pathModule.resolve(sourceRoot, rel);
      const dst = pathModule.resolve(worktree.path, rel);
      await assertAbsolutePathInWorkspace(src, { root: sourceRoot, fsPromises, pathModule });
      await assertAbsolutePathInWorkspace(dst, { root: worktree.path, fsPromises, pathModule, allowMissing: true });
      const stat = await fsPromises.lstat(src);
      await fsPromises.mkdir(pathModule.dirname(dst), { recursive: true });
      if (stat.isSymbolicLink()) {
        await fsPromises.rm(dst, { recursive: true, force: true }).catch(() => undefined);
        await fsPromises.symlink(await fsPromises.readlink(src), dst);
      } else if (stat.isDirectory()) {
        const cpFn = (fsPromises as typeof fs.promises).cp ?? fs.promises.cp;
        await cpFn(src, dst, { recursive: true, force: true });
      } else if (stat.isFile()) {
        await fsPromises.copyFile(src, dst);
        await fsPromises.chmod(dst, stat.mode & 0o7777);
      }
    }
  };

  const runSetup = async (
    _sourceRoot: string,
    worktree: ThreadWorktree,
    settings?: HarnessWorktreeSettings,
    setupSignal?: AbortSignal,
  ): Promise<{ output: string }> => {
    if (!settings?.setup) return { output: "" };

    const timeoutMs = settings?.setupTimeoutMs;
    const command = settings.setup;
    return new Promise((resolve, reject) => {
      if (setupSignal?.aborted) {
        reject(asSetupFailure(abortError()));
        return;
      }

      let shell: string;
      let args: string[];
      if (options.interpreter && "command" in options.interpreter) {
        shell = options.interpreter.command;
        args = [...options.interpreter.args.filter((a) => a !== "-"), command];
      } else {
        const isWindows = process.platform === "win32";
        shell = isWindows ? (process.env.ComSpec || "powershell.exe") : "/bin/sh";
        args = isWindows
          ? (shell.toLowerCase().endsWith("cmd.exe") ? ["/d", "/s", "/c", command] : ["-Command", command])
          : ["-c", command];
      }

      const child = spawn(shell, args, {
        cwd: worktree.path,
        env: { ...(options.env ?? process.env), ...(options.interpreter && "env" in options.interpreter ? options.interpreter.env : {}) },
        windowsHide: true,
      });

      const chunks: Buffer[] = [];
      child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
      child.stderr?.on("data", (chunk: Buffer) => chunks.push(chunk));

      const timer = typeof timeoutMs === "number" && timeoutMs > 0 ? setTimeout(() => {
        child.kill();
        const output = Buffer.concat(chunks).toString("utf8");
        reject(asSetupFailure(new Error(`Setup command timed out after ${timeoutMs}ms:\n${output}`), output));
      }, timeoutMs) : null;

      setupSignal?.addEventListener("abort", () => {
        if (timer) clearTimeout(timer);
        child.kill();
        reject(asSetupFailure(abortError()));
      }, { once: true });

      child.once("error", (err) => {
        if (timer) clearTimeout(timer);
        reject(asSetupFailure(err));
      });

      child.once("close", (code) => {
        if (timer) clearTimeout(timer);
        const output = Buffer.concat(chunks).toString("utf8");
        if (code === 0) {
          resolve({ output });
        } else {
          reject(asSetupFailure(new Error(`Setup command failed with exit code ${code}:\n${output}`), output));
        }
      });
    });
  };

  const measureDiskUsage = async (worktree: ThreadWorktree): Promise<number> => {
    let totalBytes = 0;
    const scan = async (dir: string): Promise<void> => {
      const readdirFn = (fsPromises as typeof fs.promises).readdir ?? fs.promises.readdir;
      const entries = await readdirFn(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name === ".git") continue;
        const full = pathModule.join(dir, entry.name);
        if (entry.isDirectory()) {
          await scan(full);
        } else {
          const stat = await fsPromises.lstat(full);
          totalBytes += stat.size;
        }
      }
    };
    await scan(worktree.path);
    worktree.diskBytes = totalBytes;
    return totalBytes;
  };

  return { prepare, inspect, snapshot, importFixedResult, merge, reclaim, materialize, prepareInputs, runSetup, measureDiskUsage };
}

export type ThreadWorktreeRuntime = ReturnType<typeof createThreadWorktreeRuntime>;
