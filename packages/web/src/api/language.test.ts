import { describe, expect, it, vi } from 'vitest';
import { LanguageServicesError } from '@piarium/ui/lib/api/language-errors';
import { getRuntimeEndpointGeneration, switchRuntimeEndpoint } from '@piarium/ui/lib/runtime-switch';

const runtimeFetchMock = vi.fn();

vi.mock('@piarium/ui/lib/runtime-fetch', () => ({
  runtimeFetch: runtimeFetchMock,
}));

describe('createWebLanguageServicesAPI', () => {
  it('rejects stale completions after an application-host endpoint switch', async () => {
    const { createWebLanguageServicesAPI } = await import('./language');
    const api = createWebLanguageServicesAPI();
    let resolveResponse: ((value: Response) => void) | undefined;
    runtimeFetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => {
      resolveResponse = resolve;
    }));
    const pending = api.hover({
      resource: { workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', resourceId: 'note.ts' },
      languageId: 'typescript',
      documentVersion: 1,
      position: { line: 0, character: 0 },
    });
    switchRuntimeEndpoint({ apiBaseUrl: `https://language-${getRuntimeEndpointGeneration()}.example` });
    resolveResponse?.(Response.json({ status: 'ready', documentVersion: 1, value: 'hover' }));
    await expect(pending).rejects.toBeInstanceOf(LanguageServicesError);
    await expect(pending).rejects.toMatchObject({ reason: 'stale-completion' });
  });
});
