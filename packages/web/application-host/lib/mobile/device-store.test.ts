import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createMobileDeviceStore } from './device-store.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

const createHarness = async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'piarium-mobile-devices-'));
  roots.push(root);
  const filePath = path.join(root, 'mobile-devices.json');
  const createStore = () => createMobileDeviceStore({ crypto, mobileDevicesFilePath: filePath });
  return { createStore, filePath };
};

describe('mobile device store', () => {
  it('persists a device token that another store instance can authenticate', async () => {
    const { createStore } = await createHarness();
    const created = await createStore().createDevice({ name: 'Phone', platform: 'ios' });

    await expect(createStore().authenticateDevice(created.device.id, created.deviceToken))
      .resolves.toMatchObject({ id: created.device.id, name: 'Phone', platform: 'ios' });
  });

  it('serializes independent writers without dropping either device', async () => {
    const { createStore } = await createHarness();
    const first = createStore();
    const second = createStore();

    await Promise.all([
      first.createDevice({ name: 'Phone A', platform: 'ios' }),
      second.createDevice({ name: 'Phone B', platform: 'android' }),
    ]);

    await expect(first.listDevices()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'Phone A' }),
      expect.objectContaining({ name: 'Phone B' }),
    ]));
  });

  it('preserves malformed persisted credentials instead of replacing them', async () => {
    const { createStore, filePath } = await createHarness();
    await fs.writeFile(filePath, '{"version":1,"devices":', 'utf8');

    await expect(createStore().createDevice({ name: 'Phone' })).rejects.toBeInstanceOf(SyntaxError);
    await expect(fs.readFile(filePath, 'utf8')).resolves.toBe('{"version":1,"devices":');
  });
});
