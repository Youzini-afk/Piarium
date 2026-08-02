import type { SessionSummary } from '@piarium/protocol';
import { normalizePath } from '@/lib/pathNormalization';

const pathKey = (value: string): string => {
  const normalized = normalizePath(value) ?? value;
  return /^[A-Za-z]:\//.test(normalized) ? normalized.toLocaleLowerCase() : normalized;
};

export const collectPiWorktreeSessions = (
  summaries: SessionSummary[],
  worktreePath: string,
): SessionSummary[] => {
  const target = pathKey(worktreePath);
  const byParent = new Map<string, SessionSummary[]>();
  const direct = summaries.filter((summary) => pathKey(summary.cwd) === target);
  for (const summary of summaries) {
    if (!summary.parentId) continue;
    const children = byParent.get(summary.parentId) ?? [];
    children.push(summary);
    byParent.set(summary.parentId, children);
  }

  const result: SessionSummary[] = [];
  const visited = new Set<string>();
  const pending = [...direct];
  while (pending.length > 0) {
    const summary = pending.shift();
    if (!summary || visited.has(summary.id)) continue;
    visited.add(summary.id);
    result.push(summary);
    pending.push(...(byParent.get(summary.id) ?? []));
  }
  return result;
};
