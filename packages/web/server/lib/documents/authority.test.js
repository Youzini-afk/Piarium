import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDocumentAuthority } from './authority.js';
import { createDocumentAuthorityHarness, defineDocumentAuthorityContract } from './contract-fixtures.js';

defineDocumentAuthorityContract({ describe, it, expect, beforeEach, afterEach });

const createPeerAuthority = (harness) => createDocumentAuthority({
  hostId: harness.authority.hostId,
  dataDir: harness.dataDir,
  isTrusted: async () => true,
  isAllowedRoot: async () => true,
});

it('keeps a persisted workspace identity available while its root is temporarily offline', async () => {
  const harness = await createDocumentAuthorityHarness();
  const offlineRoot = `${harness.workspaceRoot}.offline`;
  let peer;
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
    expect(secondCapture.watch.sourceId).not.toBe(firstCapture.watch.sourceId);
    expect(secondResult.state.watch.sourceId).toBe(secondCapture.watch.sourceId);
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

it('closes an asynchronously started obsolete watcher after close and reopen', async () => {
  let gate = false;
  const releases = [];
  let starts = 0;
  let closes = 0;
  const fsModule = {
    ...fs,
    watch(...args) {
      starts += 1;
      const watcher = fs.watch(...args);
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
        if (gate) await new Promise((resolve) => releases.push(resolve));
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
