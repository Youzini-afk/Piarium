import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { createDocumentAuthorityHarness } from '../documents/contract-fixtures.js';
import { createWorkspaceRecoveryCapabilityHandler } from './capability.js';
import { createWorkspaceRecoveryEngine } from './engine.js';

let harness;

afterEach(async () => {
  await harness?.cleanup();
  harness = null;
});

describe('workspace.recovery-primitives Web Host capability', () => {
  it('validates JSON input and exposes Phase 1 only through the fixed capability', async () => {
    harness = await createDocumentAuthorityHarness();
    await fs.promises.writeFile(`${harness.workspaceRoot}/note.txt`, 'content');
    const engine = createWorkspaceRecoveryEngine({
      authorityId: harness.authority.hostId,
      dataDir: harness.dataDir,
      documents: harness.authority,
    });
    const capability = createWorkspaceRecoveryCapabilityHandler(engine);
    const captured = await capability('captureSnapshot', { workspaceId: harness.identity.workspaceId });
    expect(captured.status).toBe('captured');
    const listed = await capability('listSnapshots', { workspaceId: harness.identity.workspaceId });
    expect(listed.page.snapshots).toHaveLength(1);
    await expect(capability('captureSnapshot', { workspaceId: '' })).rejects.toThrow(/workspaceId/);
    await expect(capability('prepareRestore', {})).rejects.toThrow(/does not implement/);
  });
});
