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
    });
    runtime.capabilities.register(
      'workspace.recovery-primitives',
      createWorkspaceRecoveryCapabilityHandler(engine),
    );
    await runtime.start();

    const api = createWorkspaceRecoveryAPI((request) => runtime.invokeService(request));
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
  });
});
