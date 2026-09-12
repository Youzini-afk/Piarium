import fs from "node:fs";
import path from "node:path";
import type { RecoveryState } from "./types.js";
import type { WorkingStateStore } from "./working-state-store.js";
import { probeGitAttributes, smudgeBlobForWorktree, type GitAdaptationIo } from "./git-adaptation.js";

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
    const modeNum = parseInt(entry.mode, 8) & 0o7777;

    if (entry.mode === "120000") {
      // Symlink
      const catRes = await runGit(["cat-file", "-p", entry.objectHash]);
      const target = catRes.stdoutBuffer?.toString("utf8") ?? catRes.stdout;
      states[normalized] = {
        kind: "symlink",
        symlinkTarget: target,
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
        // Git records 0644/0755. The executable bit is repository truth even on
        // platforms whose filesystem cannot express it; comparisons normalize
        // per-platform (portableMode) and materialization chmods where possible.
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

/**
 * Import Git tree paths into the object store as *worktree bytes* — the
 * smudged view tools observe (D-243). `repoDir` must be inside the work tree
 * the commit belongs to so attribute resolution and filter processes see the
 * same configuration checkout would.
 */
export const importGitPathsToStore = async (
  store: WorkingStateStore,
  runGit: RunGitFn,
  commit: string,
  paths: string[],
  repoDir: string,
  io: GitAdaptationIo = { readFile: fs.promises.readFile, join: path.join },
): Promise<Record<string, RecoveryState>> => {
  const { states, entries } = await captureGitPathStates(runGit, commit, paths);
  const result: Record<string, RecoveryState> = {};
  const attributes = await probeGitAttributes(runGit, repoDir, paths).catch(() => new Map());

  for (const [p, state] of Object.entries(states)) {
    if (state.kind === "regular-file") {
      const entry = entries.get(p);
      if (entry) {
        const bytes = await smudgeBlobForWorktree(runGit, repoDir, p, entry.objectHash, attributes.get(p), io);
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
