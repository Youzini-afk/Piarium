import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { HostEvent, HostEventData } from '@piarium/protocol';
import { SessionHost } from '../src/session-host.js';

describe('SessionHost parent sessions', () => {
  it('persists a newly created child session relationship in the Pi header', async () => {
    const root = await mkdtemp(join(tmpdir(), 'piarium-parent-session-'));
    const cwd = join(root, 'workspace');
    await mkdir(cwd, { recursive: true });
    const host = new SessionHost({
      agentDir: join(root, 'agent'),
      emit: <E extends HostEvent>(_event: E, _data: HostEventData<E>) => undefined,
      projectTrustOverride: true,
    });

    try {
      const original = await host.create(cwd, 'Implementation');
      assert.ok(original.sessionFile);
      const review = await host.create(cwd, 'Review: Implementation', original.sessionFile);
      assert.equal(host.header(review.sessionId)?.parentSession, original.sessionFile);
    } finally {
      await host.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
});
