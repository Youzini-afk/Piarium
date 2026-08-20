import { describe, expect, test } from 'bun:test';
import { resourceIdFromWorkspacePath, workspacePathFromResourceId, documentIdentityForPath } from './path';

describe('document resource paths', () => {
  test('maps workspace-relative posix paths', () => {
    expect(resourceIdFromWorkspacePath('/repo', '/repo/src/note.txt')).toBe('src/note.txt');
    expect(workspacePathFromResourceId('/repo', 'src/note.txt')).toBe('/repo/src/note.txt');
  });

  test('rejects paths outside the workspace', () => {
    expect(resourceIdFromWorkspacePath('/repo', '/other/note.txt')).toBeNull();
  });

  test('builds a document identity only for in-workspace paths', () => {
    expect(documentIdentityForPath('ws-1', '/repo', '/repo/src/note.txt')).toEqual({
      workspaceId: 'ws-1',
      resourceId: 'src/note.txt',
    });
    expect(documentIdentityForPath('ws-1', '/repo', '/other/note.txt')).toBeUndefined();
    expect(documentIdentityForPath(undefined, '/repo', '/repo/src/note.txt')).toBeUndefined();
  });
});
