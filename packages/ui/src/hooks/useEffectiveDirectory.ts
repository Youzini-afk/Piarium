import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { usePiSessionStore } from '@/stores/usePiSessionStore';

export const resolvePiEffectiveDirectory = (
  snapshotCwd: string | undefined,
  summaryCwd: string | undefined,
  fallbackDirectory: string | undefined,
): string | undefined => (
  snapshotCwd?.trim()
  || summaryCwd?.trim()
  || fallbackDirectory?.trim()
  || undefined
);

/**
 * Resolves the working directory owned by the active Pi session. Worktree
 * sessions need no side metadata because their native snapshot cwd is already
 * the worktree path.
 */
export const useEffectiveDirectory = (): string | undefined => {
  const sessionDirectory = usePiSessionStore((state) => {
    const sessionId = state.currentSessionId;
    if (!sessionId) return undefined;
    return resolvePiEffectiveDirectory(
      state.records[sessionId]?.snapshot?.cwd,
      state.summaries.find((summary) => summary.id === sessionId)?.cwd,
      undefined,
    );
  });
  const fallbackDirectory = useDirectoryStore((state) => state.currentDirectory);
  return sessionDirectory || fallbackDirectory?.trim() || undefined;
};
