import { beforeEach, describe, expect, it, mock } from 'bun:test';
import * as realChildProcess from 'node:child_process';
import { promisify } from 'node:util';
import { spawnSync } from 'node:child_process';

const execCalls = [];
const execMock = mock(() => {
  throw new Error('exec should be called through promisify');
});

execMock[promisify.custom] = (command, options) => {
  execCalls.push({ command, options });
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve({ stdout: '/repo/.git\n/repo/.git\n', stderr: '' });
    }, 10);
  });
};

const childProcessMock = {
  ...realChildProcess,
  exec: execMock,
  spawnSync,
};

mock.module('child_process', () => childProcessMock);
mock.module('node:child_process', () => childProcessMock);

mock.module('vscode', () => ({
  workspace: {
    workspaceFolders: [{ uri: { fsPath: '/workspace' } }],
    fs: {},
  },
  Uri: {
    file: (fsPath) => ({ fsPath }),
  },
  FileType: {
    Directory: 2,
  },
  window: {},
}));

const { clearGitReadCacheForTests, handleFsBridgeMessage } = await import('./bridge-fs-runtime');

const deps = {
  resolveUserPath: (value, base) => {
    if (typeof value !== 'string') return value;
    if (value.startsWith('/')) return value;
    return `${base}/${value}`.replace(/\/+/g, '/');
  },
  listDirectoryEntries: mock(),
  normalizeFsPath: (value) => value,
  execGit: mock(),
  searchDirectory: mock(),
  resolveFileReadPath: mock(),
  parseDroppedFileReference: mock(),
  readUriAsAttachment: mock(),
};

describe('bridge fs exec git read cache', () => {
  beforeEach(() => {
    execCalls.length = 0;
    clearGitReadCacheForTests();
  });

  it('dedupes in-flight cacheable git reads and reuses fresh results', async () => {
    const command = 'git rev-parse --absolute-git-dir --git-common-dir';
    const cwd = '/repo';

    const [first, second] = await Promise.all([
      handleFsBridgeMessage({ id: '1', type: 'api:fs:exec', payload: { commands: [command], cwd } }, deps),
      handleFsBridgeMessage({ id: '2', type: 'api:fs:exec', payload: { commands: [command], cwd } }, deps),
    ]);

    expect(first?.success).toBe(true);
    expect(second?.success).toBe(true);
    expect(execCalls).toHaveLength(1);

    const spacedCommand = 'git   rev-parse   --absolute-git-dir   --git-common-dir';
    const cached = await handleFsBridgeMessage({ id: '3', type: 'api:fs:exec', payload: { commands: [spacedCommand], cwd } }, deps);

    expect(execCalls).toHaveLength(1);
    expect(cached?.data?.results?.[0]).toMatchObject({
      command: spacedCommand,
      success: true,
      stdout: '/repo/.git\n/repo/.git',
    });
  });

  it('does not cache arbitrary exec commands', async () => {
    const command = 'git status --porcelain';
    const cwd = '/repo';

    await handleFsBridgeMessage({ id: '1', type: 'api:fs:exec', payload: { commands: [command], cwd } }, deps);
    await handleFsBridgeMessage({ id: '2', type: 'api:fs:exec', payload: { commands: [command], cwd } }, deps);

    expect(execCalls).toHaveLength(2);
  });
});

describe('bridge fs read/stat directory resolution', () => {
  beforeEach(() => {
    deps.resolveFileReadPath.mockReset?.();
    deps.resolveFileReadPath = mock(() => ({ ok: false, status: 404, error: 'not found' }));
  });

  it('resolves a relative read path against the supplied directory', async () => {
    await handleFsBridgeMessage({ id: '1', type: 'api:fs:read', payload: { path: 'file.txt', directory: '/base' } }, deps);

    expect(deps.resolveFileReadPath).toHaveBeenCalledWith('/base/file.txt');
  });

  it('keeps absolute read paths unchanged even when a directory is supplied', async () => {
    await handleFsBridgeMessage({ id: '1', type: 'api:fs:read', payload: { path: '/abs/file.txt', directory: '/base' } }, deps);

    expect(deps.resolveFileReadPath).toHaveBeenCalledWith('/abs/file.txt');
  });

  it('resolves relative read paths against the workspace root when no directory is supplied', async () => {
    await handleFsBridgeMessage({ id: '1', type: 'api:fs:read', payload: { path: 'file.txt' } }, deps);

    expect(deps.resolveFileReadPath).toHaveBeenCalledWith('/workspace/file.txt');
  });

  it('resolves a relative stat path against the supplied directory', async () => {
    await handleFsBridgeMessage({ id: '1', type: 'api:fs:stat', payload: { path: 'file.txt', directory: '/base' } }, deps);

    expect(deps.resolveFileReadPath).toHaveBeenCalledWith('/base/file.txt');
  });

  it('returns an error when a read path is missing', async () => {
    const response = await handleFsBridgeMessage({ id: '1', type: 'api:fs:read', payload: {} }, deps);

    expect(response.success).toBe(false);
    expect(response.error).toBe('Path is required');
  });

  it('returns an error when a stat path is missing', async () => {
    const response = await handleFsBridgeMessage({ id: '1', type: 'api:fs:stat', payload: {} }, deps);

    expect(response.success).toBe(false);
    expect(response.error).toBe('Path is required');
  });
});
