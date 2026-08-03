import type { ProjectEntry } from '@/lib/api/types';
import { normalizePath } from '@/lib/pathNormalization';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { usePiSessionStore, selectActivePiSessions } from '@/stores/usePiSessionStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useUIStore } from '@/stores/useUIStore';
import type { SessionSnapshot, SessionSummary } from '@piarium/protocol';

export interface PiSessionOpenTarget {
  directory?: string | null;
  sessionId: string;
}

export interface PiSessionCreateTarget {
  directory?: string | null;
  projectId?: string | null;
}

const comparablePath = (path: string): string => (
  /^[A-Za-z]:(?:\/|$)/.test(path) ? path.toLowerCase() : path
);

const isPathWithin = (path: string, root: string): boolean => {
  const comparableTarget = comparablePath(path);
  const comparableRoot = comparablePath(root);
  return comparableTarget === comparableRoot
    || comparableTarget.startsWith(comparableRoot === '/' ? '/' : `${comparableRoot}/`);
};

export const findPiProjectForCwd = (
  projects: ProjectEntry[],
  cwd: string,
): ProjectEntry | null => {
  const normalizedCwd = normalizePath(cwd);
  if (!normalizedCwd) return null;
  return projects
    .map((project) => ({ normalizedPath: normalizePath(project.path), project }))
    .filter((entry): entry is { normalizedPath: string; project: ProjectEntry } => (
      entry.normalizedPath !== null && isPathWithin(normalizedCwd, entry.normalizedPath)
    ))
    .sort((left, right) => right.normalizedPath.length - left.normalizedPath.length)[0]?.project ?? null;
};

export const resolvePiSessionCreationCwd = (
  target: PiSessionCreateTarget,
  projects: ProjectEntry[],
  activeProjectId: string | null,
  currentDirectory: string,
): string | null => {
  const explicit = target.directory?.trim();
  if (explicit) return explicit;
  const requestedProject = target.projectId
    ? projects.find((project) => project.id === target.projectId)
    : undefined;
  if (requestedProject?.path.trim()) return requestedProject.path;
  const activeProject = activeProjectId
    ? projects.find((project) => project.id === activeProjectId)
    : undefined;
  return activeProject?.path.trim() || currentDirectory.trim() || null;
};

export const resolveRelativePiSession = (
  sessions: readonly SessionSummary[],
  currentSessionId: string | null,
  offset: number,
): SessionSummary | null => {
  if (sessions.length === 0 || !Number.isFinite(offset) || offset === 0) return null;
  const currentIndex = sessions.findIndex((session) => session.id === currentSessionId);
  const baseIndex = currentIndex === -1 ? (offset > 0 ? -1 : 0) : currentIndex;
  const nextIndex = ((baseIndex + Math.trunc(offset)) % sessions.length + sessions.length) % sessions.length;
  return sessions[nextIndex] ?? null;
};

const applyPiSessionLocation = (cwd: string, preferredProjectId?: string | null): void => {
  const projectsState = useProjectsStore.getState();
  const preferredProject = preferredProjectId
    ? projectsState.projects.find((project) => project.id === preferredProjectId)
    : undefined;
  const project = preferredProject ?? findPiProjectForCwd(projectsState.projects, cwd);
  if (project && project.id !== projectsState.activeProjectId) {
    projectsState.setActiveProjectIdOnly(project.id);
  }

  const directoryState = useDirectoryStore.getState();
  if (normalizePath(directoryState.currentDirectory) !== normalizePath(cwd)) {
    directoryState.setDirectory(cwd, { showOverlay: false });
  }
  const uiState = useUIStore.getState();
  uiState.setActiveMainTab('chat');
  uiState.setSessionSwitcherOpen(false);
};

export const openPiSessionFromNavigation = async (
  target: PiSessionOpenTarget,
): Promise<SessionSnapshot> => {
  const sessionId = target.sessionId.trim();
  if (!sessionId) throw new Error('A Pi session ID is required');
  const state = usePiSessionStore.getState();
  const summary = state.summaries.find((candidate) => candidate.id === sessionId);
  const cwd = target.directory?.trim() || summary?.cwd;
  const existing = state.records[sessionId];
  const snapshot = state.currentSessionId === sessionId && existing?.open && existing.snapshot
    ? existing.snapshot
    : await state.openSession({
        ...(cwd ? { cwd } : {}),
        sessionId,
      });
  applyPiSessionLocation(snapshot.cwd);
  return snapshot;
};

export const createPiSessionFromNavigation = async (
  target: PiSessionCreateTarget = {},
): Promise<SessionSnapshot> => {
  const projectsState = useProjectsStore.getState();
  const cwd = resolvePiSessionCreationCwd(
    target,
    projectsState.projects,
    projectsState.activeProjectId,
    useDirectoryStore.getState().currentDirectory,
  );
  if (!cwd) throw new Error('A working directory is required to create a Pi session');
  const snapshot = await usePiSessionStore.getState().createSession(cwd);
  applyPiSessionLocation(snapshot.cwd, target.projectId);
  return snapshot;
};

export const navigateRelativePiSession = async (offset: number): Promise<SessionSnapshot | null> => {
  let state = usePiSessionStore.getState();
  if (!state.catalogLoaded) {
    await state.loadCatalog();
    state = usePiSessionStore.getState();
  }
  const target = resolveRelativePiSession(
    selectActivePiSessions(state),
    state.currentSessionId,
    offset,
  );
  return target === null
    ? null
    : openPiSessionFromNavigation({ directory: target.cwd, sessionId: target.id });
};
