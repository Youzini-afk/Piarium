import { describe, expect, it } from 'vitest';
import { createDocumentsCapabilityHandler } from './capability.js';
import { createDocumentAuthorityHarness } from './contract-fixtures.js';

describe('workspace.documents capability', () => {
  it('exposes resource-scoped reads and rejects watch streaming', async () => {
    const harness = await createDocumentAuthorityHarness();
    try {
      const call = createDocumentsCapabilityHandler(harness.authority);
      const identity = await call('resolveWorkspace', { path: harness.workspaceRoot });
      if (!identity || typeof identity !== 'object' || !('workspaceId' in identity)
        || typeof (identity as { workspaceId?: unknown }).workspaceId !== 'string') {
        throw new Error('Expected resolved workspace identity');
      }
      expect(identity.workspaceId).toBe(harness.identity.workspaceId);
      const missing = await call('read', harness.resource('missing.txt'));
      if (!missing || typeof missing !== 'object' || !('status' in missing)) {
        throw new Error('Expected document read result');
      }
      expect(missing.status).toBe('missing');
      await expect(call('watch', { workspaceId: identity.workspaceId })).rejects.toThrow(/does not implement watch/);
    } finally {
      await harness.cleanup();
    }
  });
});
