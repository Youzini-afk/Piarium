import { describe, expect, it, vi } from 'vitest';
import { WorkspaceSearchError } from '@piarium/ui/lib/api/search-errors';
import { getRuntimeEndpointGeneration, switchRuntimeEndpoint } from '@piarium/ui/lib/runtime-switch';

const runtimeFetchMock = vi.fn();

vi.mock('@piarium/ui/lib/runtime-fetch', () => ({
  runtimeFetch: runtimeFetchMock,
}));

describe('createWebWorkspaceSearchAPI', () => {
  it('returns a discriminated failure instead of empty hits', async () => {
    const { createWebWorkspaceSearchAPI } = await import('./workspace-search');
    const api = createWebWorkspaceSearchAPI();
    runtimeFetchMock.mockResolvedValueOnce(Response.json({
      status: 'failure',
      generation: 1,
      message: 'ripgrep is unavailable',
    }));
    await expect(api.searchContent({ workspaceId: 'ws', query: 'todo' })).resolves.toEqual({
      status: 'failure',
      generation: 1,
      message: 'ripgrep is unavailable',
    });
  });

  it('rejects stale completions after an application-host endpoint switch', async () => {
    const { createWebWorkspaceSearchAPI } = await import('./workspace-search');
    const api = createWebWorkspaceSearchAPI();
    let resolveResponse: ((value: Response) => void) | undefined;
    runtimeFetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => {
      resolveResponse = resolve;
    }));
    const pending = api.searchContent({ workspaceId: 'ws', query: 'todo' });
    switchRuntimeEndpoint({ apiBaseUrl: `https://search-${getRuntimeEndpointGeneration()}.example` });
    resolveResponse?.(Response.json({ status: 'empty', generation: 0 }));
    await expect(pending).rejects.toBeInstanceOf(WorkspaceSearchError);
    await expect(pending).rejects.toMatchObject({ reason: 'stale-completion' });
  });

  it('treats abort as cancelled rather than empty', async () => {
    const { createWebWorkspaceSearchAPI } = await import('./workspace-search');
    const api = createWebWorkspaceSearchAPI();
    const controller = new AbortController();
    runtimeFetchMock.mockImplementationOnce(() => {
      controller.abort();
      const error = new Error('aborted');
      error.name = 'AbortError';
      return Promise.reject(error);
    });
    await expect(api.searchContent({ workspaceId: 'ws', query: 'todo' }, { signal: controller.signal })).resolves.toEqual({
      status: 'cancelled',
      generation: getRuntimeEndpointGeneration(),
    });
  });
});
