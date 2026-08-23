import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { createSettingsFileStore } from './index.js';

const roots = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fsPromises.rm(root, { force: true, recursive: true })));
});

const createStore = async () => {
  const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'piarium-settings-store-'));
  roots.push(root);
  const filePath = path.join(root, 'settings.json');
  return { filePath, store: createSettingsFileStore({ filePath }) };
};

describe('settings file store', () => {
  it('distinguishes a missing file from malformed persisted state', async () => {
    const { filePath, store } = await createStore();
    assert.deepEqual(await store.read(), {});
    assert.deepEqual(store.readSync(), {});

    await fsPromises.writeFile(filePath, '{"broken":', 'utf8');
    await assert.rejects(store.read(), SyntaxError);
    assert.throws(() => store.readSync(), SyntaxError);
  });

  it('serializes updates from independent store instances without losing fields', async () => {
    const { filePath, store } = await createStore();
    const second = createSettingsFileStore({ filePath });

    await Promise.all([
      store.update(async (current) => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { ...current, alpha: 1 };
      }),
      second.update((current) => ({ ...current, beta: 2 })),
    ]);

    assert.deepEqual(await store.read(), { alpha: 1, beta: 2 });
    assert.equal(fs.existsSync(`${filePath}.lock`), false);
  });

  it('reads the last complete document when replacement was interrupted', async () => {
    const { filePath, store } = await createStore();
    await fsPromises.writeFile(`${filePath}.previous`, '{"preserved":true}', 'utf8');

    assert.deepEqual(await store.read(), { preserved: true });
    assert.deepEqual(store.readSync(), { preserved: true });
  });

  it('writes private directory and file modes', { skip: process.platform === 'win32' }, async () => {
    const { filePath, store } = await createStore();
    await store.replace({ value: true });

    assert.equal((await fsPromises.stat(path.dirname(filePath))).mode & 0o777, 0o700);
    assert.equal((await fsPromises.stat(filePath)).mode & 0o777, 0o600);
  });
});
