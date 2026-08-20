import { describe, expect, it, vi } from 'vitest';
import { DocumentsError } from '@piarium/ui/lib/api/documents-errors';
import { getRuntimeEndpointGeneration, switchRuntimeEndpoint } from '@piarium/ui/lib/runtime-switch';

const runtimeFetchMock = vi.fn();

vi.mock('@piarium/ui/lib/runtime-fetch', () => ({
  runtimeFetch: runtimeFetchMock,
}));

describe('createWebDocumentsAPI', () => {
  it('resolves workspaces through the documents host route', async () => {
    const { createWebDocumentsAPI } = await import('./documents');
    const api = createWebDocumentsAPI();
    runtimeFetchMock.mockResolvedValueOnce(Response.json({
      workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      hostId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    }));
    await expect(api.resolveWorkspace({ path: '/repo' })).resolves.toEqual({
      workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      hostId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    });
    expect(runtimeFetchMock).toHaveBeenLastCalledWith('/api/documents/workspace/resolve', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '/repo' }),
    });
  });

  it('rejects stale completions after an application-host endpoint switch', async () => {
    const { createWebDocumentsAPI } = await import('./documents');
    const api = createWebDocumentsAPI();
    let resolveResponse: ((value: Response) => void) | undefined;
    runtimeFetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => {
      resolveResponse = resolve;
    }));
    const pending = api.read({
      workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      resourceId: 'note.txt',
    });
    switchRuntimeEndpoint({ apiBaseUrl: `https://documents-${getRuntimeEndpointGeneration()}.example` });
    resolveResponse?.(Response.json({ status: 'missing', resource: { workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', resourceId: 'note.txt' } }));
    await expect(pending).rejects.toBeInstanceOf(DocumentsError);
    await expect(pending).rejects.toMatchObject({ reason: 'stale-completion' });
  });

  it('opens document watches without putting credentials in the URL', async () => {
    const { createWebDocumentsAPI } = await import('./documents');
    const api = createWebDocumentsAPI();
    runtimeFetchMock.mockResolvedValueOnce(new Response(new ReadableStream(), {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    }));
    const subscription = api.watch('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', () => undefined);
    await vi.waitFor(() => expect(runtimeFetchMock).toHaveBeenCalled());
    expect(runtimeFetchMock).toHaveBeenLastCalledWith('/api/documents/watch', expect.objectContaining({
      headers: { Accept: 'text/event-stream' },
      query: { workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
    }));
    const query = runtimeFetchMock.mock.calls.at(-1)?.[1]?.query as { workspaceId?: string };
    expect(JSON.stringify(query)).not.toMatch(/token|bearer|password/i);
    subscription.close();
  });
});
