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
  it('validates JSON input across capture, restore, and combined recovery primitives', async () => {
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
    const global = await capability('setDefaultStorageLocation', { mode: 'workspace-adjacent' });
    expect(global).toMatchObject({
      status: 'ready',
      storage: { location: { mode: 'workspace-adjacent' }, locationSource: 'global' },
    });
    const inherited = await capability('clearStorageLocationOverride', {
      workspaceId: harness.identity.workspaceId,
    });
    expect(inherited).toMatchObject({ status: 'ready', operation: { state: 'complete' } });
    await expect(capability('captureSnapshot', { workspaceId: '' })).rejects.toThrow(/workspaceId/);
    await expect(capability('prepareRestore', {})).rejects.toThrow(/targetSnapshotId/);
    await expect(capability('prepareCombinedRecovery', {})).rejects.toThrow(/entryId/);
  });
});
