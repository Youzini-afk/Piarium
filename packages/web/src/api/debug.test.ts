import { describe, expect, it, vi } from 'vitest';
import { RunServicesError } from '@piarium/ui/lib/api/run-errors';
import { getRuntimeEndpointGeneration, switchRuntimeEndpoint } from '@piarium/ui/lib/runtime-switch';

const runtimeFetchMock = vi.fn();

vi.mock('@piarium/ui/lib/runtime-fetch', () => ({
  runtimeFetch: runtimeFetchMock,
}));

describe('createWebWorkspaceDebugAPI', () => {
  it('rejects stale completions after an application-host endpoint switch', async () => {
    const { createWebWorkspaceDebugAPI } = await import('./debug');
    const api = createWebWorkspaceDebugAPI();
    let resolveResponse: ((value: Response) => void) | undefined;
    runtimeFetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => {
      resolveResponse = resolve;
    }));
    const pending = api.getStatus('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    switchRuntimeEndpoint({ apiBaseUrl: `https://debug-${getRuntimeEndpointGeneration()}.example` });
    resolveResponse?.(Response.json({ status: 'paused', workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }));
    await expect(pending).rejects.toBeInstanceOf(RunServicesError);
    await expect(pending).rejects.toMatchObject({ reason: 'stale-completion' });
  });
});
