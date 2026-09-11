/** Fixed workspace baseline at branch create: Git inventory or one directory scan. */

export type GitBaselineInventory = {
  kind: "git";
  baseRef: string;
  unborn: boolean;
  paths: string[];
  gitlinks: string[];
};

export type BaselineInventory = GitBaselineInventory | { kind: "directory" };

export const withAncestorDirectories = (paths: readonly string[]): string[] => {
  const result = new Set<string>();
  for (const file of paths) {
    const normalized = file.replace(/\\/g, "/").replace(/^\.\//, "");
    if (!normalized || normalized === ".") continue;
    result.add(normalized);
    let parent = normalized.includes("/") ? normalized.slice(0, normalized.lastIndexOf("/")) : "";
    while (parent) {
      result.add(parent);
      parent = parent.includes("/") ? parent.slice(0, parent.lastIndexOf("/")) : "";
    }
  }
  return [...result].sort();
};

export const parseGitNullList = (value: string): string[] => value.split("\0").filter(Boolean);

export const parseGitStageList = (value: string): Array<{ mode: string; path: string }> => {
  const entries: Array<{ mode: string; path: string }> = [];
  for (const token of value.split("\0").filter(Boolean)) {
    const tab = token.indexOf("\t");
    if (tab === -1) continue;
    const mode = token.slice(0, tab).trim().split(/\s+/)[0];
    const entryPath = token.slice(tab + 1);
    if (mode && entryPath) entries.push({ mode, path: entryPath });
  }
  return entries;
};

export const isNotGitRepositoryError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error);
  return /not a git repository/i.test(message);
};

export const isUnbornHeadError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error);
  return /ambiguous argument ['"]?HEAD['"]?/i.test(message)
    || /unknown revision/i.test(message)
    || /needed a single revision/i.test(message);
};

export const gitBaselineFingerprint = (inventory: GitBaselineInventory): string => JSON.stringify({
  baseRef: inventory.baseRef,
  unborn: inventory.unborn,
  paths: [...inventory.paths].sort(),
  gitlinks: [...inventory.gitlinks].sort(),
});

export const directoryBaselineFingerprint = (paths: readonly string[]): string => (
  `directory:${[...paths].sort().join("\0")}`
);
