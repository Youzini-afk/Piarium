import React from 'react';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { usePiSessionStore } from '@/stores/usePiSessionStore';
import type { ProjectRef } from '@/lib/openchamberConfig';

export interface ProjectActionsContext {
  projectRef: ProjectRef;
  directory: string;
}

const normalize = (value: string): string => {
  if (!value) return '';
  const replaced = value.replace(/\\/g, '/');
  return replaced === '/' ? '/' : replaced.replace(/\/+$/, '');
};

/**
 * Resolves the active project ref + working directory used by
 * {@link ProjectActionsButton}. Directory priority mirrors the header:
 * current Pi session → project path. A sticky ref keeps the last
 * good context so the actions button doesn't flicker during session switches.
 */
export function useProjectActionsContext(): ProjectActionsContext | null {
  const activeProject = useProjectsStore((state) => {
    if (!state.activeProjectId) {
      return null;
    }
    return state.projects.find((project) => project.id === state.activeProjectId) ?? null;
  });

  const sessionDirectory = usePiSessionStore((state) => {
    const sessionId = state.currentSessionId;
    if (!sessionId) return '';
    return normalize(
      state.records[sessionId]?.snapshot?.cwd
      ?? state.summaries.find((summary) => summary.id === sessionId)?.cwd
      ?? '',
    );
  });
  const actionDirectory = React.useMemo(
    () => normalize(sessionDirectory || activeProject?.path || ''),
    [activeProject?.path, sessionDirectory],
  );
  const activeProjectRef = React.useMemo<ProjectRef | null>(() => {
    if (!activeProject) {
      return null;
    }
    return { id: activeProject.id, path: activeProject.path };
  }, [activeProject]);

  const lastContextRef = React.useRef<ProjectActionsContext | null>(null);
  React.useEffect(() => {
    if (activeProjectRef && actionDirectory) {
      lastContextRef.current = { projectRef: activeProjectRef, directory: actionDirectory };
    }
  }, [actionDirectory, activeProjectRef]);

  return React.useMemo(() => {
    if (activeProjectRef && actionDirectory) {
      return { projectRef: activeProjectRef, directory: actionDirectory };
    }
    return lastContextRef.current;
  }, [activeProjectRef, actionDirectory]);
}
