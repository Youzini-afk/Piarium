import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DocumentsError } from '@piarium/ui/lib/api/documents-errors';

describe('VS Code documents API errors', () => {
  it('parses maintenance reason and status from the bridge response', async () => {
    const originalWindow = globalThis.window;
    const originalAcquire = (globalThis as typeof globalThis & { acquireVsCodeApi?: unknown }).acquireVsCodeApi;
    const messages: unknown[] = [];

    try {
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: new EventTarget(),
      });
      Object.defineProperty(globalThis, 'acquireVsCodeApi', {
        configurable: true,
        value: () => ({
          postMessage: (message: unknown) => messages.push(message),
          getState: () => undefined,
          setState: () => undefined,
        }),
      });

      const { createVSCodeDocumentsAPI } = await import(`./documents?maintenance-${Date.now()}`);
      const api = createVSCodeDocumentsAPI();
      const pending = api.read({
        workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        resourceId: 'note.txt',
      });
      const request = messages[0] as { id: string };
      globalThis.window.dispatchEvent(new MessageEvent('message', {
        data: {
          id: request.id,
          type: 'api:documents:read',
          success: false,
          error: 'Workspace is in maintenance mode',
          reason: 'maintenance',
          status: 409,
        },
      }));

      await assert.rejects(pending, (error: unknown) => {
        assert.ok(error instanceof DocumentsError);
        assert.equal(error.reason, 'maintenance');
        assert.equal(error.status, 409);
        return true;
      });
    } finally {
      Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
      Object.defineProperty(globalThis, 'acquireVsCodeApi', { configurable: true, value: originalAcquire });
    }
  });
});
