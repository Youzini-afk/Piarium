/**
 * Derives the base ("target") branch a feature branch should compare and
 * merge against. Shared by GitView and the standalone pull-request surface so
 * both resolve the same base for the same repository state.
 */
export const deriveBaseBranch = (options: {
  remoteNames: ReadonlySet<string>;
  localBranches: readonly string[];
  worktreeCreatedFromBranch?: string | null;
  rootBranchHint?: string | null;
  defaultBranch?: string | null;
  headBranch?: string | null;
}): string => {
  const {
    remoteNames,
    localBranches,
    worktreeCreatedFromBranch,
    rootBranchHint,
    defaultBranch,
    headBranch,
  } = options;
  const head = typeof headBranch === 'string' ? headBranch.trim() : '';

  const normalizeBaseCandidate = (value: string): string => {
    if (!value) {
      return '';
    }

    let normalized = value.trim();
    if (!normalized || normalized === 'HEAD') {
      return '';
    }

    if (localBranches.includes(normalized)) {
      return normalized;
    }

    if (normalized.startsWith('refs/heads/')) {
      normalized = normalized.slice('refs/heads/'.length);
    }
    if (normalized.startsWith('heads/')) {
      normalized = normalized.slice('heads/'.length);
    }
    if (normalized.startsWith('remotes/')) {
      normalized = normalized.slice('remotes/'.length);
    }

    const slashIndex = normalized.indexOf('/');
    if (slashIndex > 0) {
      const maybeRemote = normalized.slice(0, slashIndex);
      if (remoteNames.has(maybeRemote)) {
        const withoutRemote = normalized.slice(slashIndex + 1).trim();
        if (withoutRemote) {
          normalized = withoutRemote;
        }
      }
    }

    return normalized;
  };

  const candidate = (value: unknown): string => {
    const normalized = normalizeBaseCandidate(typeof value === 'string' ? value : '');
    return normalized && normalized !== head ? normalized : '';
  };

  const fromMeta = candidate(worktreeCreatedFromBranch);
  if (fromMeta) return fromMeta;

  const fromHint = candidate(rootBranchHint);
  if (fromHint) return fromHint;

  const fromDefault = candidate(defaultBranch);
  if (fromDefault) return fromDefault;

  if (localBranches.includes('main')) return 'main';
  if (localBranches.includes('master')) return 'master';
  if (localBranches.includes('develop')) return 'develop';
  return 'main';
};

export const hasResolvableBaseBranch = (options: {
  baseBranch: string;
  localBranches: readonly string[];
  remoteBranches: readonly string[];
}): boolean => {
  const { baseBranch, localBranches, remoteBranches } = options;
  if (localBranches.includes(baseBranch)) return true;
  return remoteBranches.some((branch) => {
    const slashIndex = branch.indexOf('/');
    return slashIndex > 0 && branch.slice(slashIndex + 1) === baseBranch;
  });
};
