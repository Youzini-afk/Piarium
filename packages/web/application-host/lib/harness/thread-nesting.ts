/** Host-enforced nested-thread scope and tool checks. */

export const THREAD_CONTROL_TOOL_NAMES = [
  "dispatch",
  "threads",
  "wait",
  "send",
  "read_thread",
  "merge",
  "kill",
] as const;

export type ThreadControlToolName = (typeof THREAD_CONTROL_TOOL_NAMES)[number];

export const normalizeThreadScopePath = (value: string): string => (
  value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "")
);

export const scopePathContainedBy = (parentScope: string, childPath: string): boolean => {
  const parent = normalizeThreadScopePath(parentScope);
  const child = normalizeThreadScopePath(childPath);
  if (!parent || parent === ".") return true;
  if (!child || child === ".") return false;
  return child === parent || child.startsWith(`${parent}/`);
};

export const resolveNestedThreadScope = (
  parentScope: readonly string[],
  requested: readonly string[] | undefined,
): { ok: true; scope: string[] } | { ok: false; expanded: string[] } => {
  if (parentScope.length === 0) {
    return { ok: true, scope: requested?.length ? [...requested] : [] };
  }
  if (!requested?.length) return { ok: true, scope: [...parentScope] };
  const expanded = requested.filter((path) => (
    !parentScope.some((root) => scopePathContainedBy(root, path))
  ));
  if (expanded.length > 0) return { ok: false, expanded };
  return { ok: true, scope: [...requested] };
};
