import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

mock.module('vscode', () => ({
  extensions: { getExtension: () => undefined },
  Uri: { file: (fsPath) => ({ fsPath }) },
}));

const { cloneRepository } = await import('./gitService.ts?clone-repository-test');

let root;
let source;

beforeAll(async () => {
  root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'piarium-vscode-clone-'));
  source = path.join(root, 'source.git');
  execFileSync('git', ['init', '--bare', source], { stdio: 'ignore', windowsHide: true });
}, 15_000);

afterAll(async () => {
  if (root) {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

describe('VS Code repository cloning', () => {
  it('clones into the requested path', async () => {
    const destination = path.join(root, 'copy');

    const result = await cloneRepository({
      remoteUrl: source,
      destinationPath: destination,
    });

    expect(path.resolve(result.path)).toBe(path.resolve(destination));
    expect(result.success).toBe(true);
    expect(fs.existsSync(path.join(destination, '.git'))).toBe(true);
  });
});
