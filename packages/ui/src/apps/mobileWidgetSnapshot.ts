import type { SessionSummary } from '@piarium/protocol';

import { comparePiSessions, piSessionTitle } from '@/components/pi-session/sessionPresentation';
import type { ProjectEntry } from '@piarium/application-client';
import { useUIStore } from '@/stores/useUIStore';
import { selectActivePiSessions, usePiSessionStore } from '@/stores/usePiSessionStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { isSessionPinned, useSessionPinnedStore } from '@/stores/useSessionPinnedStore';
import { getRuntimeKey } from '@piarium/application-client';

/**
 * Builds the lightweight session overview the native iOS widgets render (home medium,
 * lock-screen, Control Center). The widget process can't see the WebView, so the native
 * shell pulls this snapshot via `window.__PIARIUM_WIDGET_SNAPSHOT__()` on
 * background/activate, writes it to the shared App Group, and reloads the widget timelines
 * (see SceneDelegate.writeWidgetSnapshot). Mirrors the sidebar's Pi attention logic so the
 * widget's "needs attention" mark matches the in-app completion/error indicator exactly:
 *   needsAttention = Pi completion/error attention && (!isSubtask || notifyOnSubtasks)
 */

export interface MobileWidgetSession {
  id: string;
  title: string;
  /** True when the session needs attention (completion/error + subtask preference). */
  unread: boolean;
  /** Project label for the session's directory (matched project name, else folder name). */
  project: string;
}

export interface MobileWidgetSnapshot {
  /** Runtime instance that owns all session IDs and paths in this snapshot. */
  runtimeKey: string;
  /** Count of sessions needing attention — same signal that drives the app-icon badge. */
  attentionCount: number;
  /** Top-level sessions in the app's shared lifecycle order (capped for the medium widget). */
  recentSessions: MobileWidgetSession[];
}

const RECENT_LIMIT = 6;

const basename = (path: string): string => {
  const trimmed = path.replace(/\/+$/, '');
  return trimmed.slice(trimmed.lastIndexOf('/') + 1) || trimmed;
};

const normalizeProjectPath = (path: string): string =>
  path.replace(/\\/g, '/').replace(/\/+$/, '');

/** Project label for a session directory: longest matching project's name, else the folder name. */
const projectLabelForDirectory = (directory: string | null, projects: ProjectEntry[]): string => {
  if (!directory) return '';
  let best: ProjectEntry | null = null;
  let bestLen = -1;
  for (const project of projects) {
    const projectPath = normalizeProjectPath(project.path);
    if (directory === projectPath || directory.startsWith(`${projectPath}/`)) {
      if (projectPath.length > bestLen) {
        best = project;
        bestLen = projectPath.length;
      }
    }
  }
  if (best) {
    return best.label?.trim() || basename(best.path);
  }
  return basename(directory);
};

export const buildMobileWidgetSnapshot = (): MobileWidgetSnapshot => {
  const sessions = selectActivePiSessions(usePiSessionStore.getState());
  const attentionBySession = usePiSessionStore.getState().attentionBySession;
  const notifyOnSubtasks = useUIStore.getState().notifyOnSubtasks;
  const projects = useProjectsStore.getState().projects;
  const pinnedSessionIds = useSessionPinnedStore.getState().ids;

  let attentionCount = 0;
  const topLevel: Array<{ session: SessionSummary; unread: boolean; project: string }> = [];

  for (const session of sessions) {
    const isSubtask = session.parentId !== undefined;
    const needsAttention = attentionBySession[session.id] !== undefined
      && (!isSubtask || notifyOnSubtasks);
    if (needsAttention) {
      attentionCount += 1;
    }
    if (!isSubtask) {
      topLevel.push({
        session,
        unread: needsAttention,
        project: projectLabelForDirectory(normalizeProjectPath(session.cwd), projects),
      });
    }
  }

  topLevel.sort((left, right) => comparePiSessions(
    left.session,
    right.session,
    (session) => isSessionPinned(pinnedSessionIds, session.cwd, session.id),
  ));
  const recentSessions = topLevel
    .slice(0, RECENT_LIMIT)
    .map(({ session, unread, project }) => ({ id: session.id, title: piSessionTitle(session, ''), unread, project }));

  return { runtimeKey: getRuntimeKey(), attentionCount, recentSessions };
};

const SNAPSHOT_GLOBAL_KEY = '__PIARIUM_WIDGET_SNAPSHOT__';

/**
 * Exposes the snapshot builder on `window` so the native shell can read it synchronously via
 * `evaluateJavaScript`. Returns a JSON string (the bridge wants a primitive result) or `null`
 * if building fails, so the native side can skip writing on error rather than clobber a good
 * snapshot. Safe to call in any runtime; only the native iOS shell ever invokes it.
 */
export const installMobileWidgetSnapshotBridge = (): void => {
  if (typeof window === 'undefined') {
    return;
  }
  (window as typeof window & { [SNAPSHOT_GLOBAL_KEY]?: () => string | null })[SNAPSHOT_GLOBAL_KEY] = () => {
    try {
      return JSON.stringify(buildMobileWidgetSnapshot());
    } catch {
      return null;
    }
  };
};
