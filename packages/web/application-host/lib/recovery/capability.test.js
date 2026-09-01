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
  it('validates JSON input across journal, checkpoint, combined, and storage primitives', async () => {
    harness = await createDocumentAuthorityHarness();
    await fs.promises.writeFile(`${harness.workspaceRoot}/note.txt`, 'content');
    const engine = createWorkspaceRecoveryEngine({
      authorityId: harness.authority.hostId,
      dataDir: harness.dataDir,
      documents: harness.authority,
      sessionNavigation: {},
    });
    const capability = createWorkspaceRecoveryCapabilityHandler(engine);
    const created = await capability('createCheckpoint', {
      name: 'Before refactor',
      workspaceId: harness.identity.workspaceId,
    });
    expect(created).toMatchObject({ status: 'ready', checkpoint: { source: 'named' } });
    const listed = await capability('listCheckpoints', { workspaceId: harness.identity.workspaceId });
    expect(listed.page.checkpoints).toHaveLength(1);
    const global = await capability('setDefaultStorageLocation', { mode: 'workspace-adjacent' });
    expect(global).toMatchObject({
      status: 'ready',
      storage: { location: { mode: 'workspace-adjacent' }, locationSource: 'global' },
    });
    expect(await capability('listStorageWorkspaces', {})).toMatchObject({
      status: 'ready',
      workspaces: [expect.objectContaining({ workspaceId: harness.identity.workspaceId })],
    });
    const inherited = await capability('clearStorageLocationOverride', {
      workspaceId: harness.identity.workspaceId,
    });
    expect(inherited).toMatchObject({ status: 'ready', operation: { state: 'complete' } });
    await expect(capability('createCheckpoint', { name: 'x', workspaceId: '' })).rejects.toThrow(/workspaceId/);
    await expect(capability('recordMutationBefore', {})).rejects.toThrow(/executionId/);
    await expect(capability('prepareCombinedRecovery', {})).rejects.toThrow(/entryId/);
  });
});
