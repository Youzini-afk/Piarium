import { describe, expect, test } from 'bun:test';
import type { ProjectEntry } from '@/lib/api/types';
import type { SessionSummary } from '@piarium/protocol';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { usePiSessionStore } from '@/stores/usePiSessionStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useUIStore } from '@/stores/useUIStore';
import {
  findPiProjectForCwd,
  openPiSessionFromNavigation,
  resolvePiSessionCreationCwd,
  resolvePiSessionWorkspaceBinding,
  resolveRelativePiSession,
  startPiSessionDraftFromNavigation,
} from './sessionNavigation';

const project = (id: string, path: string): ProjectEntry => ({ id, path });
const session = (id: string): SessionSummary => ({
  allMessagesText: '',
  createdAt: '2026-08-02T00:00:00.000Z',
  cwd: `D:/work/${id}`,
  firstMessage: '',
  id,
  messageCount: 0,
  persisted: true,
  sessionFile: `D:/sessions/${id}.jsonl`,
  updatedAt: '2026-08-02T00:00:00.000Z',
});

describe('Pi session navigation', () => {
  test('selects the most specific project containing a session cwd', () => {
    const projects = [
      project('root', 'D:/work'),
      project('nested', 'D:/work/packages/ui'),
      project('other', 'D:/other'),
    ];
    expect(findPiProjectForCwd(projects, 'd:\\WORK\\Packages\\UI\\src')?.id).toBe('nested');
    expect(findPiProjectForCwd(projects, 'D:/unrelated')).toBeNull();
  });

  test('resolves explicit and workspace creation targets while general chat uses home', () => {
    const projects = [project('one', 'D:/one'), project('two', 'D:/two')];
    expect(resolvePiSessionCreationCwd({ directory: 'D:/explicit', projectId: 'two' }, projects, 'one', 'D:/current')).toBe('D:/explicit');
    expect(resolvePiSessionCreationCwd({ projectId: 'two' }, projects, 'one', 'D:/current')).toBe('D:/two');
    expect(resolvePiSessionCreationCwd({}, projects, 'one', 'D:/current')).toBe('D:/one');
    expect(resolvePiSessionCreationCwd({}, projects, null, 'D:/current', 'D:/home')).toBe('D:/home');
    expect(resolvePiSessionCreationCwd({}, projects, null, 'D:/current')).toBe('D:/current');
    expect(resolvePiSessionCreationCwd({}, [], null, '')).toBeNull();
    expect(resolvePiSessionWorkspaceBinding({}, 'one')).toEqual({ id: 'one', kind: 'workspace' });
    expect(resolvePiSessionWorkspaceBinding({ projectId: null }, 'one')).toEqual({ kind: 'unbound' });
  });

  test('navigates the complete active catalog in both directions with wraparound', () => {
    const sessions = [session('newest'), session('middle'), session('oldest')];
    expect(resolveRelativePiSession(sessions, 'newest', 1)?.id).toBe('middle');
    expect(resolveRelativePiSession(sessions, 'newest', -1)?.id).toBe('oldest');
    expect(resolveRelativePiSession(sessions, 'oldest', 1)?.id).toBe('newest');
    expect(resolveRelativePiSession(sessions, 'missing', 1)?.id).toBe('newest');
    expect(resolveRelativePiSession(sessions, 'missing', -1)?.id).toBe('oldest');
    expect(resolveRelativePiSession([], null, 1)).toBeNull();
  });

  test('opens a pending draft without creating a persisted Pi session', async () => {
    const originalDirectory = useDirectoryStore.getState();
    const originalProjects = useProjectsStore.getState();
    const originalSessions = usePiSessionStore.getState();
    const originalUi = useUIStore.getState();
    let createCalls = 0;

    try {
      useDirectoryStore.setState({ currentDirectory: 'D:/previous' });
      useProjectsStore.setState({
        activeProjectId: 'draft-project',
        projects: [project('draft-project', 'D:/repo')],
      });
      usePiSessionStore.setState({
        createSession: async () => {
          createCalls += 1;
          throw new Error('session.create must not run while opening a draft');
        },
        currentSessionId: 'existing-session',
      });
      useUIStore.setState({ activeMainTab: 'files', isSessionSwitcherOpen: true });

      await startPiSessionDraftFromNavigation({
        directory: 'D:/repo/worktrees/feature',
        projectId: 'draft-project',
      });

      expect(createCalls).toBe(0);
      expect(usePiSessionStore.getState().currentSessionId).toBeNull();
      expect(useDirectoryStore.getState().currentDirectory).toBe('D:/repo/worktrees/feature');
      expect(useProjectsStore.getState().activeProjectId).toBe('draft-project');
      expect(useUIStore.getState().activeMainTab).toBe('chat');
      expect(useUIStore.getState().isSessionSwitcherOpen).toBe(false);
    } finally {
      useDirectoryStore.setState(originalDirectory, true);
      useProjectsStore.setState(originalProjects, true);
      usePiSessionStore.setState(originalSessions, true);
      useUIStore.setState(originalUi, true);
    }
  });

  test('opens general chat at home without retaining a workspace selection', async () => {
    const originalDirectory = useDirectoryStore.getState();
    const originalProjects = useProjectsStore.getState();
    const originalSessions = usePiSessionStore.getState();
    const originalUi = useUIStore.getState();

    try {
      useDirectoryStore.setState({ currentDirectory: 'D:/repo', homeDirectory: 'D:/home' });
      useProjectsStore.setState({
        activeProjectId: 'repo',
        projects: [project('repo', 'D:/repo')],
      });
      usePiSessionStore.setState({ currentSessionId: 'existing-session' });

      await startPiSessionDraftFromNavigation({ projectId: null });

      expect(useProjectsStore.getState().activeProjectId).toBeNull();
      expect(useDirectoryStore.getState().currentDirectory).toBe('D:/home');
      expect(usePiSessionStore.getState().currentSessionId).toBeNull();
    } finally {
      useDirectoryStore.setState(originalDirectory, true);
      useProjectsStore.setState(originalProjects, true);
      usePiSessionStore.setState(originalSessions, true);
      useUIStore.setState(originalUi, true);
    }
  });

  test('does not reattach a session when its explicit workspace no longer exists', async () => {
    const originalDirectory = useDirectoryStore.getState();
    const originalProjects = useProjectsStore.getState();
    const originalSessions = usePiSessionStore.getState();
    const originalUi = useUIStore.getState();
    const removedWorkspaceSession = session('removed-workspace');
    removedWorkspaceSession.cwd = 'D:/repo/src';
    removedWorkspaceSession.workspace = { id: 'removed', kind: 'workspace' };

    try {
      useDirectoryStore.setState({ currentDirectory: 'D:/repo' });
      useProjectsStore.setState({
        activeProjectId: 'repo',
        projects: [project('repo', 'D:/repo')],
      });
      usePiSessionStore.setState({
        currentSessionId: null,
        openSession: async () => ({
          activeTools: [],
          busy: false,
          cwd: removedWorkspaceSession.cwd,
          features: { pinnedContext: [], revision: 0, schemaVersion: 1 },
          followUp: [],
          followUpMode: 'one-at-a-time',
          isCompacting: false,
          isStreaming: false,
          leafId: null,
          pendingMessageCount: 0,
          retryAttempt: 0,
          sessionId: removedWorkspaceSession.id,
          steering: [],
          steeringMode: 'one-at-a-time',
          thinkingLevel: 'off',
          workspace: removedWorkspaceSession.workspace,
        }),
        summaries: [removedWorkspaceSession],
      });

      await openPiSessionFromNavigation({ sessionId: removedWorkspaceSession.id });

      expect(useProjectsStore.getState().activeProjectId).toBeNull();
      expect(useDirectoryStore.getState().currentDirectory).toBe('D:/repo/src');
    } finally {
      useDirectoryStore.setState(originalDirectory, true);
      useProjectsStore.setState(originalProjects, true);
      usePiSessionStore.setState(originalSessions, true);
      useUIStore.setState(originalUi, true);
    }
  });
});
