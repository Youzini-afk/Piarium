import { beforeEach, describe, expect, it, mock } from 'bun:test';

const gitService = {
  cloneRepository: mock(),
  stageGitFiles: mock(),
  unstageGitFiles: mock(),
  checkoutCommit: mock(),
  cherryPick: mock(),
  revertCommit: mock(),
  resetToCommit: mock(),
  createWorktree: mock(),
  getWorktreeBootstrapStatus: mock(),
};

mock.module('./gitService', () => gitService);
mock.module('vscode', () => ({
  workspace: {
    isTrusted: true,
    workspaceFolders: [{ uri: { fsPath: '/repo' } }],
  },
}));

const { handleStandardGitBridgeMessage } = await import('./bridge-git-runtime');

describe('bridge git runtime index mutations', () => {
  beforeEach(() => {
    gitService.cloneRepository.mockReset();
    gitService.stageGitFiles.mockReset();
    gitService.unstageGitFiles.mockReset();
    gitService.checkoutCommit.mockReset();
    gitService.cherryPick.mockReset();
    gitService.revertCommit.mockReset();
    gitService.resetToCommit.mockReset();
    gitService.createWorktree.mockReset();
    gitService.getWorktreeBootstrapStatus.mockReset();
  });

  it('clones repositories with the selected Git identity', async () => {
    gitService.cloneRepository.mockResolvedValue({ success: true, path: '/projects/demo' });
    const gitIdentity = {
      userName: 'Pi User',
      userEmail: 'pi@example.com',
      sshKey: '/home/pi/.ssh/id_ed25519',
    };

    const response = await handleStandardGitBridgeMessage({
      id: 'clone',
      type: 'api:git/clone',
      payload: {
        remoteUrl: 'git@example.com:team/demo.git',
        destinationPath: '/projects',
        gitIdentity,
      },
    });

    expect(response).toEqual({
      id: 'clone',
      type: 'api:git/clone',
      success: true,
      data: { success: true, path: '/projects/demo' },
    });
    expect(gitService.cloneRepository).toHaveBeenCalledWith({
      remoteUrl: 'git@example.com:team/demo.git',
      destinationPath: '/projects',
      gitIdentity,
    });
  });

  it('rejects incomplete clone requests before reaching git service', async () => {
    const missingUrl = await handleStandardGitBridgeMessage({
      id: 'clone-url',
      type: 'api:git/clone',
      payload: { destinationPath: '/projects' },
    });
    const missingDestination = await handleStandardGitBridgeMessage({
      id: 'clone-destination',
      type: 'api:git/clone',
      payload: { remoteUrl: 'https://example.com/demo.git' },
    });

    expect(missingUrl).toEqual({
      id: 'clone-url',
      type: 'api:git/clone',
      success: false,
      error: 'Repository URL is required',
    });
    expect(missingDestination).toEqual({
      id: 'clone-destination',
      type: 'api:git/clone',
      success: false,
      error: 'Destination path is required',
    });
    expect(gitService.cloneRepository).not.toHaveBeenCalled();
  });

  it('accepts legacy stage path payloads', async () => {
    const response = await handleStandardGitBridgeMessage({
      id: '1',
      type: 'api:git/stage',
      payload: { directory: '/repo', path: 'a.ts' },
    });

    expect(response).toEqual({ id: '1', type: 'api:git/stage', success: true, data: { success: true } });
    expect(gitService.stageGitFiles).toHaveBeenCalledWith('/repo', ['a.ts']);
  });

  it('accepts bulk stage paths payloads', async () => {
    const response = await handleStandardGitBridgeMessage({
      id: '1',
      type: 'api:git/stage',
      payload: { directory: '/repo', paths: ['a.ts', 'b.ts'] },
    });

    expect(response?.success).toBe(true);
    expect(gitService.stageGitFiles).toHaveBeenCalledWith('/repo', ['a.ts', 'b.ts']);
  });

  it('accepts legacy unstage path payloads', async () => {
    const response = await handleStandardGitBridgeMessage({
      id: '1',
      type: 'api:git/unstage',
      payload: { directory: '/repo', path: 'a.ts' },
    });

    expect(response).toEqual({ id: '1', type: 'api:git/unstage', success: true, data: { success: true } });
    expect(gitService.unstageGitFiles).toHaveBeenCalledWith('/repo', ['a.ts']);
  });

  it('accepts bulk unstage paths payloads', async () => {
    const response = await handleStandardGitBridgeMessage({
      id: '1',
      type: 'api:git/unstage',
      payload: { directory: '/repo', paths: ['a.ts', 'b.ts'] },
    });

    expect(response?.success).toBe(true);
    expect(gitService.unstageGitFiles).toHaveBeenCalledWith('/repo', ['a.ts', 'b.ts']);
  });

  it('rejects invalid path payloads', async () => {
    const response = await handleStandardGitBridgeMessage({
      id: '1',
      type: 'api:git/stage',
      payload: { directory: '/repo', paths: [' ', null] },
    });

    expect(response?.success).toBe(false);
    expect(gitService.stageGitFiles).not.toHaveBeenCalled();
  });

  it('rejects invalid commit hashes before commit actions reach git service', async () => {
    const checkoutResponse = await handleStandardGitBridgeMessage({
      id: '1',
      type: 'api:git/checkout-commit',
      payload: { directory: '/repo', hash: 'HEAD' },
    });
    const cherryPickResponse = await handleStandardGitBridgeMessage({
      id: '2',
      type: 'api:git/cherry-pick',
      payload: { directory: '/repo', hash: '--abort' },
    });
    const revertResponse = await handleStandardGitBridgeMessage({
      id: '3',
      type: 'api:git/revert-commit',
      payload: { directory: '/repo', hash: '--continue' },
    });
    const resetResponse = await handleStandardGitBridgeMessage({
      id: '4',
      type: 'api:git/reset-to-commit',
      payload: { directory: '/repo', hash: '--hard', mode: 'mixed' },
    });

    expect(checkoutResponse).toEqual({ id: '1', type: 'api:git/checkout-commit', success: false, error: 'Invalid commit hash' });
    expect(cherryPickResponse).toEqual({ id: '2', type: 'api:git/cherry-pick', success: false, error: 'Invalid commit hash' });
    expect(revertResponse).toEqual({ id: '3', type: 'api:git/revert-commit', success: false, error: 'Invalid commit hash' });
    expect(resetResponse).toEqual({ id: '4', type: 'api:git/reset-to-commit', success: false, error: 'Invalid commit hash' });
    expect(gitService.checkoutCommit).not.toHaveBeenCalled();
    expect(gitService.cherryPick).not.toHaveBeenCalled();
    expect(gitService.revertCommit).not.toHaveBeenCalled();
    expect(gitService.resetToCommit).not.toHaveBeenCalled();
  });

  it('preserves bootstrap phases in status responses', async () => {
    const bootstrapStatus = {
      status: 'pending',
      phase: 'git-ready',
      error: null,
      updatedAt: 123,
    };
    gitService.getWorktreeBootstrapStatus.mockResolvedValue(bootstrapStatus);

    const response = await handleStandardGitBridgeMessage({
      id: 'bootstrap-status',
      type: 'api:git/worktrees/bootstrap-status',
      payload: { directory: '/repo-worktree' },
    });

    expect(response).toEqual({
      id: 'bootstrap-status',
      type: 'api:git/worktrees/bootstrap-status',
      success: true,
      data: bootstrapStatus,
    });
    expect(gitService.getWorktreeBootstrapStatus).toHaveBeenCalledWith('/repo-worktree');
  });

  it('preserves the directory-created phase in fast create responses', async () => {
    const created = {
      head: '',
      name: 'feature',
      branch: 'piarium/feature',
      path: '/repo-worktree',
      directoryCreated: true,
      bootstrapStatus: {
        status: 'pending',
        phase: 'directory-created',
        error: null,
        updatedAt: 123,
      },
    };
    gitService.createWorktree.mockResolvedValue(created);
    const routeWriter = {
      markMutated: mock(async () => undefined),
      close: mock(async () => undefined),
    };
    const documents = {
      registerWriterForScope: mock(async () => routeWriter),
    };

    const response = await handleStandardGitBridgeMessage({
      id: 'create-worktree',
      type: 'api:git/worktrees',
      payload: {
        directory: '/repo',
        method: 'POST',
        worktreeName: 'feature',
        returnAfterDirectoryCreated: true,
      },
    }, { documents });

    expect(response).toEqual({
      id: 'create-worktree',
      type: 'api:git/worktrees',
      success: true,
      data: created,
    });
    expect(gitService.createWorktree).toHaveBeenCalledWith(
      '/repo',
      expect.objectContaining({ returnAfterDirectoryCreated: true }),
      {
        documents,
        owner: { kind: 'vscode-git', id: 'create-worktree:worktree-bootstrap' },
      },
    );
    expect(documents.registerWriterForScope).not.toHaveBeenCalled();
    expect(routeWriter.markMutated).not.toHaveBeenCalled();
    expect(routeWriter.close).not.toHaveBeenCalled();
  });
});
