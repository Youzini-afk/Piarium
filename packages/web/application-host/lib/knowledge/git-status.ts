export interface GitStatusObservation {
  branch?: string;
  changed?: number;
  note?: string;
}

const recordOf = (value: unknown): Record<string, unknown> => (
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
);

/** Project the two Git status APIs onto the small, provider-neutral Zone 2 fact. */
export function projectGitStatusObservation(value: unknown): GitStatusObservation | null {
  const status = recordOf(value);
  if (status.isGitRepository === false) return null;
  const current = typeof status.current === "string" && status.current.trim()
    ? status.current.trim()
    : typeof status.branch === "string" && status.branch.trim()
      ? status.branch.trim()
      : undefined;
  const changed = Array.isArray(status.files) ? status.files.length : undefined;
  const notes: string[] = [];
  if (typeof status.ahead === "number" && status.ahead > 0) notes.push(`${status.ahead} ahead`);
  if (typeof status.behind === "number" && status.behind > 0) notes.push(`${status.behind} behind`);
  if (status.mergeInProgress) notes.push("merge in progress");
  if (status.rebaseInProgress) notes.push("rebase in progress");
  if (current === undefined && changed === undefined && notes.length === 0) return null;
  return {
    ...(current === undefined ? {} : { branch: current }),
    ...(changed === undefined ? {} : { changed }),
    ...(notes.length === 0 ? {} : { note: notes.join(", ") }),
  };
}
