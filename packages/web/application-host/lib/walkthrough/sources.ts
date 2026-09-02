import { getDiff, getRangeDiff, getUntrackedDiffs, listUntrackedPaths } from '../git/service.js';
import type { DiffSection, PullRequestDiff, WalkthroughSource } from './types.js';

// A walkthrough source resolves to one or more diff *sections*. A section is a
// patch plus the scope its hunk ids live in; keeping staged and working-tree
// changes in separate scopes means a stop written against staged code never
// silently re-anchors onto an unstaged edit of the same lines.

const WORKING_TREE_SCOPES = new Set(['all', 'staged', 'working']);

export class WalkthroughSourceError extends Error {
  readonly code?: string;
  readonly statusCode: number;

  constructor(message: string, statusCode = 400, code?: string) {
    super(message);
    this.statusCode = statusCode;
    if (code) this.code = code;
  }
}

/**
 * Normalize and validate an untrusted source descriptor from the client.
 */
export function parseSource(raw: unknown): WalkthroughSource {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new WalkthroughSourceError('source is required');
  }

  const source = raw as Record<string, unknown>;
  if (source.kind === 'working-tree') {
    const scope = typeof source.scope === 'string' ? source.scope : 'all';
    if (!WORKING_TREE_SCOPES.has(scope)) {
      throw new WalkthroughSourceError(`Unknown working-tree scope "${scope}"`);
    }
    return { kind: 'working-tree', scope: scope as 'all' | 'staged' | 'working' };
  }

  if (source.kind === 'branch') {
    const baseRef = typeof source.baseRef === 'string' ? source.baseRef.trim() : '';
    const headRef = typeof source.headRef === 'string' ? source.headRef.trim() : '';
    if (!baseRef || !headRef) {
      throw new WalkthroughSourceError('branch sources require baseRef and headRef');
    }
    return { kind: 'branch', baseRef, headRef };
  }

  if (source.kind === 'pr') {
    const number = Number(source.number);
    if (!Number.isInteger(number) || number <= 0) {
      throw new WalkthroughSourceError('pr sources require a positive number');
    }
    return { kind: 'pr', number };
  }

  throw new WalkthroughSourceError(`Unknown source kind "${String(source.kind)}"`);
}

/**
 * Stable string form of a source, used as the pointer key and as part of the
 * cache key. Must not change shape casually — it addresses persisted files.
 */
export function sourceKey(source: WalkthroughSource): string {
  if (source.kind === 'working-tree') return `working-tree:${source.scope}`;
  if (source.kind === 'branch') return `branch:${source.baseRef}...${source.headRef}`;
  return `pr:${source.number}`;
}

// `git diff` never reports untracked files, so a brand-new file would be
// invisible in a walkthrough of local work. The batch helper resolves the
// repository once instead of repeating discovery for every file.
const untrackedSections = async (directory: string): Promise<string[]> => {
  const untracked = await listUntrackedPaths(directory);
  if (untracked.length === 0) return [];

  const patches: unknown[] = await getUntrackedDiffs(directory, untracked);
  return patches.filter((patch): patch is string => typeof patch === 'string' && Boolean(patch.trim()));
};

/**
 * Resolve a source into diff sections.
 *
 * @returns {Promise<{sections: Array<{scope: string, patch: string}>, meta: object}>}
 */
export async function loadSourceSections(
  directory: string,
  source: WalkthroughSource,
  { getPullRequestDiff }: {
    getPullRequestDiff?: (directory: string, number: number) => Promise<PullRequestDiff>;
  } = {},
): Promise<{ meta: Record<string, unknown>; sections: DiffSection[] }> {
  if (source.kind === 'working-tree') {
    const sections: DiffSection[] = [];

    if (source.scope === 'all' || source.scope === 'staged') {
      const patch = await getDiff(directory, { staged: true });
      if (patch && patch.trim()) sections.push({ scope: 'staged', patch });
    }

    if (source.scope === 'all' || source.scope === 'working') {
      const patch = await getDiff(directory, { staged: false });
      const untracked = await untrackedSections(directory);
      const combined = [patch, ...untracked].filter((value) => value && value.trim()).join('\n');
      if (combined.trim()) sections.push({ scope: 'working', patch: combined });
    }

    return { sections, meta: {} };
  }

  if (source.kind === 'branch') {
    const rangeDiff = getRangeDiff as (
      directory: string,
      options: { base: string; head: string },
    ) => Promise<string>;
    const patch = await rangeDiff(directory, { base: source.baseRef, head: source.headRef });
    return {
      sections: patch && patch.trim() ? [{ scope: 'branch', patch }] : [],
      meta: { baseRef: source.baseRef, headRef: source.headRef },
    };
  }

  if (typeof getPullRequestDiff !== 'function') {
    throw new WalkthroughSourceError('Pull request diffs are unavailable', 500);
  }

  const { patch, meta } = await getPullRequestDiff(directory, source.number);
  return {
    sections: patch && patch.trim() ? [{ scope: `pr:${source.number}`, patch }] : [],
    meta: meta || {},
  };
}
