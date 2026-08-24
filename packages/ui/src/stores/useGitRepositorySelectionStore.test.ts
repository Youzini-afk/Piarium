import { beforeEach, describe, expect, test } from 'vitest';
import { useGitRepositorySelectionStore } from './useGitRepositorySelectionStore';

describe('useGitRepositorySelectionStore', () => {
  beforeEach(() => {
    useGitRepositorySelectionStore.setState({ repositoryByWorkspace: {} });
  });

  test('keeps repository choices isolated by workspace identity', () => {
    const store = useGitRepositorySelectionStore.getState();
    store.setRepository('workspace-a', '/workspaces/a/packages/app');
    store.setRepository('workspace-b', '/workspaces/b');

    expect(useGitRepositorySelectionStore.getState().repositoryByWorkspace).toEqual({
      'workspace-a': '/workspaces/a/packages/app',
      'workspace-b': '/workspaces/b',
    });
  });

  test('clears only the selected workspace', () => {
    useGitRepositorySelectionStore.setState({
      repositoryByWorkspace: {
        'workspace-a': '/workspaces/a',
        'workspace-b': '/workspaces/b',
      },
    });

    useGitRepositorySelectionStore.getState().setRepository('workspace-a', null);

    expect(useGitRepositorySelectionStore.getState().repositoryByWorkspace).toEqual({
      'workspace-b': '/workspaces/b',
    });
  });
});
