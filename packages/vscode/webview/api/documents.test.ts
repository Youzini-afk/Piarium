import assert from 'node:assert/strict';
import { describe, it, mock } from 'bun:test';
import { DocumentsError } from '@piarium/application-client';

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

      // documents.ts imports './bridge' with the bare specifier, which would reuse a
      // bridge instance bound to an earlier fixture's window. Point that specifier at a
      // query-busted bridge that captured this test's window and acquireVsCodeApi.
      const bridge = await import(`./bridge?documents-${Date.now()}`);
      mock.module('./bridge', () => ({ sendBridgeMessage: bridge.sendBridgeMessage }));
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
      mock.restore();
      Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
      Object.defineProperty(globalThis, 'acquireVsCodeApi', { configurable: true, value: originalAcquire });
    }
  });
});
