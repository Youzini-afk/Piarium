import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { handleDocumentsBridgeMessage } from './documents-bridge-runtime';

describe('VS Code documents bridge errors', () => {
  it('preserves an authority maintenance reason and status', async () => {
    const authorityError = Object.assign(new Error('Workspace is in maintenance mode'), {
      code: 'maintenance',
      statusCode: 409,
    });
    const documents: Parameters<typeof handleDocumentsBridgeMessage>[1]['documents'] = {
      resolveWorkspace: async () => ({}),
      read: async () => ({}),
      write: async () => { throw authorityError; },
      move: async () => ({}),
      delete: async () => ({}),
      watch: () => ({ close() {} }),
      registerDirtySurface: () => ({ close() {} }),
      acknowledgeDirtyStateBarrier: async () => ({ acknowledged: true }),
      listRecoveryJournals: async () => [],
      readRecoveryJournal: async () => ({}),
      writeRecoveryJournal: async () => ({}),
      deleteRecoveryJournal: async () => ({}),
      publishDirtyBuffers: async () => ({}),
      clearDirtyBuffers: async () => ({}),
    };

    const response = await handleDocumentsBridgeMessage(
      { id: 'request-1', type: 'api:documents:write', payload: {} },
      { documents },
    );

    assert.deepEqual(response, {
      id: 'request-1',
      type: 'api:documents:write',
      success: false,
      error: 'Workspace is in maintenance mode',
      reason: 'maintenance',
      status: 409,
    });
  });
});
