import path from 'node:path';
import type { PathLike } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createDocumentRootGuard } from './allowed-roots.js';

describe('document root guard', () => {
  it('compares Windows roots by canonical path identity', async () => {
    const fsPromises = {
      realpath: vi.fn(async (value: PathLike) => path.win32.normalize(String(value))),
    };
    const guard = createDocumentRootGuard({
      fsPromises,
      pathModule: path.win32,
      platform: 'win32',
      readSettings: async () => ({ projects: [{ path: 'D:\\project\\infOS' }] }),
      getWorkspaceRoot: () => null,
    });

    await expect(guard('\\\\?\\D:\\project\\INFOS')).resolves.toBe(true);
    await expect(guard('D:\\project\\infOS\\packages\\app')).resolves.toBe(true);
    await expect(guard('D:\\project\\infOS-copy')).resolves.toBe(false);
  });

  it('does not turn an unreadable settings snapshot into a root grant', async () => {
    const guard = createDocumentRootGuard({
      fsPromises: { realpath: vi.fn(async (value: PathLike) => String(value)) },
      pathModule: path.posix,
      platform: 'linux',
      readSettings: async () => { throw new Error('settings unavailable'); },
      getWorkspaceRoot: () => null,
    });

    await expect(guard('/workspace')).resolves.toBe(false);
  });
});
