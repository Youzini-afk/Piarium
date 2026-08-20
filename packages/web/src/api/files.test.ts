import { describe, expect, it, vi } from 'vitest';

import type { RuntimeUrlQuery, RuntimeUrlResolver } from '@piarium/ui/lib/runtime-url';

const runtimeFetchMock = vi.fn();

vi.mock('@piarium/ui/lib/runtime-fetch', () => ({
  runtimeFetch: runtimeFetchMock,
}));

const toUrl = (path: string, query?: RuntimeUrlQuery): string => {
  const params = query instanceof URLSearchParams ? query : new URLSearchParams();
  const queryString = params.toString();
  return queryString ? `${path}?${queryString}` : path;
};

const urls: RuntimeUrlResolver = {
  api: toUrl,
  authenticatedAsset: toUrl,
  auth: toUrl,
  health: (query?: RuntimeUrlQuery) => toUrl('/health', query),
  rawFile: (path: string) => toUrl('/api/fs/raw', new URLSearchParams({ path })),
  sse: toUrl,
  websocket: toUrl,
};

describe('createWebFilesAPI', () => {
  it('resolves the active runtime home directory', async () => {
    const { createWebFilesAPI } = await import('./files');
    const api = createWebFilesAPI({ urls, getDirectory: () => '/current-workspace' });

    runtimeFetchMock.mockResolvedValueOnce(Response.json({ home: 'C:\\Users\\Pi' }));

    await expect(api.getHomeDirectory()).resolves.toBe('C:/Users/Pi');
    expect(runtimeFetchMock).toHaveBeenLastCalledWith('/api/fs/home', {
      headers: { Accept: 'application/json' },
    });
  });

  it('lists directories through the Piarium files endpoint', async () => {
    const { createWebFilesAPI } = await import('./files');
    const api = createWebFilesAPI({ urls, getDirectory: () => '/current-workspace' });

    runtimeFetchMock.mockResolvedValueOnce(Response.json({
      path: '/current-workspace',
      entries: [
        { name: 'src', path: '/current-workspace/src', isDirectory: true },
        { name: 'README.md', path: '/current-workspace/README.md', isDirectory: false },
      ],
    }));

    await expect(api.listDirectory('/current-workspace', { respectGitignore: true })).resolves.toEqual({
      directory: '/current-workspace',
      entries: [
        { name: 'src', path: '/current-workspace/src', isDirectory: true },
        { name: 'README.md', path: '/current-workspace/README.md', isDirectory: false },
      ],
    });
    expect(runtimeFetchMock).toHaveBeenLastCalledWith('/api/fs/list', {
      query: new URLSearchParams({ path: '/current-workspace', respectGitignore: 'true' }),
      headers: { 'x-piarium-directory': '/current-workspace' },
    });
  });

  it('preserves directory permission failures for native recovery', async () => {
    const { createWebFilesAPI } = await import('./files');
    const api = createWebFilesAPI({ urls, getDirectory: () => '/current-workspace' });

    runtimeFetchMock.mockResolvedValueOnce(Response.json(
      { error: 'Access to directory denied', reason: 'os-permission' },
      { status: 403 },
    ));

    await expect(api.listDirectory('/restricted')).rejects.toMatchObject({
      name: 'FilesystemError',
      reason: 'os-permission',
      status: 403,
    });
  });

  it('opts into outside-workspace directory creation for project onboarding', async () => {
    const { createWebFilesAPI } = await import('./files');
    const api = createWebFilesAPI({ urls, getDirectory: () => '/current-workspace' });

    runtimeFetchMock.mockResolvedValueOnce(Response.json({ success: true, path: '/projects/new-app' }));

    await expect(api.createDirectory('/projects/new-app', { allowOutsideWorkspace: true })).resolves.toEqual({
      success: true,
      path: '/projects/new-app',
    });
    expect(runtimeFetchMock).toHaveBeenLastCalledWith('/api/fs/mkdir', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-piarium-directory': '/current-workspace',
      },
      body: JSON.stringify({ path: '/projects/new-app', allowOutsideWorkspace: true }),
    });
  });

  it('uses per-call workspace directory for stat requests', async () => {
    const { createWebFilesAPI } = await import('./files');
    const api = createWebFilesAPI({ urls, getDirectory: () => '/stale-workspace' });

    runtimeFetchMock.mockResolvedValueOnce(Response.json({ path: '/worktree-b/file.txt', isFile: true, size: 12 }));
    await api.statFile?.('/worktree-b/file.txt', { directory: '/worktree-a' });

    expect(runtimeFetchMock).toHaveBeenLastCalledWith('/api/fs/stat', {
      query: new URLSearchParams({ path: '/worktree-b/file.txt' }),
      headers: { 'x-piarium-directory': '/worktree-a' },
    });
  });

  it('sends the workspace directory header for downloads', async () => {
    const { createWebFilesAPI } = await import('./files');
    const api = createWebFilesAPI({ urls, getDirectory: () => '/current-workspace' });

    runtimeFetchMock.mockResolvedValueOnce(new Response('', { status: 500 }));
    await expect(api.downloadFile?.('/current-workspace/file.txt')).rejects.toThrow('Download failed');

    expect(runtimeFetchMock).toHaveBeenLastCalledWith('/api/fs/raw', {
      query: { path: '/current-workspace/file.txt', download: true },
      headers: { 'x-piarium-directory': '/current-workspace' },
    });
  });
});
