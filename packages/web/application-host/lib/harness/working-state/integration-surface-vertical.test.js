import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DocumentRegistry } from '@piarium/ui/lib/documents/registry';
import { createDocumentAuthority } from '../../documents/authority.js';
import { createWorkspaceRecoveryEngine } from '../../recovery/journal-engine.js';
import { createWorkspaceWorkingStateAccess } from './working-state-store.js';
import { IntegrationCoordinator } from './integration-coordinator.js';

const roots = [];

const documentsClient = (authority) => ({
  resolveWorkspace: authority.resolveWorkspace,
  read: authority.read,
  write: authority.write,
  move: authority.move,
  delete: authority.delete,
  publishDirtyBuffers: authority.publishDirtyBuffers,
  clearDirtyBuffers: authority.clearDirtyBuffers,
  ackDirtyStateBarrier: authority.acknowledgeDirtyStateBarrier,
  captureAgentInputSnapshot: authority.captureAgentInputSnapshot,
  releaseAgentInputSnapshot: authority.releaseAgentInputSnapshot,
  listRecoveryJournals: authority.listRecoveryJournals,
  readRecoveryJournal: authority.readRecoveryJournal,
  writeRecoveryJournal: authority.writeRecoveryJournal,
  deleteRecoveryJournal: authority.deleteRecoveryJournal,
  readSurfaceOperation: authority.readSurfaceOperation,
  completeSurfaceOperation: authority.completeSurfaceOperation,
  watch(workspaceId, listener, options) {
    const files = authority.watch(workspaceId, listener);
    const surface = options?.dirtyOwner
      ? authority.registerDirtySurface({ ...options.dirtyOwner, workspaceId }, listener)
      : null;
    return {
      close() {
        surface?.close();
        files.close();
      },
    };
  },
});

const navigation = {
  prepare: async () => ({ expectedLeafId: null, targetLeafId: null }),
  prepareLeaf: async () => ({ expectedLeafId: null, targetLeafId: null }),
  commit: async () => ({}),
  commitLeaf: async () => ({}),
};

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.promises.rm(root, { recursive: true, force: true });
});

describe('surface Integration vertical path', () => {
  it('applies and undoes disk and editor targets together after the editor becomes clean', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'piarium-surface-vertical-'));
    roots.push(root);
    const workspace = path.join(root, 'workspace');
    const dataDir = path.join(root, 'data');
    const child = path.join(root, 'child');
    await fs.promises.mkdir(workspace, { recursive: true });
    await fs.promises.mkdir(child, { recursive: true });
    await fs.promises.writeFile(path.join(workspace, 'draft.txt'), 'saved\n');
    await fs.promises.writeFile(path.join(child, 'draft.txt'), 'saved\n');
    await fs.promises.writeFile(path.join(workspace, 'disk.txt'), 'disk base\n');
    await fs.promises.writeFile(path.join(child, 'disk.txt'), 'disk child\n');

    const authority = createDocumentAuthority({
      hostId: 'surface-vertical-host',
      dataDir,
      isAllowedRoot: async () => true,
      isTrusted: async () => true,
    });
    const identity = await authority.resolveWorkspace({ path: workspace });
    const registry = new DocumentRegistry({
      documents: documentsClient(authority),
      getGeneration: () => 1,
      recoverySessionId: 'surface-vertical-editor',
      journalDebounceMs: 0,
    });
    const engine = createWorkspaceRecoveryEngine({
      authorityId: 'surface-vertical-test',
      dataDir,
      documents: authority,
      sessionNavigation: navigation,
    });
    try {
      const resource = { workspaceId: identity.workspaceId, resourceId: 'draft.txt' };
      await registry.open(resource);
      registry.applyTransaction(resource, 'draft\n', { origin: 'editor' });
      await expect.poll(async () => (await authority.inspectDirtyBuffers(identity.workspaceId))[0]?.resources.length)
        .toBe(1);

      const workingStates = createWorkspaceWorkingStateAccess(engine);
      const result = await workingStates.withStore(identity.workspaceId, 'surface-vertical-result', async (store) => {
        const disk = await store.captureDirectory(workspace);
        const draft = await store.putObject(Buffer.from('draft\n'));
        const saved = disk['draft.txt'];
        if (!saved || saved.kind !== 'regular-file') throw new Error('expected saved draft file');
        await store.createBranch(identity.workspaceId, 'thread-surface-vertical', {
          ...disk,
          'draft.txt': {
            kind: 'regular-file',
            objectHash: draft.hash,
            byteLength: draft.byteLength,
            ...(saved.mode !== undefined ? { mode: saved.mode } : {}),
          },
        }, 'base', ['draft.txt']);
        return store.publishDirectoryResult('thread-surface-vertical', child);
      });
      const coordinator = new IntegrationCoordinator({
        workingStates,
        inspectDirtyBuffers: authority.inspectDirtyBuffers,
        beginDirtyStateBarrier: (workspaceId, paths) => authority.beginDirtyStateBarrier(workspaceId, paths),
        requestSurfaceOperation: (request, options) => authority.requestSurfaceOperation(request, options),
      });

      const merged = await coordinator.mergeResult({
        workspaceId: identity.workspaceId,
        threadId: 'thread-surface-vertical',
        branchId: 'thread-surface-vertical',
        resultRevision: result.resultRevision,
        sourceOwner: registry.surfaceOwner(),
      });
      expect(merged.status).toBe('applied');
      expect(registry.get(resource)).toMatchObject({ buffer: 'saved\n', dirty: false });
      expect(await fs.promises.readFile(path.join(workspace, 'draft.txt'), 'utf8')).toBe('saved\n');
      expect(await fs.promises.readFile(path.join(workspace, 'disk.txt'), 'utf8')).toBe('disk child\n');
      expect(merged.appliedPaths.toSorted()).toEqual(['disk.txt', 'draft.txt']);

      const undone = await coordinator.undoIntegration({
        workspaceId: identity.workspaceId,
        threadId: 'thread-surface-vertical',
        operationId: merged.operationId,
        sourceOwner: registry.surfaceOwner(),
      });
      expect(undone.status).toBe('compensated');
      expect(registry.get(resource)).toMatchObject({ buffer: 'draft\n', dirty: true });
      expect(await fs.promises.readFile(path.join(workspace, 'draft.txt'), 'utf8')).toBe('saved\n');
      expect(await fs.promises.readFile(path.join(workspace, 'disk.txt'), 'utf8')).toBe('disk base\n');
    } finally {
      registry.dispose();
      await engine.dispose();
      await authority.dispose();
    }
  });
});
