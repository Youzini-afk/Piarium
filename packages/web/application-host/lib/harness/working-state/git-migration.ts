import type { RecoveryState, RegularFileState, SymlinkState } from "./types.js";
import type { WorkingStateStore } from "./working-state-store.js";

export interface GitTreeEntry {
  mode: string;
  type: string;
  objectHash: string;
  path: string;
}

export type RunGitFn = (
  args: string[],
  cwd?: string,
) => Promise<{ stdout: string; stderr: string; exitCode: number; stdoutBuffer?: Buffer }>;

export const parseLsTree = (output: string): GitTreeEntry[] => {
  if (!output) return [];
  const entries: GitTreeEntry[] = [];
  const parts = output.split("\0");
  for (const part of parts) {
    if (!part) continue;
    const tabIndex = part.indexOf("\t");
    if (tabIndex === -1) continue;
    const metaStr = part.slice(0, tabIndex).trim();
    const filePath = part.slice(tabIndex + 1);
    const meta = metaStr.split(/\s+/);
    if (meta.length >= 3) {
      const [mode, type, objectHash] = meta;
      if (mode && type && objectHash) {
        entries.push({ mode, type, objectHash, path: filePath });
      }
    }
  }
  return entries;
};

export const captureGitChangedPaths = async (
  runGit: RunGitFn,
  baseCommit: string,
  resultCommit: string,
): Promise<string[]> => {
  const { stdout } = await runGit(["diff", "--name-only", "-z", baseCommit, resultCommit]);
  if (!stdout) return [];
  return stdout.split("\0").filter(Boolean);
};

export const captureGitPathStates = async (
  runGit: RunGitFn,
  commit: string,
  paths?: string[],
): Promise<{
  states: Record<string, RecoveryState>;
  entries: Map<string, GitTreeEntry>;
}> => {
  const args = ["ls-tree", "-z", "-r", commit];
  if (paths && paths.length > 0) {
    args.push("--", ...paths);
  }
  const { stdout } = await runGit(args);
  const entries = parseLsTree(stdout);
  const entryMap = new Map<string, GitTreeEntry>();
  const states: Record<string, RecoveryState> = {};

  for (const entry of entries) {
    const normalized = entry.path.replace(/\\/g, "/");
    entryMap.set(normalized, entry);
    const modeNum = parseInt(entry.mode, 8);

    if (entry.mode === "120000") {
      // Symlink
      const catRes = await runGit(["cat-file", "-p", entry.objectHash]);
      const target = (catRes.stdoutBuffer?.toString("utf8") ?? catRes.stdout).trim();
      states[normalized] = {
        kind: "symlink",
        symlinkTarget: target,
        mode: modeNum,
      };
    } else if (entry.mode === "040000") {
      states[normalized] = {
        kind: "directory",
        mode: modeNum,
      };
    } else {
      // Regular file (100644 or 100755)
      const sizeRes = await runGit(["cat-file", "-s", entry.objectHash]);
      const byteLength = parseInt(sizeRes.stdout.trim(), 10) || 0;
      states[normalized] = {
        kind: "regular-file",
        objectHash: entry.objectHash,
        byteLength,
        mode: modeNum,
      };
    }
  }

  // If specific paths were requested, any path not in the tree is missing
  if (paths) {
    for (const p of paths) {
      const normalized = p.replace(/\\/g, "/");
      if (!states[normalized]) {
        states[normalized] = { kind: "missing" };
      }
    }
  }

  return { states, entries: entryMap };
};

export const importGitPathsToStore = async (
  store: WorkingStateStore,
  runGit: RunGitFn,
  commit: string,
  paths: string[],
): Promise<Record<string, RecoveryState>> => {
  const { states, entries } = await captureGitPathStates(runGit, commit, paths);
  const result: Record<string, RecoveryState> = {};

  for (const [p, state] of Object.entries(states)) {
    if (state.kind === "regular-file") {
      const entry = entries.get(p);
      if (entry) {
        const catRes = await runGit(["cat-file", "-p", entry.objectHash]);
        const bytes = catRes.stdoutBuffer ?? Buffer.from(catRes.stdout, "utf8");
        const { hash, byteLength } = await store.putObject(bytes);
        result[p] = {
          kind: "regular-file",
          objectHash: hash,
          byteLength,
          mode: state.mode,
        };
      } else {
        result[p] = state;
      }
    } else {
      result[p] = state;
    }
  }

  return result;
};
