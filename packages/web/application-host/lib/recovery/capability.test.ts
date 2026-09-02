import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { parseWorkspaceRecoveryCheckpointListResult } from '@piarium/extension-contract';
import type { HostCapabilityCallContext } from '@piarium/extension-host';
import {
  createDocumentAuthorityHarness,
  type DocumentAuthorityHarness,
} from '../documents/contract-fixtures.js';
import { createWorkspaceRecoveryCapabilityHandler } from './capability.js';
import {
  createWorkspaceRecoveryEngine,
  type RecoverySessionNavigation,
} from './engine.js';

let harness: DocumentAuthorityHarness | undefined;

const context: HostCapabilityCallContext = {
  owner: {
    entrypointId: 'builtin-recovery',
    extensionId: 'piarium.builtin.recovery',
    extensionVersion: '0.3.0',
    generation: 1,
  },
  signal: new AbortController().signal,
};

const navigation: RecoverySessionNavigation = {
  commit: async () => ({}),
  commitLeaf: async () => ({}),
  prepare: async (input) => ({
    expectedLeafId: input.entryId,
    removedEntryIds: [],
    targetLeafId: input.entryId,
  }),
  prepareLeaf: async (input) => ({
    expectedLeafId: input.targetLeafId,
    removedEntryIds: [],
    targetLeafId: input.targetLeafId,
  }),
};

afterEach(async () => {
  await harness?.cleanup();
  harness = undefined;
});

describe('workspace.recovery-primitives Web Host capability', () => {
  it('validates JSON input across journal, checkpoint, combined, and storage primitives', async () => {
    harness = await createDocumentAuthorityHarness();
    await fs.promises.writeFile(`${harness.workspaceRoot}/note.txt`, 'content');
    const engine = createWorkspaceRecoveryEngine({
      authorityId: harness.authority.hostId,
      dataDir: harness.dataDir,
      documents: harness.authority,
      sessionNavigation: navigation,
    });
    const capability = createWorkspaceRecoveryCapabilityHandler(engine);
    const created = await capability('createCheckpoint', {
      name: 'Before refactor',
      workspaceId: harness.identity.workspaceId,
    }, context);
    expect(created).toMatchObject({ status: 'ready', checkpoint: { source: 'named' } });
    const listed = parseWorkspaceRecoveryCheckpointListResult(await capability(
      'listCheckpoints',
      { workspaceId: harness.identity.workspaceId },
      context,
    ));
    expect(listed.status).toBe('ready');
    if (listed.status !== 'ready') throw new Error('Expected checkpoint list');
    expect(listed.page.checkpoints).toHaveLength(1);
    const global = await capability('setDefaultStorageLocation', { mode: 'workspace-adjacent' }, context);
    expect(global).toMatchObject({
      status: 'ready',
      storage: { location: { mode: 'workspace-adjacent' }, locationSource: 'global' },
    });
    expect(await capability('listStorageWorkspaces', {}, context)).toMatchObject({
      status: 'ready',
      workspaces: [expect.objectContaining({ workspaceId: harness.identity.workspaceId })],
    });
    const inherited = await capability('clearStorageLocationOverride', {
      workspaceId: harness.identity.workspaceId,
    }, context);
    expect(inherited).toMatchObject({ status: 'ready', operation: { state: 'complete' } });
    await expect(capability('createCheckpoint', { name: 'x', workspaceId: '' }, context)).rejects.toThrow(/workspaceId/);
    await expect(capability('recordMutationBefore', {}, context)).rejects.toThrow(/executionId/);
    await expect(capability('prepareCombinedRecovery', {}, context)).rejects.toThrow(/entryId/);
  });
});
