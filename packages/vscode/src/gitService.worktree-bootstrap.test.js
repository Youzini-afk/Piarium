import { describe, expect, it, mock } from 'bun:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

mock.module('vscode', () => ({
  extensions: { getExtension: () => undefined },
  Uri: { file: (fsPath) => ({ fsPath }) },
}));

const { getWorktreeBootstrapStatus, previewWorktreeCreate } = await import('./gitService.ts?worktree-bootstrap-test');

describe('VS Code worktree bootstrap phases', () => {
  it('treats missing bootstrap state as fully ready', async () => {
    await expect(getWorktreeBootstrapStatus('/untracked-worktree')).resolves.toMatchObject({
      status: 'ready',
      phase: 'setup-ready',
      error: null,
    });
  });

  it('places new worktrees in Piarium data without writing engine metadata into the repository', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'piarium-vscode-worktree-'));
    const repository = path.join(root, 'repository');
    const dataDirectory = path.join(root, 'data');
    const previousDataDirectory = process.env.PIARIUM_DATA_DIR;
    try {
      await fs.promises.mkdir(repository);
      execFileSync('git', ['init'], { cwd: repository, stdio: 'ignore', windowsHide: true });
      process.env.PIARIUM_DATA_DIR = dataDirectory;

      const preview = await previewWorktreeCreate(repository, { worktreeName: 'feature' });

      expect(path.relative(path.join(dataDirectory, 'worktrees'), preview.path).startsWith('..')).toBe(false);
      expect(preview.branch).toBe('piarium/feature');
      expect(fs.existsSync(path.join(repository, '.git', 'opencode'))).toBe(false);
    } finally {
      if (previousDataDirectory === undefined) delete process.env.PIARIUM_DATA_DIR;
      else process.env.PIARIUM_DATA_DIR = previousDataDirectory;
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });
});
