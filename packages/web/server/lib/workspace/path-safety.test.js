import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

let tempDir;
let workspaceRoot;
const dirLinkType = process.platform === 'win32' ? 'junction' : 'dir';

async function loadPathSafetyModule() {
  return import(/* @vite-ignore */ `./path-safety.js?test=${Date.now()}-${Math.random()}`);
}

describe('workspace path safety', () => {
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-workspace-path-'));
    workspaceRoot = path.join(tempDir, 'workspace');
    fs.mkdirSync(workspaceRoot, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
    workspaceRoot = undefined;
  });

  it('rejects parent traversal, absolute paths, Windows drive paths, and NUL bytes', async () => {
    const { normalizeWorkspaceRelativePath } = await loadPathSafetyModule();

    expect(() => normalizeWorkspaceRelativePath('../secret')).toThrow(/outside workspace/i);
    expect(() => normalizeWorkspaceRelativePath('/etc/passwd')).toThrow(/relative path/i);
    expect(() => normalizeWorkspaceRelativePath('C:/Users/test')).toThrow(/relative path/i);
    expect(() => normalizeWorkspaceRelativePath('demo\0file')).toThrow(/invalid path/i);
  });

  it('allows symlinks whose real target stays inside the workspace', async () => {
    const { resolveWorkspacePath } = await loadPathSafetyModule();
    fs.mkdirSync(path.join(workspaceRoot, 'real'), { recursive: true });
    fs.writeFileSync(path.join(workspaceRoot, 'real', 'note.txt'), 'hello');
    fs.symlinkSync(path.join(workspaceRoot, 'real'), path.join(workspaceRoot, 'inside-link'), dirLinkType);

    const result = await resolveWorkspacePath('inside-link/note.txt', {
      root: workspaceRoot,
      fsPromises: fs.promises,
      pathModule: path,
    });

    expect(result.relativePath).toBe('inside-link/note.txt');
    expect(result.absolutePath).toBe(path.join(workspaceRoot, 'inside-link', 'note.txt'));
  });

  it('rejects symlinks whose real target escapes the workspace', async () => {
    const { resolveWorkspacePath } = await loadPathSafetyModule();
    const outside = path.join(tempDir, 'outside');
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'nope');
    fs.symlinkSync(outside, path.join(workspaceRoot, 'outside-link'), dirLinkType);

    await expect(resolveWorkspacePath('outside-link/secret.txt', {
      root: workspaceRoot,
      fsPromises: fs.promises,
      pathModule: path,
    })).rejects.toThrow(/outside workspace/i);
  });

  it('resolves a missing child only when the nearest existing parent is inside the workspace', async () => {
    const { resolveWorkspacePath } = await loadPathSafetyModule();
    fs.mkdirSync(path.join(workspaceRoot, 'project'), { recursive: true });

    const result = await resolveWorkspacePath('project/src/new.txt', {
      root: workspaceRoot,
      fsPromises: fs.promises,
      pathModule: path,
      allowMissing: true,
    });

    expect(result.absolutePath).toBe(path.join(workspaceRoot, 'project', 'src', 'new.txt'));
  });

  it('accepts a workspace root whose canonical path uses a different filesystem alias', async () => {
    const { resolveWorkspacePath } = await loadPathSafetyModule();
    const aliases = new Map([
      ['/short/workspace', '/canonical/workspace'],
      ['/short/workspace/note.txt', '/canonical/workspace/note.txt'],
    ]);
    const fsPromises = {
      realpath: async (targetPath) => aliases.get(targetPath) ?? targetPath,
    };

    const result = await resolveWorkspacePath('note.txt', {
      root: '/short/workspace',
      fsPromises,
      pathModule: path.posix,
    });

    expect(result.rootPath).toBe('/short/workspace');
    expect(result.rootRealPath).toBe('/canonical/workspace');
    expect(result.realPath).toBe('/canonical/workspace/note.txt');
  });
});
