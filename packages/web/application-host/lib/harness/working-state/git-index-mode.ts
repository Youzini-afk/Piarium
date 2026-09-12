/** Git index executable-mode authority for WorkingState capture. */

import type { RecoveryState } from "./types.js";

export type RunGitForIndex = (
  args: string[],
  cwd?: string,
) => Promise<{ stdout: string }>;

/** `git ls-files -s -z` → path → index mode ("100644" | "100755" | …). */
export const gitIndexModes = async (
  runGit: RunGitForIndex,
  cwd: string,
): Promise<Map<string, string>> => {
  const { stdout } = await runGit(["ls-files", "-s", "-z"], cwd);
  const modes = new Map<string, string>();
  for (const token of stdout.split("\0")) {
    if (!token) continue;
    const tab = token.indexOf("\t");
    if (tab === -1) continue;
    const mode = token.slice(0, tab).trim().split(/\s+/)[0];
    const file = token.slice(tab + 1).replace(/\\/g, "/").replace(/^\.\//, "");
    if (mode && file) modes.set(file, mode);
  }
  return modes;
};

const regularFileMode = (indexMode: string): number | undefined => {
  if (indexMode === "100755") return 0o755;
  if (indexMode === "100644") return 0o644;
  return undefined;
};

/**
 * Windows cannot observe Git's executable bit through lstat. Overlay the
 * index truth onto captured regular files; POSIX keeps the observed mode.
 */
export const applyIndexModes = (
  states: Record<string, RecoveryState>,
  indexModes: Map<string, string> | Record<string, string> | undefined,
): Record<string, RecoveryState> => {
  if (!indexModes || process.platform !== "win32") return states;
  const lookup = indexModes instanceof Map ? (key: string) => indexModes.get(key) : (key: string) => indexModes[key];
  const result: Record<string, RecoveryState> = {};
  for (const [file, state] of Object.entries(states)) {
    if (state.kind !== "regular-file") {
      result[file] = state;
      continue;
    }
    const mode = regularFileMode(lookup(file.replace(/\\/g, "/").replace(/^\.\//, "")) ?? "");
    result[file] = mode === undefined ? state : { ...state, mode };
  }
  return result;
};
