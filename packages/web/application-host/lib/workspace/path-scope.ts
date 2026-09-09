const normalizeScopePath = (value: string): string => {
  const normalized = value.replace(/\\/g, "/").replace(/^\.\//, "");
  return normalized === "." ? "" : process.platform === "win32" ? normalized.toLowerCase() : normalized;
};

/** A root of `.` (or an empty normalized root) covers the whole workspace. */
export function rootsAreRestricted(roots: readonly string[] | undefined): boolean {
  return Boolean(roots?.length && !roots.some((root) => normalizeScopePath(root).replace(/\/$/, "") === ""));
}

/**
 * Match workspace-relative paths against fixed roots used by Harness queries.
 * Keep this rule shared by the query engine and its graph/vector backends.
 */
export function pathInRoots(candidate: string, roots: readonly string[] | undefined): boolean {
  if (!roots || roots.length === 0) return true;
  const path = normalizeScopePath(candidate);
  return roots.some((root) => {
    const prefix = normalizeScopePath(root).replace(/\/$/, "");
    return !prefix || path === prefix || path.startsWith(`${prefix}/`);
  });
}
