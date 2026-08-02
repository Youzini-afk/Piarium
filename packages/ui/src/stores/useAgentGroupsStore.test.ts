import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { SessionSummary } from '@piarium/protocol';

const summariesByDirectory = new Map<string, SessionSummary[]>();
const deletedSessionIds: string[] = [];
const removedWorktreePaths: string[] = [];
let worktrees: Array<Record<string, unknown>> = [];

mock.module('@/lib/pi-runtime/sessions', () => ({
  listPiSessions: (cwd: string) => Promise.resolve(summariesByDirectory.get(cwd) ?? []),
}));

mock.module('@/lib/worktrees/worktreeManager', () => ({
  listProjectWorktrees: () => Promise.resolve(worktrees),
  removeProjectWorktree: (_project: unknown, metadata: { path: string }) => {
    removedWorktreePaths.push(metadata.path);
    return Promise.resolve();
  },
}));

mock.module('./useDirectoryStore', () => ({
  useDirectoryStore: {
    getState: () => ({
      currentDirectory: '/repo',
      setDirectory: mock(() => undefined),
    }),
  },
}));

mock.module('./useProjectsStore', () => ({
  useProjectsStore: {
    getState: () => ({
      activeProjectId: 'project-1',
      projects: [{ id: 'project-1', path: '/repo' }],
    }),
  },
}));

mock.module('./usePiSessionStore', () => ({
  usePiSessionStore: {
    getState: () => ({
      deleteSession: async (sessionId: string) => {
        deletedSessionIds.push(sessionId);
        for (const [directory, entries] of summariesByDirectory) {
          summariesByDirectory.set(directory, entries.filter((entry) => entry.id !== sessionId));
        }
        return true;
      },
    }),
  },
}));

const { buildAgentGroups, useAgentGroupsStore } = await import('./useAgentGroupsStore');

const summary = (overrides: Partial<SessionSummary> & Pick<SessionSummary, 'cwd' | 'id' | 'name'>): SessionSummary => ({
  allMessagesText: '',
  createdAt: '2026-08-02T10:00:00.000Z',
  firstMessage: '',
  messageCount: 1,
  persisted: true,
  sessionFile: `/sessions/${overrides.id}.jsonl`,
  updatedAt: '2026-08-02T10:01:00.000Z',
  ...overrides,
});

describe('useAgentGroupsStore', () => {
  beforeEach(() => {
    summariesByDirectory.clear();
    deletedSessionIds.length = 0;
    removedWorktreePaths.length = 0;
    worktrees = [];
    useAgentGroupsStore.setState({
      error: null,
      groups: [],
      isLoading: false,
      selectedGroupName: null,
      selectedSessionId: null,
    });
  });

  test('loads Pi session summaries from the project root and all worktrees', async () => {
    worktrees = [{
      branch: 'agent-group/test-model',
      label: 'test-model',
      path: '/repo-worktrees/test-model',
      projectDirectory: '/repo',
    }];
    summariesByDirectory.set('/repo', [summary({
      cwd: '/repo',
      id: 'root-session',
      name: '直接运行/test/model',
    })]);
    summariesByDirectory.set('/repo-worktrees/test-model', [summary({
      cwd: '/repo-worktrees/test-model',
      id: 'worktree-session',
      name: 'agent-group/test/model',
      updatedAt: '2026-08-02T11:00:00.000Z',
    })]);

    await useAgentGroupsStore.getState().loadGroups();

    expect(useAgentGroupsStore.getState().groups.map((group) => group.name)).toEqual([
      '直接运行',
      'agent-group',
    ]);
    expect(useAgentGroupsStore.getState().groups[1]?.sessions[0]?.worktreeMetadata?.path)
      .toBe('/repo-worktrees/test-model');
  });

  test('never attempts to remove the primary project worktree', async () => {
    const session = {
      branch: '',
      displayLabel: 'test/model',
      id: 'root-session',
      instanceNumber: 1,
      modelId: 'model',
      path: '/repo',
      providerId: 'test',
    };
    summariesByDirectory.set('/repo', [summary({ cwd: '/repo', id: session.id, name: 'group/test/model' })]);

    const result = await useAgentGroupsStore.getState().deleteGroupSessions([session], {
      removeWorktrees: true,
    });

    expect(result).toEqual({ failedIds: [], failedWorktreePaths: [] });
    expect(deletedSessionIds).toEqual(['root-session']);
    expect(removedWorktreePaths).toEqual([]);
  });

  test('ignores fusion sessions when building groups', () => {
    const groups = buildAgentGroups([
      summary({ cwd: '/repo', id: 'run', name: 'group/test/model' }),
      summary({ cwd: '/repo', id: 'fusion', name: 'group/test/model/fusion' }),
    ], new Map());
    expect(groups).toHaveLength(1);
    expect(groups[0]?.sessions.map((session) => session.id)).toEqual(['run']);
  });
});
