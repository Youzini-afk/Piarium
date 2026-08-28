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
    await fs.promises.writeFile(`${harness.workspaceRoot}/note.txt`, 'service content');
    const engine = createWorkspaceRecoveryEngine({
      authorityId: runtime.services.hostId,
      dataDir: runtimeDataDir,
      documents: harness.authority,
      sessionNavigation: {
        commit: async () => ({ alreadyApplied: false, markerId: 'service-marker', snapshot: {} }),
        prepare: async () => ({
          currentLeafId: 'service-current-leaf',
          expectedLeafId: 'service-current-leaf',
          targetId: 'service-assistant-1',
          targetLeafId: 'service-assistant-1',
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
      capabilities: { bindings: true, checkpoints: true, combined: true },
    });
    const captured = await api.captureSnapshot({ workspaceId: harness.identity.workspaceId });
    expect(captured.status).toBe('captured');
    const listed = await api.listSnapshots({ workspaceId: harness.identity.workspaceId });
    expect(listed.status).toBe('ready');
    expect(listed.page.snapshots).toHaveLength(1);
    const read = await api.readSnapshot({
      snapshotId: captured.snapshot.id,
      workspaceId: harness.identity.workspaceId,
    });
    expect(read.status).toBe('ready');
    expect(read.manifest.entries).toContainEqual(expect.objectContaining({ path: 'note.txt', kind: 'regular-file' }));

    const turn = await api.recordTurnStart({
      activeWriterScopes: ['pi-worker:worker-1'],
      beforeSnapshotId: captured.snapshot.id,
      executionId: 'service-execution-1',
      provenance: 'observed-during',
      runtimeGeneration: 1,
      sessionId: 'service-session-1',
      userEntryId: 'service-user-1',
      workerId: 'worker-1',
      workspaceId: harness.identity.workspaceId,
    });
    expect(turn).toMatchObject({ status: 'ready', binding: { status: 'pending' } });
    const settled = await api.recordTurnSettled({
      activeWriterScopes: ['pi-worker:worker-1'],
      afterSnapshotId: captured.snapshot.id,
      assistantEntryId: 'service-assistant-1',
      executionId: 'service-execution-1',
      provenance: 'observed-during',
      workspaceId: harness.identity.workspaceId,
    });
    expect(settled).toMatchObject({ status: 'ready', binding: { status: 'ready' } });
    expect(await api.resolveEntry({
      entryId: 'service-assistant-1',
      sessionId: 'service-session-1',
      workspaceId: harness.identity.workspaceId,
    })).toMatchObject({ position: 'after', snapshotId: captured.snapshot.id, status: 'ready' });
    const checkpoint = await api.createCheckpoint({
      name: 'Service checkpoint',
      workspaceId: harness.identity.workspaceId,
    });
    expect(checkpoint).toMatchObject({ status: 'captured', snapshot: { label: 'Service checkpoint' } });
    const destination = path.join(harness.root, 'service-restored-workspace');
    const prepared = await api.prepareRestore({
      newWorkspacePath: destination,
      targetSnapshotId: captured.snapshot.id,
      workspaceId: harness.identity.workspaceId,
    });
    expect(prepared).toMatchObject({ status: 'ready', plan: { targetSnapshotId: captured.snapshot.id } });
    const applied = await api.applyRestore({
      expectedRevision: prepared.plan.revision,
      mode: 'new-workspace',
      newWorkspacePath: destination,
      operationId: prepared.plan.id,
    });
    expect(applied).toMatchObject({ status: 'ready', operation: { state: 'complete' } });
    expect(await api.getOperation(prepared.plan.id)).toMatchObject({
      status: 'ready',
      operation: { destinationPath: destination, state: 'complete' },
    });
    const combined = await api.prepareCombinedRecovery({
      entryId: 'service-assistant-1',
      sessionId: 'service-session-1',
      workspaceId: harness.identity.workspaceId,
    });
    expect(combined).toMatchObject({
      status: 'ready',
      plan: {
        expectedLeafId: 'service-current-leaf',
        navigationKind: 'entry',
        targetLeafId: 'service-assistant-1',
        targetSnapshotId: captured.snapshot.id,
      },
    });
    expect(await api.cancelCombinedOperation(combined.plan.id))
      .toMatchObject({ status: 'ready', operation: { state: 'aborted' } });
    expect(await api.listCombinedOperations(harness.identity.workspaceId)).toMatchObject({
      status: 'ready',
      operations: [expect.objectContaining({ id: combined.plan.id, state: 'aborted' })],
    });
  });
});
