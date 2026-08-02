import React from 'react';
import type { SessionSummary } from '@piarium/protocol';
import { selectActivePiSessions, usePiSessionStore } from '@/stores/usePiSessionStore';
import { useUIStore } from '@/stores/useUIStore';

const DAY_MS = 24 * 60 * 60 * 1000;
const AUTO_DELETE_KEEP_RECENT = 5;
const AUTO_DELETE_INTERVAL_MS = 24 * 60 * 60 * 1000;

const sessionActivityTime = (session: SessionSummary): number => {
  const timestamp = Date.parse(session.updatedAt || session.createdAt);
  return Number.isFinite(timestamp) ? timestamp : 0;
};

export interface BuildPiCleanupCandidatesOptions {
  currentSessionId: string | null;
  cutoffDays: number;
  keepRecent?: number;
  now?: number;
  sessions: SessionSummary[];
}

export const buildPiCleanupCandidates = ({
  currentSessionId,
  cutoffDays,
  keepRecent = AUTO_DELETE_KEEP_RECENT,
  now = Date.now(),
  sessions,
}: BuildPiCleanupCandidatesOptions): string[] => {
  if (!Array.isArray(sessions) || cutoffDays <= 0) return [];
  const cutoffTime = now - cutoffDays * DAY_MS;
  const sorted = [...sessions]
    .filter((session) => session.archivedAt === undefined)
    .sort((left, right) => sessionActivityTime(right) - sessionActivityTime(left));
  const protectedIds = new Set(
    sorted.slice(0, Math.max(0, keepRecent)).map((session) => session.id),
  );
  return sorted
    .filter((session) => (
      Boolean(session.id)
      && session.id !== currentSessionId
      && !protectedIds.has(session.id)
      && sessionActivityTime(session) > 0
      && sessionActivityTime(session) < cutoffTime
    ))
    .map((session) => session.id);
};

export interface PiCleanupResult {
  action: 'archive' | 'delete';
  completedIds: string[];
  failedIds: string[];
  skippedReason?: 'disabled' | 'loading' | 'cooldown' | 'no-candidates' | 'running';
}

interface PiCleanupOptions {
  autoRun?: boolean;
  enabled?: boolean;
}

export const usePiSessionAutoCleanup = (enabledOrOptions?: boolean | PiCleanupOptions) => {
  const options = typeof enabledOrOptions === 'object' ? enabledOrOptions : undefined;
  const autoRun = options?.autoRun !== false;
  const enabled = typeof enabledOrOptions === 'boolean'
    ? enabledOrOptions
    : (options?.enabled ?? true);
  const currentSessionId = usePiSessionStore((state) => state.currentSessionId);
  const catalogCwd = usePiSessionStore((state) => state.catalogCwd);
  const catalogLoaded = usePiSessionStore((state) => state.catalogLoaded);
  const catalogLoading = usePiSessionStore((state) => state.catalogLoading);
  const activeSessions = usePiSessionStore(selectActivePiSessions);
  const autoDeleteEnabled = useUIStore((state) => state.autoDeleteEnabled);
  const autoDeleteAfterDays = useUIStore((state) => state.autoDeleteAfterDays);
  const sessionRetentionAction = useUIStore((state) => state.sessionRetentionAction);
  const autoDeleteLastRunAt = useUIStore((state) => state.autoDeleteLastRunAt);
  const setAutoDeleteLastRunAt = useUIStore((state) => state.setAutoDeleteLastRunAt);
  const [isRunning, setIsRunning] = React.useState(false);
  const runningRef = React.useRef(false);
  const needsGlobalCatalog = enabled && (!autoRun || autoDeleteEnabled);

  React.useEffect(() => {
    if (!needsGlobalCatalog || catalogLoading || (catalogLoaded && catalogCwd === null)) return;
    void usePiSessionStore.getState().loadCatalog().catch(() => undefined);
  }, [catalogCwd, catalogLoaded, catalogLoading, needsGlobalCatalog]);

  const candidates = React.useMemo(() => buildPiCleanupCandidates({
    currentSessionId,
    cutoffDays: autoDeleteAfterDays,
    sessions: activeSessions,
  }), [activeSessions, autoDeleteAfterDays, currentSessionId]);

  const runCleanup = React.useCallback(async (
    { force = false }: { force?: boolean } = {},
  ): Promise<PiCleanupResult> => {
    if (runningRef.current) {
      return { action: sessionRetentionAction, completedIds: [], failedIds: [], skippedReason: 'running' };
    }
    if ((!autoDeleteEnabled || autoDeleteAfterDays <= 0) && !force) {
      return { action: sessionRetentionAction, completedIds: [], failedIds: [], skippedReason: 'disabled' };
    }
    if (usePiSessionStore.getState().catalogLoading) {
      return { action: sessionRetentionAction, completedIds: [], failedIds: [], skippedReason: 'loading' };
    }
    const now = Date.now();
    if (!force && autoDeleteLastRunAt && now - autoDeleteLastRunAt < AUTO_DELETE_INTERVAL_MS) {
      return { action: sessionRetentionAction, completedIds: [], failedIds: [], skippedReason: 'cooldown' };
    }

    const sessions = await usePiSessionStore.getState().loadCatalog();
    const candidateIds = buildPiCleanupCandidates({
      currentSessionId: usePiSessionStore.getState().currentSessionId,
      cutoffDays: autoDeleteAfterDays,
      now,
      sessions,
    });
    if (candidateIds.length === 0) {
      setAutoDeleteLastRunAt(now);
      return { action: sessionRetentionAction, completedIds: [], failedIds: [], skippedReason: 'no-candidates' };
    }

    runningRef.current = true;
    setIsRunning(true);
    try {
      const completedIds: string[] = [];
      const failedIds: string[] = [];
      for (const sessionId of candidateIds) {
        try {
          const state = usePiSessionStore.getState();
          if (sessionRetentionAction === 'archive') await state.archiveSession(sessionId);
          else await state.deleteSession(sessionId);
          completedIds.push(sessionId);
        } catch {
          failedIds.push(sessionId);
        }
      }
      return { action: sessionRetentionAction, completedIds, failedIds };
    } finally {
      runningRef.current = false;
      setIsRunning(false);
      setAutoDeleteLastRunAt(Date.now());
    }
  }, [
    autoDeleteAfterDays,
    autoDeleteEnabled,
    autoDeleteLastRunAt,
    sessionRetentionAction,
    setAutoDeleteLastRunAt,
  ]);

  React.useEffect(() => {
    if (
      !enabled
      || !autoRun
      || !autoDeleteEnabled
      || autoDeleteAfterDays <= 0
      || catalogLoading
      || !catalogLoaded
      || catalogCwd !== null
      || activeSessions.length === 0
    ) return;
    const now = Date.now();
    if (autoDeleteLastRunAt && now - autoDeleteLastRunAt < AUTO_DELETE_INTERVAL_MS) return;
    void runCleanup();
  }, [
    activeSessions.length,
    autoDeleteAfterDays,
    autoDeleteEnabled,
    autoDeleteLastRunAt,
    autoRun,
    catalogCwd,
    catalogLoaded,
    catalogLoading,
    enabled,
    runCleanup,
  ]);

  return {
    action: sessionRetentionAction,
    candidates,
    isRunning,
    keepRecentCount: AUTO_DELETE_KEEP_RECENT,
    runCleanup,
  };
};
