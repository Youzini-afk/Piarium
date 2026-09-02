import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createRecoveryWorkspaceLeaseManager } from './workspace-lease.js';

const makeRoot = async () => {
  const parent = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'piarium-recovery-lease-'));
  const root = path.join(parent, 'recovery', 'v1');
  await fs.promises.mkdir(root, { recursive: true });
  return { parent, root };
};

describe('recovery workspace lease', () => {
  it('allows concurrent journal readers and excludes a logical recovery writer', async () => {
    const { parent, root } = await makeRoot();
    const first = createRecoveryWorkspaceLeaseManager({
      processLike: { pid: 51001, platform: process.platform, kill: () => true },
    });
    const second = createRecoveryWorkspaceLeaseManager({
      processLike: { pid: 51002, platform: process.platform, kill: () => true },
    });
    try {
      const firstShared = await first.acquire({
        mode: 'shared', purpose: 'before-image', root, workspaceId: 'workspace-1',
      });
      const secondShared = await second.acquire({
        mode: 'shared', purpose: 'after-image', root, workspaceId: 'workspace-1',
      });
      await expect(second.acquire({
        mode: 'exclusive', purpose: 'restore', root, workspaceId: 'workspace-1',
      })).rejects.toMatchObject({ code: 'lease-unavailable', retryable: true });
      await firstShared.release();
      await secondShared.release();
      const exclusive = await second.acquire({
        mode: 'exclusive', purpose: 'restore', root, workspaceId: 'workspace-1',
      });
      await exclusive.release();
    } finally {
      await Promise.allSettled([first.dispose(), second.dispose()]);
      await fs.promises.rm(parent, { force: true, recursive: true });
    }
  });

  it('reclaims an exclusive lease only after the owning process is confirmed dead', async () => {
    const { parent, root } = await makeRoot();
    const first = createRecoveryWorkspaceLeaseManager({
      processLike: { pid: 52001, platform: process.platform, kill: () => true },
    });
    const second = createRecoveryWorkspaceLeaseManager({
      processLike: {
        pid: 52002,
        platform: process.platform,
        kill: () => {
          throw Object.assign(new Error('process does not exist'), { code: 'ESRCH' });
        },
      },
    });
    try {
      await first.acquire({ mode: 'exclusive', purpose: 'crashed-restore', root, workspaceId: 'workspace-1' });
      const replacement = await second.acquire({
        mode: 'exclusive', purpose: 'resume', root, workspaceId: 'workspace-1',
      });
      await replacement.release();
    } finally {
      await Promise.allSettled([first.dispose(), second.dispose()]);
      await fs.promises.rm(parent, { force: true, recursive: true });
    }
  });
});
