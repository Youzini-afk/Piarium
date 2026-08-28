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

  it('preserves maintenance failure reason and HTTP status from the host', async () => {
    const { createWebDocumentsAPI } = await import('./documents');
    const api = createWebDocumentsAPI();
    runtimeFetchMock.mockResolvedValueOnce(Response.json({
      error: 'Workspace is in maintenance mode',
      reason: 'maintenance',
    }, { status: 409 }));

    await expect(api.read({
      workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      resourceId: 'note.txt',
    })).rejects.toMatchObject({
      reason: 'maintenance',
      status: 409,
    });
  });

  it('publishes live dirty buffers through the document authority', async () => {
    const { createWebDocumentsAPI } = await import('./documents');
    const api = createWebDocumentsAPI();
    const request = {
      generation: 2,
      ownerId: 'surface-1',
      resources: [{
        baseRevision: null,
        localEditRevision: 3,
        resource: { workspaceId: 'workspace-1', resourceId: 'note.txt' },
      }],
      workspaceId: 'workspace-1',
    };
    runtimeFetchMock.mockResolvedValueOnce(Response.json({
      ...request,
      updatedAt: '2026-08-28T00:00:00.000Z',
    }));
    await expect(api.publishDirtyBuffers(request)).resolves.toMatchObject({ ownerId: 'surface-1' });
    expect(runtimeFetchMock).toHaveBeenLastCalledWith('/api/documents/dirty/publish', expect.objectContaining({
      body: JSON.stringify(request),
      method: 'POST',
    }));
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

  it('reconnects an ended watch and tells consumers to resynchronize', async () => {
    const { createWebDocumentsAPI } = await import('./documents');
    const api = createWebDocumentsAPI();
    runtimeFetchMock
      .mockResolvedValueOnce(new Response('', { status: 200, headers: { 'Content-Type': 'text/event-stream' } }))
      .mockResolvedValueOnce(new Response(new ReadableStream(), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }));
    const events: unknown[] = [];
    const subscription = api.watch('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', (event) => events.push(event));
    await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({
      kind: 'reset',
      sequence: 0,
      reason: 'reconnected',
    })), {
      timeout: 2_000,
    });
    subscription.close();
  });

  it('turns a same-generation sequence gap into a workspace reset', async () => {
    const { createWebDocumentsAPI } = await import('./documents');
    const api = createWebDocumentsAPI();
    const encoder = new TextEncoder();
    const workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    runtimeFetchMock.mockResolvedValueOnce(new Response(new ReadableStream({
      start(controller) {
        for (const sequence of [1, 3]) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({
            sourceId: 'source-1',
            generation: 1,
            sequence,
            kind: 'changed',
            resource: { workspaceId, resourceId: 'note.txt' },
          })}\n\n`));
        }
      },
    }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } }));
    const events: unknown[] = [];
    const subscription = api.watch(workspaceId, (event) => events.push(event));
    await vi.waitFor(() => expect(events).toContainEqual({
      sourceId: 'source-1',
      generation: 1,
      sequence: 3,
      kind: 'reset',
      reason: 'gap',
    }));
    subscription.close();
  });

  it('does not turn a malformed recovery response into an empty list', async () => {
    const { createWebDocumentsAPI } = await import('./documents');
    const api = createWebDocumentsAPI();
    runtimeFetchMock.mockResolvedValueOnce(Response.json({}));
    await expect(api.listRecoveryJournals({
      workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    })).rejects.toBeInstanceOf(DocumentsError);
  });
});
