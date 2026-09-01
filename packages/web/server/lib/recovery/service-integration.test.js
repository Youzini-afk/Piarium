import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createWorkspaceRecoveryAPI } from '@piarium/extension-contract';
import { ApplicationExtensionRuntime } from '@piarium/extension-host';
import { createDocumentAuthorityHarness } from '../documents/contract-fixtures.js';
import { createWorkspaceRecoveryCapabilityHandler } from './capability.js';
import { createWorkspaceRecoveryEngine } from './engine.js';

let runtime;
let harness;
let runtimeDataDir;

afterEach(async () => {
  await runtime?.stop().catch(() => undefined);
  await harness?.cleanup();
  if (runtimeDataDir) await fs.promises.rm(runtimeDataDir, { force: true, recursive: true });
  runtime = null;
  harness = null;
  runtimeDataDir = null;
});

describe('Web Application Host workspace recovery service', () => {
  it('invokes the built-in provider through the generic extension service path', async () => {
    runtimeDataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'piarium-recovery-service-'));
    runtime = await ApplicationExtensionRuntime.create({
      brokerScript: fileURLToPath(new URL('../../../../extension-host/broker/broker-child.mjs', import.meta.url)),
      dataDir: runtimeDataDir,
      piariumVersion: '1.2.3',
    });
    harness = await createDocumentAuthorityHarness({ hostId: runtime.services.hostId });
    const notePath = `${harness.workspaceRoot}/note.txt`;
    await fs.promises.writeFile(notePath, 'before service');
    const engine = createWorkspaceRecoveryEngine({
      authorityId: runtime.services.hostId,
      dataDir: runtimeDataDir,
      documents: harness.authority,
      sessionNavigation: {
        commit: async () => ({ alreadyApplied: false, markerId: 'service-marker', snapshot: {} }),
        commitLeaf: async () => ({ alreadyApplied: false, markerId: 'service-undo', snapshot: {} }),
        prepare: async () => ({
          currentLeafId: 'service-current-leaf',
          expectedLeafId: 'service-current-leaf',
          removedEntryIds: ['service-user-1', 'service-assistant-1'],
          targetId: 'service-assistant-1',
          targetLeafId: 'service-before-leaf',
        }),
        prepareLeaf: async ({ targetLeafId }) => ({
          currentLeafId: 'service-before-leaf',
          expectedLeafId: 'service-before-leaf',
          removedEntryIds: [],
          targetLeafId,
        }),
      },
    });
    runtime.capabilities.register(
      'workspace.recovery-primitives',
      createWorkspaceRecoveryCapabilityHandler(engine),
    );
    await runtime.start();

    const api = createWorkspaceRecoveryAPI((request) => runtime.invokeService(request));
    expect(await api.status(harness.identity.workspaceId)).toMatchObject({
      status: 'ready',
      capabilities: {
        bindings: true,
        catalogLifecycle: true,
        checkpoints: true,
        combined: true,
        conflictConfirmation: true,
        dirtyStateBarrier: true,
        journal: true,
        redo: true,
        retention: true,
        storageManagement: true,
        workspaceLease: true,
      },
    });
    const turn = await api.recordTurnStart({
      activeWriterScopes: ['pi-worker:worker-1'],
      executionId: 'service-execution-1',
      provenance: 'caused-by',
      runtimeGeneration: 1,
      sessionId: 'service-session-1',
      userEntryId: 'service-user-1',
      workerId: 'worker-1',
      workspaceId: harness.identity.workspaceId,
    });
    expect(turn).toMatchObject({ status: 'ready', binding: { status: 'pending' } });
    const mutation = {
      executionId: 'service-execution-1',
      mutationId: 'service-mutation-1',
      path: notePath,
      toolCallId: 'service-tool-1',
      toolName: 'write',
      workspaceId: harness.identity.workspaceId,
    };
    expect(await api.recordMutationBefore(mutation)).toMatchObject({ recorded: true, status: 'ready' });
    await fs.promises.writeFile(notePath, 'after service');
    expect(await api.recordMutationAfter({ ...mutation, succeeded: true }))
      .toMatchObject({ recorded: true, status: 'ready' });
    const settled = await api.recordTurnSettled({
      activeWriterScopes: ['pi-worker:worker-1'],
      assistantEntryId: 'service-assistant-1',
      executionId: 'service-execution-1',
      mutationObserved: true,
      observationComplete: true,
      observedResourceIds: ['note.txt'],
      provenance: 'caused-by',
      workspaceId: harness.identity.workspaceId,
    });
    expect(settled).toMatchObject({ status: 'ready', binding: { status: 'ready' } });
    expect(await api.resolveEntry({
      entryId: 'service-assistant-1',
      sessionId: 'service-session-1',
      workspaceId: harness.identity.workspaceId,
    })).toMatchObject({ position: 'after', status: 'ready' });
    const checkpoint = await api.createCheckpoint({
      name: 'Service checkpoint',
      workspaceId: harness.identity.workspaceId,
    });
    expect(checkpoint).toMatchObject({ status: 'ready', checkpoint: { label: 'Service checkpoint' } });
    expect(await api.listCheckpoints({ workspaceId: harness.identity.workspaceId }))
      .toMatchObject({ status: 'ready', page: { checkpoints: expect.any(Array) } });
    expect(await api.setRetentionPolicy({
      policy: {
        maxAgeDays: null,
        maxByteLength: null,
        maxCheckpointCount: 10,
        maxOperationCount: 10,
      },
      workspaceId: harness.identity.workspaceId,
    })).toMatchObject({
      status: 'ready',
      retention: { policy: { maxCheckpointCount: 10, maxOperationCount: 10 } },
    });
    expect(await api.retentionStatus(harness.identity.workspaceId))
      .toMatchObject({ status: 'ready', retention: { workspaceId: harness.identity.workspaceId } });
    const combined = await api.prepareCombinedRecovery({
      entryId: 'service-user-1',
      sessionId: 'service-session-1',
      workspaceId: harness.identity.workspaceId,
    });
    expect(combined).toMatchObject({
      status: 'ready',
      plan: {
        expectedLeafId: 'service-current-leaf',
        affectedPaths: ['note.txt'],
        targetLeafId: 'service-before-leaf',
      },
    });
    const applied = await api.applyCombinedRecovery({
      confirmedConflicts: [],
      conflictPolicy: 'abort',
      expectedRevision: combined.plan.revision,
      operationId: combined.plan.id,
    });
    expect(applied).toMatchObject({ status: 'ready', operation: { state: 'complete' } });
    expect(await fs.promises.readFile(notePath, 'utf8')).toBe('before service');
    expect(await api.listCombinedOperations(harness.identity.workspaceId)).toMatchObject({
      status: 'ready',
      operations: [expect.objectContaining({ id: combined.plan.id, state: 'complete' })],
    });
  });
});
