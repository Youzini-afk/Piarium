import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getRuntimeEndpointGeneration } from '@piarium/application-client';

const { runtimeFetchMock } = vi.hoisted(() => ({ runtimeFetchMock: vi.fn() }));

vi.mock('@piarium/application-client', async (importOriginal) => ({
  ...await importOriginal<typeof import('@piarium/application-client')>(),
  runtimeFetch: runtimeFetchMock,
}));

describe('createWebLanguageSupportAPI', () => {
  beforeEach(() => runtimeFetchMock.mockReset());

  it('posts getStatus to the host language-support route', async () => {
    runtimeFetchMock.mockResolvedValueOnce(Response.json({
      workspaceId: 'ws-1',
      languages: [],
      partial: false,
      scannedFiles: 0,
      fileLimit: 8000,
    }));
    const { createWebLanguageSupportAPI } = await import('./language-support');
    const status = await createWebLanguageSupportAPI().getStatus({ workspaceId: 'ws-1' });
    expect(status.workspaceId).toBe('ws-1');
    const [path] = runtimeFetchMock.mock.calls[0] as [string];
    expect(path).toBe('/api/language-support/status');
    expect(getRuntimeEndpointGeneration()).toEqual(expect.any(Number));
  });
});
