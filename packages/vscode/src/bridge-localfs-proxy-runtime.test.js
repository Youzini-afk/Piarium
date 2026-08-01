import { afterEach, describe, expect, it, mock } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

const realFsPromises = fs.promises;

const defaultRealpath = mock(async (inputPath) => inputPath);
const defaultStat = mock(async () => {
  const error = new Error('missing');
  error.code = 'ENOENT';
  throw error;
});

mock.module('fs', () => ({
  ...fs,
  promises: {
    ...fs.promises,
    realpath: defaultRealpath,
    stat: defaultStat,
  },
  default: {
    ...fs,
    promises: {
      ...fs.promises,
      realpath: defaultRealpath,
      stat: defaultStat,
    },
  },
}));

mock.module('vscode', () => ({
  Uri: {
    file: (fsPath) => ({ fsPath }),
  },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: '/workspace' } }],
  },
}));

const { tryHandleLocalFsProxy } = await import('./bridge-localfs-proxy-runtime');

const resetMocks = () => {
  defaultRealpath.mockReset();
  defaultRealpath.mockImplementation(async (inputPath) => inputPath);
  defaultStat.mockReset();
  defaultStat.mockImplementation(async () => {
    const error = new Error('missing');
    error.code = 'ENOENT';
    throw error;
  });
};

const restoreRealFsMocks = () => {
  defaultRealpath.mockReset();
  defaultRealpath.mockImplementation((inputPath) => realFsPromises.realpath(inputPath));
  defaultStat.mockReset();
  defaultStat.mockImplementation((inputPath) => realFsPromises.stat(inputPath));
};

afterEach(() => {
  restoreRealFsMocks();
});

const fileStats = () => ({
  isFile: () => true,
  size: 42,
  mtimeMs: 1234567890,
});

describe('bridge local fs proxy', () => {
  it('returns a quiet optional stat miss for missing files', async () => {
    resetMocks();
    defaultRealpath.mockImplementation(async () => {
      const error = new Error('missing');
      error.code = 'ENOENT';
      throw error;
    });

    const response = await tryHandleLocalFsProxy('GET', '/api/fs/stat?path=%2Fmissing.ts&optional=true');

    expect(response?.status).toBe(200);
    expect(JSON.parse(Buffer.from(response?.bodyBase64 ?? '', 'base64').toString('utf8'))).toEqual({
      path: '/missing.ts',
      exists: false,
    });
  });

  it('keeps regular stat miss behavior without optional flag', async () => {
    resetMocks();
    defaultRealpath.mockImplementation(async () => {
      const error = new Error('missing');
      error.code = 'ENOENT';
      throw error;
    });

    const response = await tryHandleLocalFsProxy('GET', '/api/fs/stat?path=%2Fmissing.ts');

    expect(response?.status).toBe(404);
  });

  it('resolves relative paths against x-opencode-directory header', async () => {
    resetMocks();
    defaultStat.mockImplementation(async () => fileStats());

    const response = await tryHandleLocalFsProxy(
      'GET',
      '/api/fs/stat?path=relative.txt',
      { 'x-opencode-directory': '/workspace/sub', accept: 'application/json' },
    );

    expect(response?.status).toBe(200);
    expect(defaultRealpath).toHaveBeenCalledWith(path.resolve('/workspace/sub', 'relative.txt'));
    expect(defaultStat).toHaveBeenCalledWith(path.resolve('/workspace/sub', 'relative.txt'));
  });

  it('resolves relative paths against directory query parameter', async () => {
    resetMocks();
    defaultStat.mockImplementation(async () => fileStats());

    const response = await tryHandleLocalFsProxy('GET', '/api/fs/stat?path=relative.txt&directory=%2Fworkspace%2Fsub');

    expect(response?.status).toBe(200);
    expect(defaultRealpath).toHaveBeenCalledWith(path.resolve('/workspace/sub', 'relative.txt'));
  });

  it('preserves optional=true quiet miss for relative paths under a directory', async () => {
    resetMocks();
    defaultRealpath.mockImplementation(async () => {
      const error = new Error('missing');
      error.code = 'ENOENT';
      throw error;
    });

    const response = await tryHandleLocalFsProxy(
      'GET',
      '/api/fs/stat?path=missing.txt&optional=true&directory=%2Fworkspace%2Fsub',
    );

    expect(response?.status).toBe(200);
    expect(JSON.parse(Buffer.from(response?.bodyBase64 ?? '', 'base64').toString('utf8'))).toEqual({
      path: 'missing.txt',
      exists: false,
    });
  });
});
