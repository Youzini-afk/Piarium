import { beforeEach, describe, expect, mock, test } from 'bun:test';

const worktreeCreateCalls: Array<{
  args: Record<string, unknown>;
  options: unknown;
  project: { id?: string; path: string };
}> = [];
const worktreeBootstrapWaitCalls: string[] = [];
const operationOrder: string[] = [];
const createdSessions: Array<{ cwd: string; name?: string; sessionId: string }> = [];
const selectedModels: Array<{ id: string; model: { id: string; provider: string } }> = [];
const selectedThinking: Array<{ id: string; level: string }> = [];
const prompts: Array<{ id: string; images?: unknown[]; instructions?: string; text: string }> = [];
const deletedSessions: string[] = [];
let currentSessionId: string | null = null;
let isGitRepository = false;
let waitForWorktreeSetup = false;
let sessionCounter = 0;

const createWorktreeWithDefaultsMock = mock((
  project: { id?: string; path: string },
  args: Record<string, unknown>,
  options: unknown,
) => {
  worktreeCreateCalls.push({ args, options, project });
  return Promise.resolve({
    branch: String(args.branchName ?? 'branch'),
    headState: 'branch',
    kind: 'standard',
    label: String(args.worktreeName ?? 'worktree'),
    name: String(args.worktreeName ?? 'worktree'),
    path: `/repo-worktrees/${String(args.worktreeName ?? 'worktree')}`,
    projectDirectory: '/repo',
    source: 'sdk',
    worktreeRoot: '/repo-worktrees',
    worktreeSource: 'created-for-session',
    worktreeStatus: 'pending',
  });
});

const piSessionState = {
  createSession: async (cwd: string, name?: string) => {
    const sessionId = `ses_${++sessionCounter}`;
    operationOrder.push(`createSession:${cwd}`);
    createdSessions.push({ cwd, name, sessionId });
    return { sessionId };
  },
  deleteSession: async (sessionId: string) => {
    deletedSessions.push(sessionId);
    return true;
  },
  prompt: async (id: string, text: string, images?: unknown[], instructions?: string) => {
    prompts.push({ id, text, ...(images === undefined ? {} : { images }), ...(instructions === undefined ? {} : { instructions }) });
    return true;
  },
  selectModel: async (id: string, model: { id: string; provider: string }) => {
    selectedModels.push({ id, model });
    return { sessionId: id };
  },
  selectThinking: async (id: string, level: string) => {
    selectedThinking.push({ id, level });
    return { sessionId: id };
  },
  setCurrentSession: (id: string | null) => { currentSessionId = id; },
};

mock.module('./usePiSessionStore', () => ({
  usePiSessionStore: { getState: () => piSessionState },
}));

mock.module('@/lib/gitApi', () => ({
  checkIsGitRepository: mock(() => Promise.resolve(isGitRepository)),
}));

mock.module('@/lib/worktrees/worktreeCreate', () => ({
  createWorktreeWithDefaults: createWorktreeWithDefaultsMock,
  resolveRootTrackingRemote: mock(() => Promise.resolve(null)),
}));

mock.module('@/lib/worktrees/worktreeManager', () => ({
  removeProjectWorktree: mock(() => Promise.resolve()),
}));

mock.module('@/lib/worktrees/worktreeBootstrap', () => ({
  waitForWorktreeBootstrap: (directory: string) => {
    worktreeBootstrapWaitCalls.push(directory);
    operationOrder.push(`wait:${directory}`);
    return Promise.resolve();
  },
}));

mock.module('@/lib/openchamberConfig', () => ({
  getWorktreeSetupWaitEnabled: mock(() => Promise.resolve(waitForWorktreeSetup)),
  saveWorktreeSetupCommands: mock(() => Promise.resolve()),
}));

mock.module('./useDirectoryStore', () => ({
  useDirectoryStore: { getState: () => ({ currentDirectory: '/repo' }) },
}));

mock.module('./useProjectsStore', () => ({
  useProjectsStore: {
    getState: () => ({
      activeProjectId: 'project-1',
      projects: [{ id: 'project-1', path: '/repo' }],
    }),
  },
}));

mock.module('./useSnippetsStore', () => ({
  useSnippetsStore: {
    getState: () => ({ expandText: (value: string) => Promise.resolve(value) }),
  },
}));

const { useMultiRunStore } = await import('./useMultiRunStore');

describe('useMultiRunStore', () => {
  beforeEach(() => {
    worktreeCreateCalls.length = 0;
    worktreeBootstrapWaitCalls.length = 0;
    operationOrder.length = 0;
    createdSessions.length = 0;
    selectedModels.length = 0;
    selectedThinking.length = 0;
    prompts.length = 0;
    deletedSessions.length = 0;
    currentSessionId = null;
    isGitRepository = false;
    waitForWorktreeSetup = false;
    sessionCounter = 0;
    useMultiRunStore.setState({ error: null, isLoading: false });
  });

  test('creates and starts Pi sessions with the selected model and thinking level', async () => {
    const result = await useMultiRunStore.getState().createMultiRun({
      groups: [{
        models: [{ providerID: 'anthropic', modelID: 'claude-sonnet', variant: 'high' }],
        prompt: 'Fix it',
      }],
      isolateRuns: false,
      name: 'Fix thing',
    });

    expect(result).toEqual({
      failures: [],
      firstSessionId: 'ses_1',
      groupSlug: 'fix-thing',
      sessionIds: ['ses_1'],
    });
    expect(selectedModels).toEqual([{ id: 'ses_1', model: { id: 'claude-sonnet', provider: 'anthropic' } }]);
    expect(selectedThinking).toEqual([{ id: 'ses_1', level: 'high' }]);
    expect(prompts).toEqual([{ id: 'ses_1', text: 'Fix it' }]);
    expect(currentSessionId).toBe('ses_1');
  });

  test('uses fast worktree creation and optionally waits for setup', async () => {
    isGitRepository = true;
    waitForWorktreeSetup = true;

    const result = await useMultiRunStore.getState().createMultiRun({
      groups: [{ prompt: 'Fix it', models: [{ providerID: 'anthropic', modelID: 'claude-sonnet' }] }],
      isolateRuns: true,
      name: 'Fix thing',
    });

    expect(result?.sessionIds).toEqual(['ses_1']);
    expect(worktreeCreateCalls).toHaveLength(1);
    expect(worktreeCreateCalls[0]?.args.returnAfterDirectoryCreated).toBe(true);
    expect(worktreeCreateCalls[0]?.options).toEqual({ resolvedRootTrackingRemote: null });
    expect(worktreeBootstrapWaitCalls).toEqual(['/repo-worktrees/fix-thing/anthropic-claude-sonnet']);
    expect(operationOrder).toEqual([
      'wait:/repo-worktrees/fix-thing/anthropic-claude-sonnet',
      'createSession:/repo-worktrees/fix-thing/anthropic-claude-sonnet',
    ]);
  });

  test('does not impose an arbitrary model-count cap', async () => {
    const models = Array.from({ length: 8 }, (_, index) => ({
      modelID: `model-${index + 1}`,
      providerID: 'test',
    }));
    const result = await useMultiRunStore.getState().createMultiRun({
      groups: [{ models, prompt: 'Run it' }],
      isolateRuns: false,
      name: 'Many runs',
    });

    expect(result?.sessionIds).toHaveLength(8);
    expect(prompts).toHaveLength(8);
    expect(useMultiRunStore.getState().error).toBeNull();
  });

  test('uses the invocation contract supplied by the owning Pi plugin', async () => {
    await useMultiRunStore.getState().createMultiRun({
      agent: {
        id: 'pi-subagents:delegatable:worker',
        invocation: { command: 'run', kind: 'slash-command', taskSeparator: 'space' },
        name: 'worker',
        providerId: 'pi-subagents',
      },
      groups: [{ prompt: 'Fix it', models: [{ providerID: 'test', modelID: 'model' }] }],
      isolateRuns: false,
      name: 'Delegated',
    });

    expect(prompts[0]?.text).toBe('/run worker Fix it');

    await useMultiRunStore.getState().createMultiRun({
      agent: {
        id: 'pi-subagents:workflow:verify',
        invocation: { command: 'run-chain', kind: 'slash-command', taskSeparator: 'double-dash' },
        name: 'verify',
        providerId: 'pi-subagents',
      },
      groups: [{ prompt: 'Audit it', models: [{ providerID: 'test', modelID: 'model' }] }],
      isolateRuns: false,
      name: 'Workflow',
    });

    expect(prompts[1]?.text).toBe('/run-chain verify -- Audit it');
  });

  test('passes images natively and text files as hidden Pi instructions', async () => {
    await useMultiRunStore.getState().createMultiRun({
      files: [
        { filename: 'shot.png', mime: 'image/png', url: 'data:image/png;base64,aW1hZ2U=' },
        { filename: 'notes.txt', mime: 'text/plain', url: 'data:text/plain;base64,aGVsbG8=' },
      ],
      groups: [{ prompt: 'Inspect', models: [{ providerID: 'test', modelID: 'model' }] }],
      isolateRuns: false,
      name: 'Attachments',
    });

    expect(prompts[0]?.images).toEqual([{ data: 'aW1hZ2U=', mimeType: 'image/png' }]);
    expect(prompts[0]?.instructions).toContain('<attachment name="notes.txt"');
    expect(prompts[0]?.instructions).toContain('hello');
  });
});
