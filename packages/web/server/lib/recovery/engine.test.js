import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDocumentAuthorityHarness } from '../documents/contract-fixtures.js';
import { objectPath, openRecoveryCatalog, recordCatalogOperation } from './catalog.js';
import { createWorkspaceRecoveryEngine } from './engine.js';
import { createRecoveryLocationRegistry } from './locations.js';

const harnesses = new Set();

const createHarness = async (options = {}) => {
  const harness = await createDocumentAuthorityHarness();
  harnesses.add(harness);
  const engine = createWorkspaceRecoveryEngine({
    authorityId: harness.authority.hostId,
    dataDir: harness.dataDir,
    documents: harness.authority,
    ...options,
  });
  return { engine, harness };
};

const applicationDataRoot = (harness) => path.join(
  harness.dataDir,
  'extensions',
  'storage',
  'piarium.builtin.recovery',
  'recovery',
  'v1',
  harness.authority.hostId,
  harness.identity.workspaceId,
);

afterEach(async () => {
  await Promise.all([...harnesses].map((harness) => harness.cleanup()));
  harnesses.clear();
});

describe('native workspace recovery Phase 1 engine', () => {
  it('reports an empty registered recovery location as missing before the first snapshot', async () => {
    const { engine, harness } = await createHarness();
    expect(await engine.storageStatus(harness.identity.workspaceId)).toMatchObject({
      status: 'ready',
      storage: { byteLength: 0, objectCount: 0, snapshotCount: 0, state: 'missing' },
    });
  });

  it('round-trips files, empty directories, symlinks, readonly metadata, exclusions, and diffs', async () => {
    const { engine, harness } = await createHarness();
    await fs.promises.mkdir(path.join(harness.workspaceRoot, 'empty'), { recursive: true });
    await fs.promises.mkdir(path.join(harness.workspaceRoot, 'nested'), { recursive: true });
    await fs.promises.writeFile(path.join(harness.workspaceRoot, 'nested', 'note.txt'), 'one\n');
    await fs.promises.chmod(path.join(harness.workspaceRoot, 'nested', 'note.txt'), 0o444);
    await fs.promises.mkdir(path.join(harness.workspaceRoot, '.git'), { recursive: true });
    await fs.promises.writeFile(path.join(harness.workspaceRoot, '.git', 'HEAD'), 'must-not-be-read');
    await fs.promises.mkdir(path.join(harness.workspaceRoot, '.piarium', 'recovery'), { recursive: true });
    await fs.promises.writeFile(path.join(harness.workspaceRoot, '.piarium', 'recovery', 'private'), 'must-not-be-read');
    let symlinkCreated = true;
    try {
      await fs.promises.symlink('nested/note.txt', path.join(harness.workspaceRoot, 'note-link'));
    } catch (error) {
      if (error?.code === 'EPERM') symlinkCreated = false;
      else throw error;
    }

    const first = await engine.captureSnapshot({ source: 'manual', workspaceId: harness.identity.workspaceId });
    expect(first.status).toBe('captured');
    expect(first.snapshot.availability).toBe('ready');
    const read = await engine.readSnapshot({
      snapshotId: first.snapshot.id,
      workspaceId: harness.identity.workspaceId,
    });
    expect(read.status).toBe('ready');
    const byPath = new Map(read.manifest.entries.map((entry) => [entry.path, entry]));
    expect(byPath.get('empty')).toMatchObject({ kind: 'directory', coverage: 'present' });
    expect(byPath.get('.git')).toMatchObject({ kind: 'excluded', reason: 'vcs-administrative-store' });
    expect(byPath.get('.piarium/recovery')).toMatchObject({ kind: 'excluded', reason: 'piarium-recovery-storage' });
    expect([...byPath.keys()].some((entry) => entry.startsWith('.git/'))).toBe(false);
    expect([...byPath.keys()].some((entry) => entry.startsWith('.piarium/recovery/'))).toBe(false);
    expect(byPath.get('nested/note.txt')).toMatchObject({
      byteLength: 4,
      kind: 'regular-file',
      readonly: process.platform === 'win32' ? expect.any(Boolean) : true,
    });
    if (symlinkCreated) {
      expect(byPath.get('note-link')).toMatchObject({
        kind: 'symlink',
        symlinkTarget: 'nested/note.txt',
      });
    }

    await fs.promises.chmod(path.join(harness.workspaceRoot, 'nested', 'note.txt'), 0o644);
    await fs.promises.writeFile(path.join(harness.workspaceRoot, 'nested', 'note.txt'), 'two\n');
    await fs.promises.writeFile(path.join(harness.workspaceRoot, 'added.txt'), 'added');
    const second = await engine.captureSnapshot({ source: 'manual', workspaceId: harness.identity.workspaceId });
    expect(second.status).toBe('captured');
    const diff = await engine.diffSnapshots({
      afterSnapshotId: second.snapshot.id,
      beforeSnapshotId: first.snapshot.id,
      workspaceId: harness.identity.workspaceId,
    });
    expect(diff.status).toBe('ready');
    expect(diff.diff.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'added.txt', type: 'added' }),
      expect.objectContaining({ path: 'nested/note.txt', type: 'modified' }),
    ]));
  });

  it('publishes incomplete coverage for unsupported entries instead of silently omitting them', async () => {
    const real = fs.promises;
    let workspaceRoot = '';
    const wrapped = {
      ...real,
      lstat: async (target, options) => {
        const stat = await real.lstat(target, options);
        if (workspaceRoot && path.resolve(target) === path.join(workspaceRoot, 'unsupported.special')) {
          return new Proxy(stat, {
            get(value, property) {
              if (typeof property === 'string' && property.startsWith('is')) return () => false;
              return Reflect.get(value, property, value);
            },
          });
        }
        return stat;
      },
    };
    const { engine, harness } = await createHarness({ fsPromises: wrapped });
    workspaceRoot = await fs.promises.realpath(harness.workspaceRoot);
    await fs.promises.writeFile(path.join(harness.workspaceRoot, 'unsupported.special'), 'x');
    const captured = await engine.captureSnapshot({ workspaceId: harness.identity.workspaceId });
    expect(captured.status).toBe('captured');
    expect(captured.snapshot).toMatchObject({ availability: 'incomplete', consistency: 'incomplete' });
    const read = await engine.readSnapshot({ snapshotId: captured.snapshot.id, workspaceId: harness.identity.workspaceId });
    expect(read.status).toBe('incomplete');
    expect(read.manifest.entries).toContainEqual(expect.objectContaining({
      coverage: 'excluded-unknown',
      kind: 'unsupported',
      path: 'unsupported.special',
    }));
  });

  it('marks a capture incomplete when the workspace root changes during traversal', async () => {
    const real = fs.promises;
    let workspaceRoot = '';
    let rootStats = 0;
    const wrapped = {
      ...real,
      lstat: async (target, options) => {
        if (workspaceRoot && path.resolve(target) === workspaceRoot) {
          rootStats += 1;
          if (rootStats === 2) await real.writeFile(path.join(workspaceRoot, 'arrived-during-capture.txt'), 'late');
        }
        return real.lstat(target, options);
      },
    };
    const { engine, harness } = await createHarness({ fsPromises: wrapped });
    workspaceRoot = await fs.promises.realpath(harness.workspaceRoot);
    await fs.promises.writeFile(path.join(harness.workspaceRoot, 'before.txt'), 'before');

    const captured = await engine.captureSnapshot({ workspaceId: harness.identity.workspaceId });
    expect(captured).toMatchObject({ status: 'captured', snapshot: { availability: 'incomplete' } });
    const read = await engine.readSnapshot({ snapshotId: captured.snapshot.id, workspaceId: harness.identity.workspaceId });
    expect(read.manifest.entries).toContainEqual(expect.objectContaining({
      coverage: 'unstable',
      path: '.',
      reason: 'directory-changed-during-capture',
    }));
    expect(read.manifest.entries.some((entry) => entry.path === 'arrived-during-capture.txt')).toBe(false);
  });

  it('keeps complete scans as point-in-time history during writer overlap and watcher reset', async () => {
    const harness = await createDocumentAuthorityHarness();
    harnesses.add(harness);
    await fs.promises.writeFile(path.join(harness.workspaceRoot, 'note.txt'), 'content');
    let resetDuringCapture = false;
    const engine = createWorkspaceRecoveryEngine({
      authorityId: harness.authority.hostId,
      dataDir: harness.dataDir,
      documents: harness.authority,
      faults: {
        beforePublish: async () => {
          if (resetDuringCapture) harness.authority.emitWatchOverflow(harness.identity.workspaceId);
        },
      },
    });

    const writer = await harness.authority.registerWriter(harness.token(), { purpose: 'capture-overlap-test' });
    const active = await engine.captureSnapshot({ workspaceId: harness.identity.workspaceId });
    expect(active).toMatchObject({
      status: 'captured',
      snapshot: { availability: 'ready', consistency: 'point-in-time' },
    });
    await writer.close();

    resetDuringCapture = true;
    const reset = await engine.captureSnapshot({ workspaceId: harness.identity.workspaceId });
    expect(reset).toMatchObject({
      status: 'captured',
      snapshot: { availability: 'ready', consistency: 'point-in-time' },
    });

    resetDuringCapture = false;
    const stable = await engine.captureSnapshot({ workspaceId: harness.identity.workspaceId });
    expect(stable).toMatchObject({ status: 'captured', snapshot: { availability: 'ready', consistency: 'validated' } });
    expect((await harness.authority.inspectMutation(harness.identity.workspaceId)).reconciliationRequired).toBe(false);
  });

  it('records point-in-time history when the workspace watcher is unavailable', async () => {
    const harness = await createDocumentAuthorityHarness();
    harnesses.add(harness);
    const beginCapture = vi.fn(async () => {
      throw Object.assign(new Error('watch backend unavailable'), { code: 'watch-unavailable' });
    });
    const engine = createWorkspaceRecoveryEngine({
      authorityId: harness.authority.hostId,
      dataDir: harness.dataDir,
      documents: { ...harness.authority, beginCapture },
    });
    await fs.promises.writeFile(path.join(harness.workspaceRoot, 'note.txt'), 'recoverable');

    const captured = await engine.captureSnapshot({
      source: 'turn-before',
      workspaceId: harness.identity.workspaceId,
    });

    expect(beginCapture).toHaveBeenCalledOnce();
    expect(captured).toMatchObject({
      status: 'captured',
      snapshot: { availability: 'ready', consistency: 'point-in-time' },
    });
    const read = await engine.readSnapshot({
      snapshotId: captured.snapshot.id,
      workspaceId: harness.identity.workspaceId,
    });
    expect(read).toMatchObject({ status: 'ready' });
    expect(read.manifest.entries).toContainEqual(expect.objectContaining({
      coverage: 'present',
      path: 'note.txt',
    }));
  });

  it('does not publish when a referenced object disappears before publication', async () => {
    const { engine, harness } = await createHarness({
      faults: {
        beforePublish: async ({ database, root, captureId }) => {
          const row = database.prepare(
            'SELECT object_hash FROM staged_entries WHERE capture_id = ? AND object_hash IS NOT NULL LIMIT 1',
          ).get(captureId);
          if (row) await fs.promises.unlink(objectPath(root, row.object_hash));
        },
      },
    });
    await fs.promises.writeFile(path.join(harness.workspaceRoot, 'note.txt'), 'content');
    const captured = await engine.captureSnapshot({ workspaceId: harness.identity.workspaceId });
    expect(captured.status).toBe('failed');
    expect(captured.failure.code).toBe('object-missing');
    const listed = await engine.listSnapshots({ workspaceId: harness.identity.workspaceId });
    expect(listed).toEqual({ page: { nextCursor: null, snapshots: [] }, status: 'ready' });
  });

  it('recovers abandoned capture staging before serving the store again', async () => {
    const { engine, harness } = await createHarness();
    await fs.promises.writeFile(path.join(harness.workspaceRoot, 'note.txt'), 'content');
    await engine.captureSnapshot({ workspaceId: harness.identity.workspaceId });
    const root = applicationDataRoot(harness);
    const database = await openRecoveryCatalog(root, { create: false });
    const captureId = 'abandoned-capture';
    recordCatalogOperation(database, {
      createdAt: new Date().toISOString(),
      data: {},
      id: captureId,
      state: 'scanning',
      type: 'capture',
      updatedAt: new Date().toISOString(),
      workspaceId: harness.identity.workspaceId,
    });
    database.prepare(`
      INSERT INTO staged_entries(capture_id, path, comparison_key, kind, coverage)
      VALUES (?, ?, ?, ?, ?)
    `).run(captureId, 'partial.txt', 'partial.txt', 'regular-file', 'unstable');
    database.close();
    const abandonedFile = path.join(root, 'staging', captureId, 'partial.tmp');
    await fs.promises.mkdir(path.dirname(abandonedFile), { recursive: true });
    await fs.promises.writeFile(abandonedFile, 'partial');

    const restarted = createWorkspaceRecoveryEngine({
      authorityId: harness.authority.hostId,
      dataDir: harness.dataDir,
      documents: harness.authority,
    });
    const listed = await restarted.listSnapshots({ workspaceId: harness.identity.workspaceId });
    expect(listed.status).toBe('ready');
    const recovered = await openRecoveryCatalog(root, { create: false });
    expect(recovered.prepare('SELECT state FROM operations WHERE id = ?').get(captureId).state).toBe('failed');
    expect(recovered.prepare('SELECT COUNT(*) AS count FROM staged_entries').get().count).toBe(0);
    recovered.close();
    await expect(fs.promises.stat(abandonedFile)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reports missing and corrupt ready objects as unrestorable', async () => {
    const { engine, harness } = await createHarness();
    await fs.promises.writeFile(path.join(harness.workspaceRoot, 'note.txt'), 'content');
    const captured = await engine.captureSnapshot({ workspaceId: harness.identity.workspaceId });
    const read = await engine.readSnapshot({ snapshotId: captured.snapshot.id, workspaceId: harness.identity.workspaceId });
    const hash = read.manifest.entries.find((entry) => entry.path === 'note.txt').objectHash;
    const target = objectPath(applicationDataRoot(harness), hash);

    await fs.promises.writeFile(target, 'different');
    const corrupt = await engine.readSnapshot({ snapshotId: captured.snapshot.id, workspaceId: harness.identity.workspaceId });
    expect(corrupt).toMatchObject({ status: 'corrupt', failure: { code: 'object-corrupt' } });

    await fs.promises.unlink(target);
    const missing = await engine.readSnapshot({ snapshotId: captured.snapshot.id, workspaceId: harness.identity.workspaceId });
    expect(missing).toMatchObject({ status: 'corrupt', failure: { code: 'object-missing' } });
  });

  it('keeps a missing snapshot distinct from a malformed stored manifest', async () => {
    const { engine, harness } = await createHarness();
    const missing = await engine.readSnapshot({
      snapshotId: 'does-not-exist',
      workspaceId: harness.identity.workspaceId,
    });
    expect(missing).toMatchObject({ status: 'missing', failure: { code: 'snapshot-missing' } });

    await fs.promises.writeFile(path.join(harness.workspaceRoot, 'note.txt'), 'content');
    const captured = await engine.captureSnapshot({ workspaceId: harness.identity.workspaceId });
    const database = await openRecoveryCatalog(applicationDataRoot(harness), { create: false });
    database.prepare(
      "UPDATE snapshot_entries SET platform_json = '{not-json' WHERE snapshot_id = ? AND path = 'note.txt'",
    ).run(captured.snapshot.id);
    database.close();
    const malformed = await engine.readSnapshot({
      snapshotId: captured.snapshot.id,
      workspaceId: harness.identity.workspaceId,
    });
    expect(malformed).toMatchObject({ status: 'malformed', failure: { code: 'snapshot-malformed' } });
  });

  it('does not misreport a workspace authority failure as a malformed snapshot', async () => {
    const { engine } = await createHarness();
    const result = await engine.readSnapshot({ snapshotId: 'unknown', workspaceId: 'unknown-workspace' });
    expect(result.status).toBe('failed');
    expect(result.failure.code).not.toBe('snapshot-malformed');
  });

  it('resolves all storage modes and honors the Host default override', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'piarium-recovery-locations-'));
    try {
      const workspace = path.join(root, 'workspace');
      const custom = path.join(root, 'custom');
      const defaultRoot = path.join(root, 'default');
      await Promise.all([workspace, custom, defaultRoot].map((directory) => fs.promises.mkdir(directory, { recursive: true })));
      const canonicalCustomRoot = await fs.promises.realpath(custom);
      const canonicalDefaultRoot = await fs.promises.realpath(defaultRoot);
      const identity = {
        authorityId: 'authority-1',
        canonicalRoot: workspace,
        workspaceId: 'workspace-1',
      };
      const registry = createRecoveryLocationRegistry({
        authorityId: identity.authorityId,
        dataDir: path.join(root, 'data'),
        defaultRecoveryDir: defaultRoot,
      });
      expect(await registry.resolve(identity, { mode: 'application-data' })).toBe(path.join(canonicalDefaultRoot, 'authority-1', 'workspace-1', 'v1'));
      expect(await registry.resolve(identity, { mode: 'workspace-local' })).toBe(path.join(workspace, '.piarium', 'recovery', 'v1'));
      expect(await registry.resolve(identity, { mode: 'workspace-adjacent' })).toBe(path.join(root, '.piarium-recovery', 'workspace-1', 'v1'));
      expect(await registry.resolve(identity, { mode: 'custom', customRoot: custom })).toBe(path.join(canonicalCustomRoot, 'authority-1', 'workspace-1', 'v1'));
    } finally {
      await fs.promises.rm(root, { force: true, recursive: true });
    }
  });

  it('applies the global default lazily while project storage overrides keep priority', async () => {
    const { engine, harness } = await createHarness();
    await fs.promises.writeFile(path.join(harness.workspaceRoot, 'note.txt'), 'content');
    const captured = await engine.captureSnapshot({ workspaceId: harness.identity.workspaceId });
    expect(captured.status).toBe('captured');

    const globalChanged = await engine.setDefaultStorageLocation({ mode: 'workspace-adjacent' });
    expect(globalChanged).toMatchObject({
      status: 'ready',
      storage: { location: { mode: 'workspace-adjacent' }, locationSource: 'global' },
    });
    expect(await engine.listStorageWorkspaces()).toMatchObject({
      status: 'ready',
      workspaces: [expect.objectContaining({
        location: { mode: 'application-data' },
        locationSource: 'global',
        migrationRequired: true,
        snapshotCount: 1,
        workspaceId: harness.identity.workspaceId,
      })],
    });
    const inherited = await engine.storageStatus(harness.identity.workspaceId);
    expect(inherited).toMatchObject({
      status: 'ready',
      storage: { location: { mode: 'workspace-adjacent' }, locationSource: 'global', snapshotCount: 1 },
    });
    expect(await engine.listStorageWorkspaces()).toMatchObject({
      status: 'ready',
      workspaces: [expect.objectContaining({ migrationRequired: false })],
    });
    await expect(fs.promises.stat(applicationDataRoot(harness))).rejects.toMatchObject({ code: 'ENOENT' });

    const overridden = await engine.setStorageLocation({
      location: { mode: 'workspace-local' },
      workspaceId: harness.identity.workspaceId,
    });
    expect(overridden).toMatchObject({ status: 'ready', operation: { state: 'complete' } });
    await engine.setDefaultStorageLocation({ mode: 'application-data' });
    expect(await engine.storageStatus(harness.identity.workspaceId)).toMatchObject({
      status: 'ready',
      storage: { location: { mode: 'workspace-local' }, locationSource: 'workspace', snapshotCount: 1 },
    });

    const inheritedAgain = await engine.clearStorageLocationOverride(harness.identity.workspaceId);
    expect(inheritedAgain).toMatchObject({ status: 'ready', operation: { state: 'complete' } });
    expect(await engine.storageStatus(harness.identity.workspaceId)).toMatchObject({
      status: 'ready',
      storage: { location: { mode: 'application-data' }, locationSource: 'global', snapshotCount: 1 },
    });
    expect(await engine.readSnapshot({
      snapshotId: captured.snapshot.id,
      workspaceId: harness.identity.workspaceId,
    })).toMatchObject({ status: 'ready' });
  });

  it('bootstraps an unmaterialized workspace from application data before following a changed global default', async () => {
    const { engine, harness } = await createHarness();
    await engine.setDefaultStorageLocation({ mode: 'workspace-adjacent' });
    await fs.promises.writeFile(path.join(harness.workspaceRoot, 'note.txt'), 'content');

    const captured = await engine.captureSnapshot({ workspaceId: harness.identity.workspaceId });
    expect(captured.status).toBe('captured');
    expect(await engine.storageStatus(harness.identity.workspaceId)).toMatchObject({
      status: 'ready',
      storage: { location: { mode: 'workspace-adjacent' }, locationSource: 'global', snapshotCount: 1 },
    });
  });

  it('lets an unmaterialized project override a changed global default', async () => {
    const { engine, harness } = await createHarness();
    await engine.setDefaultStorageLocation({ mode: 'workspace-adjacent' });

    const moved = await engine.setStorageLocation({
      location: { mode: 'workspace-local' },
      workspaceId: harness.identity.workspaceId,
    });
    expect(moved).toMatchObject({ status: 'ready', operation: { state: 'complete' } });
    expect(await engine.storageStatus(harness.identity.workspaceId)).toMatchObject({
      status: 'ready',
      storage: { location: { mode: 'workspace-local' }, locationSource: 'workspace' },
    });
  });

  it('inventories and cleans Host-owned history while a previous workspace is offline', async () => {
    const { engine, harness } = await createHarness();
    await fs.promises.writeFile(path.join(harness.workspaceRoot, 'note.txt'), 'content');
    await engine.captureSnapshot({ workspaceId: harness.identity.workspaceId });
    const offlineRoot = `${harness.workspaceRoot}.offline`;
    await fs.promises.rename(harness.workspaceRoot, offlineRoot);
    try {
      expect(await engine.listStorageWorkspaces()).toMatchObject({
        status: 'ready',
        workspaces: [expect.objectContaining({
          snapshotCount: 1,
          storageAvailable: true,
          workspaceAvailable: false,
          workspaceId: harness.identity.workspaceId,
        })],
      });
      expect(await engine.cleanupStorage({ workspaceId: harness.identity.workspaceId })).toMatchObject({
        status: 'ready',
        result: { status: 'complete' },
      });
      expect(await engine.deleteWorkspaceHistory(harness.identity.workspaceId)).toMatchObject({
        status: 'ready',
        result: { status: 'complete' },
      });
      expect(await engine.listStorageWorkspaces()).toMatchObject({
        status: 'ready',
        workspaces: [expect.objectContaining({ snapshotCount: 0, state: 'missing' })],
      });
    } finally {
      await fs.promises.rename(offlineRoot, harness.workspaceRoot);
    }
  });

  it('keeps recovery storage private to the providing extension', async () => {
    const { engine, harness } = await createHarness();
    const other = createWorkspaceRecoveryEngine({
      authorityId: harness.authority.hostId,
      dataDir: harness.dataDir,
      documents: harness.authority,
      storageOwnerId: 'dev.example.recovery',
    });
    await fs.promises.writeFile(path.join(harness.workspaceRoot, 'note.txt'), 'content');
    const captured = await engine.captureSnapshot({ workspaceId: harness.identity.workspaceId });
    expect(captured.status).toBe('captured');
    expect(await other.listSnapshots({ workspaceId: harness.identity.workspaceId })).toEqual({
      page: { nextCursor: null, snapshots: [] },
      status: 'ready',
    });
  });

  it('keeps the old storage authority when a verified move fails before the registry switch', async () => {
    const { engine, harness } = await createHarness({
      faults: { beforeLocationSwitch: async () => { throw new Error('injected move failure'); } },
    });
    await fs.promises.writeFile(path.join(harness.workspaceRoot, 'note.txt'), 'content');
    const captured = await engine.captureSnapshot({ workspaceId: harness.identity.workspaceId });
    const moved = await engine.setStorageLocation({
      location: { mode: 'workspace-local' },
      workspaceId: harness.identity.workspaceId,
    });
    expect(moved.status).toBe('ready');
    expect(moved.operation).toMatchObject({ state: 'failed', failure: { code: 'storage-move-failed' } });
    const status = await engine.storageStatus(harness.identity.workspaceId);
    expect(status.storage.location).toEqual({ mode: 'application-data' });
    const read = await engine.readSnapshot({ snapshotId: captured.snapshot.id, workspaceId: harness.identity.workspaceId });
    expect(read.status).toBe('ready');
  });

  it('never performs cleanup from untrusted absolute roots stored in a move record', async () => {
    const { engine, harness } = await createHarness();
    const operationId = 'tampered-move';
    const unrelatedRoot = path.join(path.dirname(harness.dataDir), 'unrelated', 'payload', 'v1');
    await fs.promises.mkdir(unrelatedRoot, { recursive: true });
    const sentinel = path.join(unrelatedRoot, 'keep.txt');
    await fs.promises.writeFile(sentinel, 'keep');
    const now = new Date().toISOString();
    await fs.promises.mkdir(engine.locations.operationsRoot, { recursive: true });
    await fs.promises.writeFile(
      path.join(engine.locations.operationsRoot, `${operationId}.json`),
      `${JSON.stringify({
        authorityId: harness.authority.hostId,
        backupRoot: `${unrelatedRoot}.move-${operationId}.previous`,
        byteLength: 0,
        destinationHadExisting: false,
        destinationRoot: unrelatedRoot,
        from: { mode: 'application-data' },
        id: operationId,
        sourceRoot: unrelatedRoot,
        stageRoot: `${unrelatedRoot}.move-${operationId}.staging`,
        startedAt: now,
        state: 'copying',
        switched: false,
        to: { mode: 'workspace-local' },
        updatedAt: now,
        workspaceId: harness.identity.workspaceId,
      }, null, 2)}\n`,
    );

    const status = await engine.storageStatus(harness.identity.workspaceId);
    expect(status).toMatchObject({ status: 'failed', failure: { code: 'storage-malformed' } });
    await expect(fs.promises.readFile(sentinel, 'utf8')).resolves.toBe('keep');
    await fs.promises.rm(path.dirname(path.dirname(unrelatedRoot)), { force: true, recursive: true });
  });

  it('switches authority only after a successful verified storage move', async () => {
    const { engine, harness } = await createHarness();
    await fs.promises.writeFile(path.join(harness.workspaceRoot, 'note.txt'), 'content');
    const captured = await engine.captureSnapshot({ workspaceId: harness.identity.workspaceId });
    const moved = await engine.setStorageLocation({
      location: { mode: 'workspace-adjacent' },
      workspaceId: harness.identity.workspaceId,
    });
    expect(moved).toMatchObject({ status: 'ready', operation: { state: 'complete' } });
    const status = await engine.storageStatus(harness.identity.workspaceId);
    expect(status.storage.location).toEqual({ mode: 'workspace-adjacent' });
    const read = await engine.readSnapshot({ snapshotId: captured.snapshot.id, workspaceId: harness.identity.workspaceId });
    expect(read.status).toBe('ready');
    await expect(fs.promises.stat(applicationDataRoot(harness))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses to overwrite a pre-existing recovery destination', async () => {
    const { engine, harness } = await createHarness();
    const destination = path.join(harness.workspaceRoot, '.piarium', 'recovery', 'v1');
    await fs.promises.mkdir(destination, { recursive: true });
    await fs.promises.writeFile(path.join(destination, 'keep.txt'), 'existing destination');
    await fs.promises.writeFile(path.join(harness.workspaceRoot, 'note.txt'), 'content');
    const captured = await engine.captureSnapshot({ workspaceId: harness.identity.workspaceId });

    const moved = await engine.setStorageLocation({
      location: { mode: 'workspace-local' },
      workspaceId: harness.identity.workspaceId,
    });
    expect(moved).toMatchObject({ status: 'ready', operation: { state: 'failed' } });
    await expect(fs.promises.readFile(path.join(destination, 'keep.txt'), 'utf8')).resolves.toBe('existing destination');
    const read = await engine.readSnapshot({ snapshotId: captured.snapshot.id, workspaceId: harness.identity.workspaceId });
    expect(read.status).toBe('ready');
  });

  it('rejects a storage move whose destination is nested inside the source payload', async () => {
    const { engine, harness } = await createHarness();
    await fs.promises.writeFile(path.join(harness.workspaceRoot, 'note.txt'), 'content');
    await engine.captureSnapshot({ workspaceId: harness.identity.workspaceId });
    const moved = await engine.setStorageLocation({
      location: { customRoot: applicationDataRoot(harness), mode: 'custom' },
      workspaceId: harness.identity.workspaceId,
    });
    expect(moved).toMatchObject({ status: 'failed', failure: { code: 'invalid-request' } });
  });

  it('cleans only unreachable objects and deletes all workspace history explicitly', async () => {
    const { engine, harness } = await createHarness();
    await fs.promises.writeFile(path.join(harness.workspaceRoot, 'note.txt'), 'content');
    const captured = await engine.captureSnapshot({ workspaceId: harness.identity.workspaceId });
    const read = await engine.readSnapshot({ snapshotId: captured.snapshot.id, workspaceId: harness.identity.workspaceId });
    const reachableHash = read.manifest.entries.find((entry) => entry.path === 'note.txt').objectHash;
    const root = applicationDataRoot(harness);
    const orphanHash = `sha256-${'f'.repeat(64)}`;
    await fs.promises.mkdir(path.dirname(objectPath(root, orphanHash)), { recursive: true });
    await fs.promises.writeFile(objectPath(root, orphanHash), 'orphan');

    const cleaned = await engine.cleanupStorage({ workspaceId: harness.identity.workspaceId });
    expect(cleaned).toMatchObject({ status: 'ready', result: { status: 'complete', objectsDeleted: 1 } });
    await expect(fs.promises.stat(objectPath(root, reachableHash))).resolves.toBeDefined();
    await expect(fs.promises.stat(objectPath(root, orphanHash))).rejects.toMatchObject({ code: 'ENOENT' });

    const deleted = await engine.deleteWorkspaceHistory(harness.identity.workspaceId);
    expect(deleted).toMatchObject({ status: 'ready', result: { status: 'complete' } });
    const listed = await engine.listSnapshots({ workspaceId: harness.identity.workspaceId });
    expect(listed).toEqual({ page: { nextCursor: null, snapshots: [] }, status: 'ready' });
  });

  it('reuses a validated workspace head only while its mutation witness is unchanged', async () => {
    const { engine, harness } = await createHarness();
    await fs.promises.writeFile(path.join(harness.workspaceRoot, 'note.txt'), 'one');
    const first = await engine.captureSnapshot({
      reuseIfUnchanged: true,
      source: 'turn-before',
      workspaceId: harness.identity.workspaceId,
    });
    expect(first).toMatchObject({ status: 'captured', reused: false });
    const reused = await engine.captureSnapshot({
      reuseIfUnchanged: true,
      source: 'turn-before',
      workspaceId: harness.identity.workspaceId,
    });
    expect(reused).toMatchObject({
      status: 'captured',
      reused: true,
      snapshot: { id: first.snapshot.id },
      witness: first.witness,
    });

    const current = await harness.authority.read(harness.resource('note.txt'));
    await harness.authority.write({
      token: harness.token(),
      resource: harness.resource('note.txt'),
      content: 'two',
      encoding: 'utf-8',
      bom: false,
      expectedRevision: current.revision,
      operationId: 'phase3-mutation',
    });
    const changed = await engine.captureSnapshot({
      reuseIfUnchanged: true,
      source: 'turn-after',
      workspaceId: harness.identity.workspaceId,
    });
    expect(changed).toMatchObject({ status: 'captured', reused: false });
    expect(changed.snapshot.id).not.toBe(first.snapshot.id);
  });

  it('binds exact user/assistant entries independently from conversation ancestry and pins checkpoints', async () => {
    const { engine, harness } = await createHarness();
    await fs.promises.writeFile(path.join(harness.workspaceRoot, 'note.txt'), 'before');
    const before = await engine.captureSnapshot({ source: 'turn-before', workspaceId: harness.identity.workspaceId });
    const started = await engine.recordTurnStart({
      activeWriterScopes: ['pi-worker:worker-1'],
      beforeSnapshotId: before.snapshot.id,
      executionId: 'execution-1',
      provenance: 'observed-during',
      runtimeGeneration: 3,
      sessionId: 'session-1',
      userEntryId: 'user-entry-1',
      workerId: 'worker-1',
      workspaceId: harness.identity.workspaceId,
    });
    expect(started).toMatchObject({ status: 'ready', binding: { status: 'pending' } });

    const current = await harness.authority.read(harness.resource('note.txt'));
    await harness.authority.write({
      token: harness.token(),
      resource: harness.resource('note.txt'),
      content: 'after',
      encoding: 'utf-8',
      bom: false,
      expectedRevision: current.revision,
      operationId: 'turn-write',
    });
    const after = await engine.captureSnapshot({ source: 'turn-after', workspaceId: harness.identity.workspaceId });
    const settled = await engine.recordTurnSettled({
      activeWriterScopes: ['terminal:other-session'],
      afterSnapshotId: after.snapshot.id,
      assistantEntryId: 'assistant-entry-1',
      executionId: 'execution-1',
      provenance: 'overlapped',
      workspaceId: harness.identity.workspaceId,
    });
    expect(settled).toMatchObject({
      status: 'ready',
      binding: { provenance: 'overlapped', status: 'ready' },
    });
    expect(await engine.resolveEntry({
      entryId: 'user-entry-1',
      sessionId: 'session-1',
      workspaceId: harness.identity.workspaceId,
    })).toMatchObject({ position: 'before', snapshotId: before.snapshot.id, status: 'ready' });
    expect(await engine.resolveEntry({
      entryId: 'assistant-entry-1',
      sessionId: 'session-1',
      workspaceId: harness.identity.workspaceId,
    })).toMatchObject({ position: 'after', snapshotId: after.snapshot.id, status: 'ready' });
    expect(await engine.resolveEntry({
      entryId: 'unbound-entry',
      sessionId: 'session-1',
      workspaceId: harness.identity.workspaceId,
    })).toEqual({ reason: 'entry-unbound', status: 'unbound' });

    const checkpoint = await engine.createCheckpoint({
      name: 'Before refactor',
      workspaceId: harness.identity.workspaceId,
    });
    expect(checkpoint).toMatchObject({ status: 'captured', snapshot: { label: 'Before refactor' } });
    const database = await openRecoveryCatalog(applicationDataRoot(harness), { create: false });
    expect(database.prepare("SELECT key FROM pins WHERE snapshot_id = ? AND kind = 'named'")
      .get(checkpoint.snapshot.id)).toEqual({ key: 'Before refactor' });
    database.close();
  });

  it('prepares one immutable plan and materializes a new workspace without touching the current one', async () => {
    const { engine, harness } = await createHarness();
    await fs.promises.mkdir(path.join(harness.workspaceRoot, 'empty'), { recursive: true });
    await fs.promises.writeFile(path.join(harness.workspaceRoot, 'note.txt'), 'target');
    await fs.promises.writeFile(path.join(harness.workspaceRoot, 'hardlink-leader.txt'), 'linked');
    await fs.promises.link(
      path.join(harness.workspaceRoot, 'hardlink-leader.txt'),
      path.join(harness.workspaceRoot, 'hardlink-member.txt'),
    );
    const target = await engine.captureSnapshot({ workspaceId: harness.identity.workspaceId });
    const note = await harness.authority.read(harness.resource('note.txt'));
    await harness.authority.write({
      token: harness.token(),
      resource: harness.resource('note.txt'),
      content: 'current',
      encoding: 'utf-8',
      bom: false,
      expectedRevision: note.revision,
      operationId: 'current-note',
    });
    await harness.authority.write({
      token: harness.token(),
      resource: harness.resource('extra.txt'),
      content: 'keep-current-only',
      encoding: 'utf-8',
      bom: false,
      expectedRevision: null,
      operationId: 'current-extra',
    });
    const destination = path.join(harness.root, 'recovered-workspace');
    const prepared = await engine.prepareRestore({
      newWorkspacePath: destination,
      targetSnapshotId: target.snapshot.id,
      workspaceId: harness.identity.workspaceId,
    });
    expect(prepared).toMatchObject({
      status: 'ready',
      plan: {
        allowedModes: ['in-place', 'new-workspace'],
        recommendedMode: 'in-place',
      },
    });
    expect(prepared.plan.operations.map((operation) => [operation.type, operation.path]))
      .toEqual(expect.arrayContaining([['write', 'note.txt'], ['delete', 'extra.txt']]));

    const applied = await engine.applyRestore({
      expectedRevision: prepared.plan.revision,
      mode: 'new-workspace',
      newWorkspacePath: destination,
      operationId: prepared.plan.id,
    });
    expect(applied).toMatchObject({ status: 'ready', operation: { state: 'complete', mode: 'new-workspace' } });
    await expect(fs.promises.readFile(path.join(destination, 'note.txt'), 'utf8')).resolves.toBe('target');
    expect((await fs.promises.stat(path.join(destination, 'empty'))).isDirectory()).toBe(true);
    const [leaderStat, memberStat] = await Promise.all([
      fs.promises.stat(path.join(destination, 'hardlink-leader.txt')),
      fs.promises.stat(path.join(destination, 'hardlink-member.txt')),
    ]);
    expect(memberStat.dev).toBe(leaderStat.dev);
    expect(memberStat.ino).toBe(leaderStat.ino);
    await expect(fs.promises.stat(path.join(destination, 'extra.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.promises.readFile(path.join(harness.workspaceRoot, 'note.txt'), 'utf8')).resolves.toBe('current');
    await expect(fs.promises.readFile(path.join(harness.workspaceRoot, 'extra.txt'), 'utf8')).resolves.toBe('keep-current-only');
    expect(await engine.getOperation(prepared.plan.id)).toMatchObject({
      status: 'ready',
      operation: { destinationPath: destination, state: 'complete' },
    });
  });

  it('resumes an in-place restore after a simulated process crash and publishes a restore revision', async () => {
    let crashAfterFirst = true;
    const crash = Object.assign(new Error('simulated crash'), { simulatedCrash: true });
    const { engine, harness } = await createHarness({
      faults: {
        afterApplyOperation: () => {
          if (!crashAfterFirst) return;
          crashAfterFirst = false;
          throw crash;
        },
      },
    });
    await fs.promises.writeFile(path.join(harness.workspaceRoot, 'a.txt'), 'target-a');
    await fs.promises.writeFile(path.join(harness.workspaceRoot, 'b.txt'), 'target-b');
    const target = await engine.captureSnapshot({ workspaceId: harness.identity.workspaceId });
    for (const [name, content] of [['a.txt', 'current-a'], ['b.txt', 'current-b']]) {
      const current = await harness.authority.read(harness.resource(name));
      await harness.authority.write({
        token: harness.token(),
        resource: harness.resource(name),
        content,
        encoding: 'utf-8',
        bom: false,
        expectedRevision: current.revision,
        operationId: `mutate-${name}`,
      });
    }
    const prepared = await engine.prepareRestore({
      targetSnapshotId: target.snapshot.id,
      workspaceId: harness.identity.workspaceId,
    });
    const firstAttempt = await engine.applyRestore({
      expectedRevision: prepared.plan.revision,
      mode: 'in-place',
      operationId: prepared.plan.id,
    });
    expect(firstAttempt).toMatchObject({ status: 'failed', failure: { code: 'internal' } });
    expect(await engine.getOperation(prepared.plan.id)).toMatchObject({
      status: 'ready',
      operation: { state: 'applying-workspace', appliedOperations: 1 },
    });

    const resumed = await engine.applyRestore({
      expectedRevision: prepared.plan.revision,
      mode: 'in-place',
      operationId: prepared.plan.id,
    });
    expect(resumed).toMatchObject({ status: 'ready', operation: { state: 'complete', mode: 'in-place' } });
    await expect(fs.promises.readFile(path.join(harness.workspaceRoot, 'a.txt'), 'utf8')).resolves.toBe('target-a');
    await expect(fs.promises.readFile(path.join(harness.workspaceRoot, 'b.txt'), 'utf8')).resolves.toBe('target-b');
    const state = await harness.authority.inspectMutation(harness.identity.workspaceId);
    expect(state.epoch).toBe(2);
    expect(state.maintenance).toBe(false);
    const snapshots = await engine.listSnapshots({ workspaceId: harness.identity.workspaceId });
    expect(snapshots.page.snapshots[0]).toMatchObject({ source: 'restore', restoredFrom: target.snapshot.id });
  });

  it('resumes a new-workspace root switch after the staged tree was verified', async () => {
    let crashBeforeSwitch = true;
    const crash = Object.assign(new Error('simulated root-switch crash'), { simulatedCrash: true });
    const { engine, harness } = await createHarness({
      faults: {
        beforeRootSwitch: () => {
          if (!crashBeforeSwitch) return;
          crashBeforeSwitch = false;
          throw crash;
        },
      },
    });
    await fs.promises.writeFile(path.join(harness.workspaceRoot, 'note.txt'), 'target');
    const target = await engine.captureSnapshot({ workspaceId: harness.identity.workspaceId });
    const destination = path.join(harness.root, 'root-switch-recovered');
    const prepared = await engine.prepareRestore({
      newWorkspacePath: destination,
      targetSnapshotId: target.snapshot.id,
      workspaceId: harness.identity.workspaceId,
    });
    expect(await engine.applyRestore({
      expectedRevision: prepared.plan.revision,
      mode: 'new-workspace',
      newWorkspacePath: destination,
      operationId: prepared.plan.id,
    })).toMatchObject({ status: 'failed', failure: { code: 'internal' } });
    expect(await engine.getOperation(prepared.plan.id)).toMatchObject({
      status: 'ready',
      operation: { state: 'workspace-verified' },
    });
    await expect(fs.promises.stat(destination)).rejects.toMatchObject({ code: 'ENOENT' });

    expect(await engine.applyRestore({
      expectedRevision: prepared.plan.revision,
      mode: 'new-workspace',
      newWorkspacePath: destination,
      operationId: prepared.plan.id,
    })).toMatchObject({ status: 'ready', operation: { state: 'complete' } });
    await expect(fs.promises.readFile(path.join(destination, 'note.txt'), 'utf8')).resolves.toBe('target');
  });

  it('rejects a stale in-place plan but keeps the same immutable target usable for new-workspace restore', async () => {
    const { engine, harness } = await createHarness();
    await fs.promises.writeFile(path.join(harness.workspaceRoot, 'note.txt'), 'target');
    const target = await engine.captureSnapshot({ workspaceId: harness.identity.workspaceId });
    expect(target).toMatchObject({ status: 'captured' });
    await fs.promises.writeFile(path.join(harness.workspaceRoot, 'note.txt'), 'current');
    const destination = path.join(harness.root, 'stale-plan-recovered');
    const prepared = await engine.prepareRestore({
      newWorkspacePath: destination,
      targetSnapshotId: target.snapshot.id,
      workspaceId: harness.identity.workspaceId,
    });
    const current = await harness.authority.read(harness.resource('note.txt'));
    await harness.authority.write({
      token: harness.token(),
      resource: harness.resource('note.txt'),
      content: 'changed-after-plan',
      encoding: 'utf-8',
      bom: false,
      expectedRevision: current.revision,
      operationId: 'stale-plan-write',
    });
    expect(await engine.applyRestore({
      expectedRevision: prepared.plan.revision,
      mode: 'in-place',
      operationId: prepared.plan.id,
    })).toMatchObject({ status: 'failed', failure: { code: 'stale-plan' } });
    await expect(fs.promises.readFile(path.join(harness.workspaceRoot, 'note.txt'), 'utf8'))
      .resolves.toBe('changed-after-plan');

    expect(await engine.applyRestore({
      expectedRevision: prepared.plan.revision,
      mode: 'new-workspace',
      newWorkspacePath: destination,
      operationId: prepared.plan.id,
    })).toMatchObject({ status: 'ready', operation: { state: 'complete' } });
    await expect(fs.promises.readFile(path.join(destination, 'note.txt'), 'utf8')).resolves.toBe('target');
  });

  it('coordinates an in-place workspace restore with one durable expected-leaf navigation', async () => {
    const navigation = {
      commit: vi.fn(async () => ({
        alreadyApplied: false,
        editorText: 'target prompt',
        navigationMarkerId: 'navigation-marker-1',
      })),
      prepare: vi.fn(async () => ({ expectedLeafId: 'current-leaf', targetLeafId: null })),
    };
    const { engine, harness } = await createHarness({ sessionNavigation: navigation });
    await fs.promises.writeFile(path.join(harness.workspaceRoot, 'note.txt'), 'target');
    const before = await engine.captureSnapshot({ source: 'turn-before', workspaceId: harness.identity.workspaceId });
    await engine.recordTurnStart({
      activeWriterScopes: [],
      beforeSnapshotId: before.snapshot.id,
      executionId: 'combined-execution-1',
      provenance: 'caused-by',
      runtimeGeneration: 1,
      sessionId: 'combined-session-1',
      userEntryId: 'combined-user-1',
      workerId: 'combined-worker-1',
      workspaceId: harness.identity.workspaceId,
    });
    const current = await harness.authority.read(harness.resource('note.txt'));
    await harness.authority.write({
      token: harness.token(),
      resource: harness.resource('note.txt'),
      content: 'current',
      encoding: 'utf-8',
      bom: false,
      expectedRevision: current.revision,
      operationId: 'combined-current-write',
    });

    const prepared = await engine.prepareCombinedRecovery({
      entryId: 'combined-user-1',
      sessionId: 'combined-session-1',
      workspaceId: harness.identity.workspaceId,
    });
    expect(prepared).toMatchObject({
      status: 'ready',
      plan: { allowedModes: ['in-place', 'new-workspace'], expectedLeafId: 'current-leaf', targetLeafId: null },
    });
    const applied = await engine.applyCombinedRecovery({
      expectedRevision: prepared.plan.revision,
      operationId: prepared.plan.id,
    });
    expect(applied).toMatchObject({
      status: 'ready',
      operation: {
        conversationState: 'navigated',
        editorText: 'target prompt',
        navigationMarkerId: 'navigation-marker-1',
        state: 'complete',
        workspaceState: 'restored',
      },
    });
    await expect(fs.promises.readFile(path.join(harness.workspaceRoot, 'note.txt'), 'utf8')).resolves.toBe('target');
    expect((await harness.authority.inspectMutation(harness.identity.workspaceId)).maintenance).toBe(false);
    expect(navigation.commit).toHaveBeenCalledWith(expect.objectContaining({
      expectedLeafId: 'current-leaf',
      operationId: prepared.plan.id,
      preparedTargetLeafId: null,
      targetId: 'combined-user-1',
    }));
  });

  it('restores the safety checkpoint when expected-leaf navigation loses its race', async () => {
    const navigationError = Object.assign(new Error('leaf changed'), { code: 'session_leaf_conflict' });
    const simulatedCrash = Object.assign(new Error('compensation process crashed'), { simulatedCrash: true });
    let crashAfterCompensation = true;
    const faults = {
      afterCompensationOperation: () => {
        if (!crashAfterCompensation) return;
        crashAfterCompensation = false;
        throw simulatedCrash;
      },
    };
    const navigation = {
      commit: vi.fn(async () => { throw navigationError; }),
      prepare: vi.fn(async () => ({ expectedLeafId: 'current-leaf', targetLeafId: 'assistant-target' })),
    };
    const { engine, harness } = await createHarness({ faults, sessionNavigation: navigation });
    await fs.promises.writeFile(path.join(harness.workspaceRoot, 'note.txt'), 'target');
    const before = await engine.captureSnapshot({ source: 'turn-before', workspaceId: harness.identity.workspaceId });
    await engine.recordTurnStart({
      activeWriterScopes: [], beforeSnapshotId: before.snapshot.id, executionId: 'combined-execution-2',
      provenance: 'caused-by', runtimeGeneration: 1, sessionId: 'combined-session-2',
      userEntryId: 'combined-user-2', workerId: 'combined-worker-2', workspaceId: harness.identity.workspaceId,
    });
    const current = await harness.authority.read(harness.resource('note.txt'));
    await harness.authority.write({
      token: harness.token(), resource: harness.resource('note.txt'), content: 'current', encoding: 'utf-8',
      bom: false, expectedRevision: current.revision, operationId: 'combined-current-write-2',
    });
    const prepared = await engine.prepareCombinedRecovery({
      entryId: 'combined-user-2', sessionId: 'combined-session-2', workspaceId: harness.identity.workspaceId,
    });
    expect(await engine.applyCombinedRecovery({
      expectedRevision: prepared.plan.revision,
      operationId: prepared.plan.id,
    })).toMatchObject({ status: 'failed', failure: { code: 'internal' } });
    expect((await harness.authority.inspectMutation(harness.identity.workspaceId)).maintenance).toBe(true);
    const resumedEngine = createWorkspaceRecoveryEngine({
      authorityId: harness.authority.hostId,
      dataDir: harness.dataDir,
      documents: harness.authority,
      faults,
      sessionNavigation: navigation,
    });
    await resumedEngine.fenceUnfinishedOperations();
    await resumedEngine.resumeWorkspaceOperations();
    await resumedEngine.resumeCombinedOperations();
    expect(await resumedEngine.getCombinedOperation(prepared.plan.id)).toMatchObject({
      status: 'ready',
      operation: {
        conversationState: 'unchanged',
        failure: { code: 'navigation-conflict' },
        state: 'compensated',
        workspaceState: 'compensated',
      },
    });
    await expect(fs.promises.readFile(path.join(harness.workspaceRoot, 'note.txt'), 'utf8')).resolves.toBe('current');
    expect((await harness.authority.inspectMutation(harness.identity.workspaceId)).maintenance).toBe(false);
  });

  it('prepares a completed combined recovery undo from its pinned safety checkpoint', async () => {
    let activeLeaf = 'original-leaf';
    const navigation = {
      commit: vi.fn(async () => {
        activeLeaf = 'recovery-marker';
        return { alreadyApplied: false, markerId: activeLeaf };
      }),
      commitLeaf: vi.fn(async ({ preparedTargetLeafId }) => {
        expect(preparedTargetLeafId).toBe('original-leaf');
        activeLeaf = 'undo-marker';
        return { alreadyApplied: false, markerId: activeLeaf };
      }),
      prepare: vi.fn(async () => ({ expectedLeafId: activeLeaf, targetLeafId: null })),
      prepareLeaf: vi.fn(async ({ targetLeafId }) => ({ expectedLeafId: activeLeaf, targetLeafId })),
    };
    const { engine, harness } = await createHarness({ sessionNavigation: navigation });
    await fs.promises.writeFile(path.join(harness.workspaceRoot, 'note.txt'), 'target');
    const before = await engine.captureSnapshot({ source: 'turn-before', workspaceId: harness.identity.workspaceId });
    await engine.recordTurnStart({
      activeWriterScopes: [], beforeSnapshotId: before.snapshot.id, executionId: 'combined-execution-undo',
      provenance: 'caused-by', runtimeGeneration: 1, sessionId: 'combined-session-undo',
      userEntryId: 'combined-user-undo', workerId: 'combined-worker-undo', workspaceId: harness.identity.workspaceId,
    });
    const current = await harness.authority.read(harness.resource('note.txt'));
    await harness.authority.write({
      token: harness.token(), resource: harness.resource('note.txt'), content: 'current', encoding: 'utf-8',
      bom: false, expectedRevision: current.revision, operationId: 'combined-current-write-undo',
    });
    const prepared = await engine.prepareCombinedRecovery({
      entryId: 'combined-user-undo', sessionId: 'combined-session-undo', workspaceId: harness.identity.workspaceId,
    });
    expect(await engine.applyCombinedRecovery({
      expectedRevision: prepared.plan.revision,
      operationId: prepared.plan.id,
    })).toMatchObject({ status: 'ready', operation: { state: 'complete' } });
    await expect(fs.promises.readFile(path.join(harness.workspaceRoot, 'note.txt'), 'utf8')).resolves.toBe('target');

    const undo = await engine.prepareCombinedUndo(prepared.plan.id);
    expect(undo).toMatchObject({
      status: 'ready',
      plan: {
        expectedLeafId: 'recovery-marker',
        navigationKind: 'leaf',
        targetLeafId: 'original-leaf',
        undoOf: prepared.plan.id,
      },
    });
    expect(await engine.applyCombinedRecovery({
      expectedRevision: undo.plan.revision,
      operationId: undo.plan.id,
    })).toMatchObject({
      status: 'ready',
      operation: { state: 'complete', undoOf: prepared.plan.id },
    });
    await expect(fs.promises.readFile(path.join(harness.workspaceRoot, 'note.txt'), 'utf8')).resolves.toBe('current');
    expect(activeLeaf).toBe('undo-marker');
  });

  it('materializes a new-workspace fallback without navigating the current conversation', async () => {
    const navigation = {
      commit: vi.fn(),
      prepare: vi.fn(async () => ({ expectedLeafId: 'current-leaf', targetLeafId: null })),
    };
    const { engine, harness } = await createHarness({ sessionNavigation: navigation });
    await fs.promises.writeFile(path.join(harness.workspaceRoot, 'note.txt'), 'target');
    const before = await engine.captureSnapshot({ source: 'turn-before', workspaceId: harness.identity.workspaceId });
    await engine.recordTurnStart({
      activeWriterScopes: [], beforeSnapshotId: before.snapshot.id, executionId: 'combined-execution-new',
      provenance: 'caused-by', runtimeGeneration: 1, sessionId: 'combined-session-new',
      userEntryId: 'combined-user-new', workerId: 'combined-worker-new', workspaceId: harness.identity.workspaceId,
    });
    const current = await harness.authority.read(harness.resource('note.txt'));
    await harness.authority.write({
      token: harness.token(), resource: harness.resource('note.txt'), content: 'current', encoding: 'utf-8',
      bom: false, expectedRevision: current.revision, operationId: 'combined-current-write-new',
    });
    const writer = await harness.authority.registerWriter(harness.token(), { purpose: 'fallback-writer' });
    const destination = path.join(harness.root, 'combined-new-workspace');
    try {
      const prepared = await engine.prepareCombinedRecovery({
        entryId: 'combined-user-new', newWorkspacePath: destination,
        sessionId: 'combined-session-new', workspaceId: harness.identity.workspaceId,
      });
      expect(prepared).toMatchObject({ status: 'ready', plan: { allowedModes: ['new-workspace'] } });
      expect(await engine.applyCombinedRecovery({
        expectedRevision: prepared.plan.revision,
        mode: 'new-workspace',
        newWorkspacePath: destination,
        operationId: prepared.plan.id,
      })).toMatchObject({
        status: 'ready',
        operation: {
          conversationState: 'unchanged',
          destinationPath: destination,
          state: 'alternate-ready',
          workspaceState: 'materialized-new',
        },
      });
    } finally {
      await writer.close();
    }
    await expect(fs.promises.readFile(path.join(destination, 'note.txt'), 'utf8')).resolves.toBe('target');
    await expect(fs.promises.readFile(path.join(harness.workspaceRoot, 'note.txt'), 'utf8')).resolves.toBe('current');
    expect(navigation.commit).not.toHaveBeenCalled();
  });

  it('resumes conversation navigation without reapplying an already verified workspace', async () => {
    let failNavigation = true;
    const navigation = {
      commit: vi.fn(async () => {
        if (failNavigation) throw Object.assign(new Error('worker disconnected'), { code: 'worker_unavailable' });
        return { alreadyApplied: true, navigationMarkerId: 'navigation-marker-resumed' };
      }),
      prepare: vi.fn(async () => ({ expectedLeafId: 'current-leaf', targetLeafId: null })),
    };
    const { engine, harness } = await createHarness({ sessionNavigation: navigation });
    await fs.promises.writeFile(path.join(harness.workspaceRoot, 'note.txt'), 'target');
    const before = await engine.captureSnapshot({ source: 'turn-before', workspaceId: harness.identity.workspaceId });
    await engine.recordTurnStart({
      activeWriterScopes: [], beforeSnapshotId: before.snapshot.id, executionId: 'combined-execution-3',
      provenance: 'caused-by', runtimeGeneration: 1, sessionId: 'combined-session-3',
      userEntryId: 'combined-user-3', workerId: 'combined-worker-3', workspaceId: harness.identity.workspaceId,
    });
    const current = await harness.authority.read(harness.resource('note.txt'));
    await harness.authority.write({
      token: harness.token(), resource: harness.resource('note.txt'), content: 'current', encoding: 'utf-8',
      bom: false, expectedRevision: current.revision, operationId: 'combined-current-write-3',
    });
    const prepared = await engine.prepareCombinedRecovery({
      entryId: 'combined-user-3', sessionId: 'combined-session-3', workspaceId: harness.identity.workspaceId,
    });
    expect(await engine.applyCombinedRecovery({
      expectedRevision: prepared.plan.revision,
      operationId: prepared.plan.id,
    })).toMatchObject({ status: 'failed', failure: { code: 'recovery-in-progress', retryable: true } });
    expect((await harness.authority.inspectMutation(harness.identity.workspaceId)).maintenance).toBe(true);
    failNavigation = false;
    const resumedEngine = createWorkspaceRecoveryEngine({
      authorityId: harness.authority.hostId,
      dataDir: harness.dataDir,
      documents: harness.authority,
      sessionNavigation: navigation,
    });
    expect(await resumedEngine.fenceUnfinishedOperations()).toContain(prepared.plan.restore.id);
    await resumedEngine.resumeWorkspaceOperations();
    expect(await resumedEngine.resumeCombinedOperations())
      .toEqual([expect.objectContaining({ state: 'complete' })]);
    expect(await resumedEngine.getCombinedOperation(prepared.plan.id))
      .toMatchObject({ status: 'ready', operation: { state: 'complete' } });
    expect(navigation.commit).toHaveBeenCalledTimes(2);
    await expect(fs.promises.readFile(path.join(harness.workspaceRoot, 'note.txt'), 'utf8')).resolves.toBe('target');
    expect((await harness.authority.inspectMutation(harness.identity.workspaceId)).maintenance).toBe(false);
  });

  it('downgrades active-writer plans to new-workspace and cancels only before commit', async () => {
    const { engine, harness } = await createHarness();
    await fs.promises.writeFile(path.join(harness.workspaceRoot, 'note.txt'), 'target');
    const target = await engine.captureSnapshot({ workspaceId: harness.identity.workspaceId });
    await harness.authority.publishDirtyBuffers({
      generation: 1,
      ownerId: 'surface-dirty',
      resources: [{ baseRevision: null, localEditRevision: 1, resource: harness.resource('draft.txt') }],
      workspaceId: harness.identity.workspaceId,
    });
    const writer = await harness.authority.registerWriter(harness.token(), { purpose: 'other-session' });
    try {
      const prepared = await engine.prepareRestore({
        targetSnapshotId: target.snapshot.id,
        workspaceId: harness.identity.workspaceId,
      });
      expect(prepared).toMatchObject({
        status: 'ready',
        plan: {
          allowedModes: ['new-workspace'],
          conflicts: expect.arrayContaining([
            expect.objectContaining({ code: 'active-writer' }),
            expect.objectContaining({ code: 'dirty-buffers' }),
          ]),
          recommendedMode: 'new-workspace',
        },
      });
      const cancelled = await engine.cancelOperation(prepared.plan.id);
      expect(cancelled).toMatchObject({ status: 'ready', operation: { state: 'aborted' } });
      expect(await engine.applyRestore({
        expectedRevision: prepared.plan.revision,
        mode: 'new-workspace',
        operationId: prepared.plan.id,
      })).toMatchObject({ status: 'failed', failure: { code: 'recovery-in-progress' } });
    } finally {
      await writer.close();
    }
  });
});
