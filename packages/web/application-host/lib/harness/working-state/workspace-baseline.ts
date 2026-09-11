/** Fixed workspace baseline at branch create: Git inventory or one directory scan. */

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
