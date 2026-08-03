import React from 'react';
import type { SessionSummary } from '@piarium/protocol';
import { isWebRuntime } from '@/lib/desktop';
import { PWA_RECENT_SESSIONS_STORAGE_KEY } from '@/lib/pwa';
import { usePiSessionStore } from '@/stores/usePiSessionStore';

type RecentSessionShortcut = {
  sessionId: string;
  title: string;
};

type ManifestSyncWindow = Window & {
  __PIARIUM_UPDATE_PWA_MANIFEST__?: () => void;
};

const MAX_RECENT_SHORTCUTS = 3;

const normalizeRecentTitle = (value: string | undefined, fallback: string): string => {
  if (typeof value !== 'string') {
    return fallback;
  }
  const normalized = value.trim().replace(/\s+/g, ' ');
  if (!normalized) {
    return fallback;
  }
  return normalized.slice(0, 48);
};

export const buildPiRecentShortcuts = (
  sessions: SessionSummary[],
  currentSessionId: string | null,
): RecentSessionShortcut[] => {
  const activeSessions = sessions.filter((session) => session.archivedAt === undefined);
  const ordered = currentSessionId
    ? [
        ...activeSessions.filter((session) => session.id === currentSessionId),
        ...activeSessions.filter((session) => session.id !== currentSessionId),
      ]
    : activeSessions;

  const shortcuts: RecentSessionShortcut[] = [];
  const seen = new Set<string>();

  for (const session of ordered) {
    const sessionId = typeof session.id === 'string' ? session.id.trim() : '';
    if (!sessionId || seen.has(sessionId)) {
      continue;
    }

    seen.add(sessionId);
    shortcuts.push({
      sessionId,
      title: normalizeRecentTitle(
        session.name || session.firstMessage,
        `Session ${shortcuts.length + 1}`,
      ),
    });

    if (shortcuts.length >= MAX_RECENT_SHORTCUTS) {
      break;
    }
  }

  return shortcuts;
};

export const usePwaManifestSync = () => {
  const sessions = usePiSessionStore((state) => state.summaries);
  const currentSessionId = usePiSessionStore((state) => state.currentSessionId);

  const recentShortcuts = React.useMemo(() => {
    return buildPiRecentShortcuts(sessions, currentSessionId);
  }, [currentSessionId, sessions]);

  const signature = React.useMemo(() => JSON.stringify(recentShortcuts), [recentShortcuts]);
  const hasRecentShortcuts = recentShortcuts.length > 0;

  React.useEffect(() => {
    if (typeof window === 'undefined' || !isWebRuntime()) {
      return;
    }

    try {
      if (!hasRecentShortcuts) {
        localStorage.removeItem(PWA_RECENT_SESSIONS_STORAGE_KEY);
      } else {
        localStorage.setItem(PWA_RECENT_SESSIONS_STORAGE_KEY, signature);
      }
    } catch {
      return;
    }

    const win = window as ManifestSyncWindow;
    win.__PIARIUM_UPDATE_PWA_MANIFEST__?.();
  }, [hasRecentShortcuts, signature]);
};
