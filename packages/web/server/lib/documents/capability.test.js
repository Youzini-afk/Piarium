import { describe, expect, it } from 'vitest';
import { createDocumentsCapabilityHandler } from './capability.js';
import { createDocumentAuthorityHarness } from './contract-fixtures.js';

describe('workspace.documents capability', () => {
  it('exposes resource-scoped reads and rejects watch streaming', async () => {
    const harness = await createDocumentAuthorityHarness();
    try {
      const call = createDocumentsCapabilityHandler(harness.authority);
      const identity = await call('resolveWorkspace', { path: harness.workspaceRoot });
      expect(identity.workspaceId).toBe(harness.identity.workspaceId);
      const missing = await call('read', harness.resource('missing.txt'));
      expect(missing.status).toBe('missing');
      await expect(call('watch', { workspaceId: identity.workspaceId })).rejects.toThrow(/does not implement watch/);
    } finally {
      await harness.cleanup();
    }
  });
});
