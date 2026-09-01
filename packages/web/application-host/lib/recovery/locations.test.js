import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  readRecoveryJsonAtomic,
  writeRecoveryJsonAtomic,
} from './locations.js';

describe('atomic recovery JSON', () => {
  it('replaces an existing record through a preserved predecessor when direct overwrite is refused', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'piarium-recovery-json-'));
    const filePath = path.join(root, 'operation.json');
    await writeRecoveryJsonAtomic(filePath, { revision: 1 });
    let refused = false;
    const fsPromises = Object.create(fs.promises);
    fsPromises.rename = vi.fn(async (source, target) => {
      if (!refused && target === filePath && source.endsWith('.tmp')) {
        refused = true;
        throw Object.assign(new Error('replace refused'), { code: 'EPERM' });
      }
      return fs.promises.rename(source, target);
    });
    try {
      await writeRecoveryJsonAtomic(filePath, { revision: 2 }, { fsPromises });
      await expect(readRecoveryJsonAtomic(filePath)).resolves.toEqual({ revision: 2 });
      await expect(fs.promises.stat(`${filePath}.previous`)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });

  it('reads the preserved predecessor left by an interrupted replacement', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'piarium-recovery-json-'));
    const filePath = path.join(root, 'operation.json');
    try {
      await fs.promises.writeFile(`${filePath}.previous`, JSON.stringify({ revision: 1 }), 'utf8');
      await expect(readRecoveryJsonAtomic(filePath)).resolves.toEqual({ revision: 1 });
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });
});
