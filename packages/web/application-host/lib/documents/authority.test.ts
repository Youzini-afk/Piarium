import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDocumentAuthority,
  type DocumentAuthority,
  type DocumentAuthorityOptions,
} from './authority.js';
import {
  createDocumentAuthorityHarness,
  defineDocumentAuthorityContract,
  type DocumentAuthorityHarness,
} from './contract-fixtures.js';
import type { WatchPosition, WorkspaceWatchFs } from './watch.js';

defineDocumentAuthorityContract({ describe, it, expect, beforeEach, afterEach });

it('assigns a nested runtime root its own workspace identity', async () => {
  const harness = await createDocumentAuthorityHarness();
  try {
    const nestedRoot = path.join(harness.workspaceRoot, '.piarium', 'threads', 'child-worktree');
    await fs.promises.mkdir(nestedRoot, { recursive: true });
    const nested = await harness.authority.resolveWorkspace({ path: nestedRoot });
    expect(nested.workspaceId).not.toBe(harness.identity.workspaceId);
    await expect(harness.authority.inspectWorkspace(nested.workspaceId)).resolves.toMatchObject({
      root: await fs.promises.realpath(nestedRoot),
    });
  } finally {
    await harness.cleanup();
  }
});

it('publishes committed document mutations without letting an observer fail the write', async () => {
  const events: Array<{ resourceId: string; kind: string; owner: { kind: string } }> = [];
  const harness = await createDocumentAuthorityHarness({
    authority: {
      onMutation: (event) => {
        events.push(event);
        throw new Error('observer unavailable');
      },
    },
  });
  try {
    const result = await harness.authority.write({
      resource: harness.resource('observed.ts'),
      token: harness.token(undefined, { kind: 'web-route', id: 'editor' }),
      content: 'export const observed = true;\n',
      encoding: 'utf-8',
      bom: false,
      expectedRevision: null,
      operationId: randomUUID(),
    });
    expect(result.status).toBe('written');
    expect(events).toMatchObject([{ resourceId: 'observed.ts', kind: 'created', owner: { kind: 'web-route' } }]);
  } finally {
    await harness.cleanup();
  }
});

it('queues a document mutation behind a Host subtree operation without locking unrelated paths', async () => {
  const harness = await createDocumentAuthorityHarness();
  let releaseDirectory: (() => void) | undefined;
  let announceDirectory: (() => void) | undefined;
  const directoryStarted = new Promise<void>((resolve) => { announceDirectory = resolve; });
  const directoryRelease = new Promise<void>((resolve) => { releaseDirectory = resolve; });
  try {
    const held = harness.authority.runResourceOperation(
      harness.identity.workspaceId,
      [{ resourceId: 'nested', scope: 'subtree' }],
      async () => {
        announceDirectory?.();
        await directoryRelease;
      },
    );
    await directoryStarted;
    let nestedSettled = false;
    const nested = harness.authority.write({
      resource: harness.resource('nested/note.txt'),
      token: harness.token(),
      content: 'nested',
      encoding: 'utf-8',
      bom: false,
      expectedRevision: null,
    }).finally(() => { nestedSettled = true; });
    const unrelated = harness.authority.write({
      resource: harness.resource('other.txt'),
      token: harness.token(),
      content: 'unrelated',
      encoding: 'utf-8',
      bom: false,
      expectedRevision: null,
    });
    await expect(unrelated).resolves.toMatchObject({ status: 'written' });
    expect(nestedSettled).toBe(false);
    releaseDirectory?.();
    await held;
    await expect(nested).resolves.toMatchObject({ status: 'written' });
  } finally {
    releaseDirectory?.();
    await harness.cleanup();
  }
});

it('uses one Host resource queue for Windows case aliases', async () => {
  if (process.platform !== 'win32') return;
  const harness = await createDocumentAuthorityHarness();
  let release: (() => void) | undefined;
  let announce: (() => void) | undefined;
  const started = new Promise<void>((resolve) => { announce = resolve; });
  const heldUntil = new Promise<void>((resolve) => { release = resolve; });
  try {
    await fs.promises.writeFile(path.join(harness.workspaceRoot, 'Case-Alias.txt'), 'base');
    const original = await harness.authority.read(harness.resource('Case-Alias.txt'));
    if (original.status !== 'ready') throw new Error('Expected the case-alias fixture to be readable');
    const held = harness.authority.runResourceOperation(
      harness.identity.workspaceId,
      [{ resourceId: 'Case-Alias.txt', scope: 'exact' }],
      async () => {
        announce?.();
        await heldUntil;
      },
    );
    await started;
    let settled = false;
    const aliasedWrite = harness.authority.write({
      resource: harness.resource('CASE-ALIAS.TXT'),
      token: harness.token(),
      content: 'updated',
      encoding: 'utf-8',
      bom: false,
      expectedRevision: original.revision,
    }).finally(() => { settled = true; });
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    release?.();
    await held;
    await expect(aliasedWrite).resolves.toMatchObject({ status: 'written' });
  } finally {
    release?.();
    await harness.cleanup();
  }
});

const createPeerAuthority = (
  harness: DocumentAuthorityHarness,
  options: Partial<Omit<DocumentAuthorityOptions, 'dataDir' | 'hostId'>> = {},
): DocumentAuthority => createDocumentAuthority({
  hostId: harness.authority.hostId,
  dataDir: harness.dataDir,
  isTrusted: async () => true,
  isAllowedRoot: async () => true,
  ...options,
});

it('keeps a persisted workspace identity available while its root is temporarily offline', async () => {
  const harness = await createDocumentAuthorityHarness();
  const offlineRoot = `${harness.workspaceRoot}.offline`;
  let peer: DocumentAuthority | undefined;
  try {
    await fs.promises.rename(harness.workspaceRoot, offlineRoot);
    peer = createPeerAuthority(harness);
    const onlineRoot = path.join(harness.root, 'online-workspace');
    await fs.promises.mkdir(onlineRoot);

    await expect(peer.resolveWorkspace({ workspaceId: harness.identity.workspaceId })).resolves.toMatchObject({
      workspaceId: harness.identity.workspaceId,
      hostId: harness.identity.hostId,
      epoch: harness.identity.epoch,
    });
    await expect(peer.inspectWorkspace(harness.identity.workspaceId)).rejects.toMatchObject({
      code: 'workspace-unavailable',
      statusCode: 503,
    });
    const onlineIdentity = await peer.resolveWorkspace({ path: onlineRoot });
    expect(onlineIdentity.workspaceId).not.toBe(harness.identity.workspaceId);
    await expect(peer.inspectWorkspace(onlineIdentity.workspaceId)).resolves.toMatchObject({
      root: await fs.promises.realpath(onlineRoot),
    });

    await fs.promises.rename(offlineRoot, harness.workspaceRoot);
    await expect(peer.inspectWorkspace(harness.identity.workspaceId)).resolves.toMatchObject({
      workspaceId: harness.identity.workspaceId,
      root: await fs.promises.realpath(harness.workspaceRoot),
    });
  } finally {
    if (fs.existsSync(offlineRoot) && !fs.existsSync(harness.workspaceRoot)) {
      await fs.promises.rename(offlineRoot, harness.workspaceRoot);
    }
    await Promise.allSettled([peer?.dispose(), harness.cleanup()]);
  }
});

it('keeps an admitted workspace usable after the mutable root selection changes', async () => {
  const harness = await createDocumentAuthorityHarness();
  const peer = createPeerAuthority(harness, { isAllowedRoot: async () => false });
  const unregisteredRoot = path.join(harness.root, 'unregistered-workspace');
  try {
    await fs.promises.mkdir(unregisteredRoot);

    await expect(peer.inspectWorkspace(harness.identity.workspaceId)).resolves.toMatchObject({
      workspaceId: harness.identity.workspaceId,
      root: await fs.promises.realpath(harness.workspaceRoot),
    });
    await expect(peer.resolveWorkspace({ path: unregisteredRoot })).rejects.toMatchObject({
      code: 'path-escape',
      statusCode: 403,
    });
  } finally {
    await Promise.allSettled([peer.dispose(), harness.cleanup()]);
  }
});

it('notifies a workspace observer after a path receives its Host identity', async () => {
  const harness = await createDocumentAuthorityHarness();
  const onWorkspaceResolved = vi.fn();
  const peer = createPeerAuthority(harness, { onWorkspaceResolved });
  try {
    const resolved = await peer.resolveWorkspace({ path: harness.workspaceRoot });
    await vi.waitFor(() => expect(onWorkspaceResolved).toHaveBeenCalledWith(resolved));
  } finally {
    await Promise.allSettled([peer.dispose(), harness.cleanup()]);
  }
});

it('rejects a registered path whose canonical filesystem identity changes', async () => {
  const harness = await createDocumentAuthorityHarness();
  const replacementRoot = path.join(harness.root, 'replacement-workspace');
  const registeredRoot = await fs.promises.realpath(harness.workspaceRoot);
  await fs.promises.mkdir(replacementRoot);
  const replacementCanonicalRoot = await fs.promises.realpath(replacementRoot);
  const fsPromises = new Proxy(fs.promises, {
    get(target, property, receiver) {
      if (property === 'realpath') return async (value: fs.PathLike) => (
        path.resolve(String(value)) === path.resolve(registeredRoot)
        ? replacementCanonicalRoot
        : fs.promises.realpath(value)
      );
      const member = Reflect.get(target, property, receiver) as unknown;
      return typeof member === 'function' ? member.bind(target) : member;
    },
  });
  const peer = createPeerAuthority(harness, { fsPromises });
  try {
    await expect(peer.inspectWorkspace(harness.identity.workspaceId)).rejects.toMatchObject({
      code: 'untrusted',
      statusCode: 403,
    });
  } finally {
    await Promise.allSettled([peer.dispose(), harness.cleanup()]);
  }
});

it('coordinates writer, maintenance, and epoch fencing across authority instances', async () => {
  const harness = await createDocumentAuthorityHarness();
  const peer = createPeerAuthority(harness);
  try {
    const writer = await harness.authority.registerWriter(harness.token(), { purpose: 'cross-instance-writer' });
    await expect(peer.advanceEpoch(harness.identity.workspaceId, { maintenance: false }))
      .rejects.toMatchObject({ code: 'active-writer', currentEpoch: harness.identity.epoch });

    await peer.setMaintenance(harness.identity.workspaceId, true);
    await expect(harness.authority.registerWriter(harness.token(), { purpose: 'maintenance-rejected' }))
      .rejects.toMatchObject({ code: 'maintenance', currentEpoch: harness.identity.epoch });

    await writer.close();
    const advanced = await peer.advanceEpoch(harness.identity.workspaceId, { maintenance: false });
    expect(advanced.epoch).toBe(harness.identity.epoch + 1);
    const stalePath = path.join(harness.workspaceRoot, 'stale-token.txt');
    expect(await harness.authority.write({
      token: harness.token(),
      resource: harness.resource('stale-token.txt'),
      content: 'must not write',
      encoding: 'utf-8',
      bom: false,
      expectedRevision: null,
    })).toEqual({ status: 'stale-epoch', currentEpoch: advanced.epoch });
    await expect(fs.promises.stat(stalePath)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await Promise.allSettled([peer.dispose(), harness.cleanup()]);
  }
});

it('keeps maintenance process-owned and releases it during authority shutdown', async () => {
  const harness = await createDocumentAuthorityHarness();
  const peer = createPeerAuthority(harness);
  try {
    await harness.authority.setMaintenance(harness.identity.workspaceId, true);
    await expect(peer.setMaintenance(harness.identity.workspaceId, false))
      .rejects.toMatchObject({ code: 'maintenance' });

    await harness.authority.dispose();
    await expect(peer.inspectMutation(harness.identity.workspaceId))
      .resolves.toMatchObject({ maintenance: false });
  } finally {
    await Promise.allSettled([peer.dispose(), harness.cleanup()]);
  }
});

it('reclaims maintenance owned by a terminated Host process', async () => {
  const firstProcess = { pid: 41001, platform: process.platform, kill: () => true as const };
  const harness = await createDocumentAuthorityHarness({ authority: { processLike: firstProcess } });
  const terminatedProcessView = {
    pid: 41002,
    platform: process.platform,
    kill: () => {
      throw Object.assign(new Error('process does not exist'), { code: 'ESRCH' });
    },
  };
  const peer = createPeerAuthority(harness, { processLike: terminatedProcessView });
  try {
    await harness.authority.setMaintenance(harness.identity.workspaceId, true);
    await expect(peer.inspectMutation(harness.identity.workspaceId))
      .resolves.toMatchObject({ maintenance: false });
  } finally {
    await Promise.allSettled([peer.dispose(), harness.cleanup()]);
  }
});

it('migrates ownerless v2 maintenance to an unlocked process-owned state', async () => {
  const harness = await createDocumentAuthorityHarness();
  let restarted: DocumentAuthority | undefined;
  try {
    await harness.authority.dispose();
    const statePath = path.join(harness.dataDir, 'documents', 'mutation-authority.json');
    const stored = JSON.parse(await fs.promises.readFile(statePath, 'utf8')) as {
      schemaVersion: number;
      workspaces: Record<string, { maintenance: boolean; maintenanceOwner?: unknown }>;
    };
    const workspace = stored.workspaces[harness.identity.workspaceId];
    if (!workspace) throw new Error('Expected stored workspace mutation state');
    stored.schemaVersion = 2;
    workspace.maintenance = true;
    delete workspace.maintenanceOwner;
    await fs.promises.writeFile(statePath, JSON.stringify(stored));

    restarted = createPeerAuthority(harness);
    await expect(restarted.inspectMutation(harness.identity.workspaceId))
      .resolves.toMatchObject({ maintenance: false });
    const migrated = JSON.parse(await fs.promises.readFile(statePath, 'utf8'));
    expect(migrated).toMatchObject({
      schemaVersion: 3,
      workspaces: {
        [harness.identity.workspaceId]: { maintenance: false, maintenanceOwner: null },
      },
    });
  } finally {
    await Promise.allSettled([restarted?.dispose(), harness.cleanup()]);
  }
});

it('dispose removes only its authority instance writers from durable state', async () => {
  const harness = await createDocumentAuthorityHarness();
  const peer = createPeerAuthority(harness);
  try {
    await harness.authority.registerWriter(harness.token(), { purpose: 'disposed-instance' });
    const peerWriter = await peer.registerWriter(harness.token(), { purpose: 'retained-peer' });
    await harness.authority.dispose();

    const afterDispose = await peer.inspectMutation(harness.identity.workspaceId);
    expect(afterDispose.activeWriters.map((writer) => writer.purpose)).toEqual(['retained-peer']);
    await expect(peer.advanceEpoch(harness.identity.workspaceId, { maintenance: false }))
      .rejects.toMatchObject({ code: 'active-writer' });
    await peerWriter.close();
    const advanced = await peer.advanceEpoch(harness.identity.workspaceId, { maintenance: false });
    expect(advanced.epoch).toBe(harness.identity.epoch + 1);
  } finally {
    await Promise.allSettled([peer.dispose(), harness.cleanup()]);
  }
});

it('uses a fresh watch source as the baseline after each watcher rebuild', async () => {
  const harness = await createDocumentAuthorityHarness();
  try {
    const firstCapture = await harness.authority.beginCapture(harness.identity.workspaceId);
    const firstResult = await harness.authority.completeCapture(firstCapture);
    expect(firstResult.stable).toBe(true);

    await fs.promises.writeFile(path.join(harness.workspaceRoot, 'between-captures.txt'), 'fresh source');
    const secondCapture = await harness.authority.beginCapture(harness.identity.workspaceId);
    const secondResult = await harness.authority.completeCapture(secondCapture);
    expect(secondResult.stable).toBe(true);
    const firstWatch = firstCapture.watch as WatchPosition | null;
    const secondWatch = secondCapture.watch as WatchPosition | null;
    const resultWatch = secondResult.state.watch as WatchPosition | null;
    if (!firstWatch || !secondWatch || !resultWatch) throw new Error('Expected capture watch positions');
    expect(secondWatch.sourceId).not.toBe(firstWatch.sourceId);
    expect(resultWatch.sourceId).toBe(secondWatch.sourceId);
  } finally {
    await harness.cleanup();
  }
});

it('allows only an explicit restore capture to validate under maintenance', async () => {
  const harness = await createDocumentAuthorityHarness();
  try {
    await harness.authority.setMaintenance(harness.identity.workspaceId, true);
    const ordinary = await harness.authority.beginCapture(harness.identity.workspaceId);
    expect(await harness.authority.completeCapture(ordinary)).toMatchObject({
      stable: false,
      reasons: expect.arrayContaining(['maintenance']),
    });
    const restore = await harness.authority.beginCapture(harness.identity.workspaceId, {
      allowMaintenance: true,
    });
    expect(await harness.authority.completeCapture(restore)).toMatchObject({ stable: true, reasons: [] });
    await harness.authority.setMaintenance(harness.identity.workspaceId, false);
  } finally {
    await harness.cleanup();
  }
});

it('coordinates a dirty-state barrier with every connected document surface', async () => {
  const harness = await createDocumentAuthorityHarness();
  const events: Record<string, unknown>[] = [];
  const surface = harness.authority.registerDirtySurface({
    generation: 7,
    ownerId: 'surface-1',
    workspaceId: harness.identity.workspaceId,
  }, (event) => {
    if (event && typeof event === 'object' && !Array.isArray(event)) {
      events.push(event as Record<string, unknown>);
    }
  });
  try {
    const pending = harness.authority.beginDirtyStateBarrier(
      harness.identity.workspaceId,
      ['note.txt'],
    );
    await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({
      action: 'acquire',
      kind: 'dirty-state-barrier',
      paths: ['note.txt'],
    })));
    const acquire = events.find((event) => event.action === 'acquire');
    if (!acquire || typeof acquire.barrierId !== 'string') throw new Error('Expected dirty-state acquire event');
    expect(await harness.authority.acknowledgeDirtyStateBarrier({
      barrierId: acquire.barrierId,
      generation: 7,
      ownerId: 'surface-1',
      workspaceId: harness.identity.workspaceId,
    })).toEqual({ acknowledged: false });
    await harness.authority.publishDirtyBuffers({
      generation: 7,
      ownerId: 'surface-1',
      resources: [{
        baseRevision: null,
        localEditRevision: 3,
        resource: harness.resource('note.txt'),
      }],
      workspaceId: harness.identity.workspaceId,
    });
    expect(await harness.authority.acknowledgeDirtyStateBarrier({
      barrierId: acquire.barrierId,
      generation: 7,
      ownerId: 'surface-1',
      workspaceId: harness.identity.workspaceId,
    })).toEqual({ acknowledged: true });
    const barrier = await pending;
    expect(await harness.authority.inspectDirtyBuffers(harness.identity.workspaceId))
      .toMatchObject([{ ownerId: 'surface-1', resources: [{ localEditRevision: 3 }] }]);
    await barrier.release();
    expect(events).toContainEqual(expect.objectContaining({
      action: 'release',
      barrierId: acquire.barrierId,
    }));
  } finally {
    surface.close();
    await harness.cleanup();
  }
});

it('closes an asynchronously started obsolete watcher after close and reopen', async () => {
  let gate = false;
  const releases: Array<() => void> = [];
  let starts = 0;
  let closes = 0;
  const fsModule: WorkspaceWatchFs = {
    watch(rootPath, options, listener) {
      starts += 1;
      const watcher = fs.watch(rootPath, options, listener);
      const close = watcher.close.bind(watcher);
      let closed = false;
      watcher.close = () => {
        if (!closed) {
          closed = true;
          closes += 1;
        }
        return close();
      };
      return watcher;
    },
  };
  const harness = await createDocumentAuthorityHarness({
    authority: {
      fsModule,
      isTrusted: async () => {
        if (gate) await new Promise<void>((resolve) => releases.push(resolve));
        return true;
      },
    },
  });
  try {
    gate = true;
    const obsolete = harness.authority.watch(harness.identity.workspaceId, () => undefined);
    obsolete.close();
    const current = harness.authority.watch(harness.identity.workspaceId, () => undefined);
    while (releases.length < 2) await new Promise((resolve) => setTimeout(resolve, 0));
    for (const release of releases.splice(0)) release();
    while (starts < 2 || closes < 1 || !harness.authority.hasWatch(harness.identity.workspaceId)) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    current.close();
    expect(closes).toBe(2);
  } finally {
    await harness.cleanup();
  }
});
