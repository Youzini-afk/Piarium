import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { SessionSummary } from '@piarium/protocol';
import type { GitWorktreeInfo, RemoveGitWorktreePayload, RuntimeAPIs } from '@/lib/api/types';
import { registerRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { useDirectoryStore } from './useDirectoryStore';
import { usePiSessionStore } from './usePiSessionStore';
import { useProjectsStore } from './useProjectsStore';

const summariesByDirectory = new Map<string, SessionSummary[]>();
const deletedSessionIds: string[] = [];
const removedWorktreePaths: string[] = [];
let worktrees: GitWorktreeInfo[] = [];

mock.module('@/lib/pi-runtime/sessions', () => ({
  listPiSessions: (cwd: string) => Promise.resolve(summariesByDirectory.get(cwd) ?? []),
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
    registerRuntimeAPIs({
      git: {
        listGitWorktrees: async () => worktrees,
        worktree: {
          list: async () => worktrees,
          remove: async (_directory: string, payload: RemoveGitWorktreePayload) => {
            removedWorktreePaths.push(payload.directory);
            return { success: true };
          },
        },
      },
    } as unknown as RuntimeAPIs);
    useDirectoryStore.setState({ currentDirectory: '/repo' });
    useProjectsStore.setState({
      activeProjectId: 'project-1',
      projects: [{ id: 'project-1', path: '/repo' }],
    });
    usePiSessionStore.setState({
      deleteSession: async (sessionId: string) => {
        deletedSessionIds.push(sessionId);
        for (const [directory, entries] of summariesByDirectory) {
          summariesByDirectory.set(directory, entries.filter((entry) => entry.id !== sessionId));
        }
        return true;
      },
    });
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
      head: 'abc123',
      name: 'test-model',
      path: '/repo-worktrees/test-model',
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

afterAll(() => registerRuntimeAPIs(null));
