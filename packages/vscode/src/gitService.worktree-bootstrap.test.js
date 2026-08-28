import { describe, expect, it, mock } from 'bun:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

mock.module('vscode', () => ({
  extensions: { getExtension: () => undefined },
  Uri: { file: (fsPath) => ({ fsPath }) },
}));

const {
  createWorktree,
  getWorktreeBootstrapStatus,
  previewWorktreeCreate,
  removeWorktree,
} = await import('./gitService.ts?worktree-bootstrap-test');

const waitFor = async (predicate, timeout = 5_000) => {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

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

  it('hands the create writer to background bootstrap before returning and releases it exactly once', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'piarium-vscode-writer-'));
    const repository = path.join(root, 'repository');
    const dataDirectory = path.join(root, 'data');
    const setupStarted = path.join(root, 'setup-started');
    const setupFinished = path.join(root, 'setup-finished');
    const setupScript = path.join(root, 'setup.cjs');
    const previousDataDirectory = process.env.PIARIUM_DATA_DIR;
    const writers = [];
    let requestReturned = false;
    const documents = {
      registerWriterForScope: mock(async (_scope, _owner, options) => {
        if (requestReturned) {
          throw Object.assign(new Error('Workspace is in maintenance mode'), { code: 'maintenance' });
        }
        const record = {
          purpose: options?.purpose,
          closed: false,
          markCalls: 0,
          closeCalls: 0,
        };
        writers.push(record);
        return {
          async markMutated() { record.markCalls += 1; },
          async close() { record.closeCalls += 1; record.closed = true; },
        };
      }),
    };

    try {
      await fs.promises.mkdir(repository);
      execFileSync('git', ['init', '-b', 'main'], { cwd: repository, stdio: 'ignore', windowsHide: true });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repository, stdio: 'ignore', windowsHide: true });
      execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repository, stdio: 'ignore', windowsHide: true });
      await fs.promises.writeFile(path.join(repository, 'README.md'), '# Test\n');
      execFileSync('git', ['add', 'README.md'], { cwd: repository, stdio: 'ignore', windowsHide: true });
      execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: repository, stdio: 'ignore', windowsHide: true });
      await fs.promises.writeFile(
        setupScript,
        `const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(setupStarted)}, 'started'); setTimeout(() => fs.writeFileSync(${JSON.stringify(setupFinished)}, 'finished'), 300);\n`,
      );
      process.env.PIARIUM_DATA_DIR = dataDirectory;

      const created = await createWorktree(repository, {
        mode: 'new',
        branchName: 'feature/writer-handoff',
        worktreeName: 'writer-handoff',
        returnAfterDirectoryCreated: true,
        startCommand: `${process.execPath} ${setupScript}`,
      }, { documents });
      requestReturned = true;

      expect(writers).toHaveLength(1);
      expect(writers[0]).toMatchObject({ purpose: 'vscode-git:worktree-create', closed: false });
      await waitFor(() => fs.existsSync(setupStarted));
      expect(writers[0].closed).toBe(false);
      await waitFor(() => fs.existsSync(setupFinished));
      await waitFor(() => writers[0].closed);
      expect(writers[0]).toMatchObject({ markCalls: 1, closeCalls: 1 });
      expect(documents.registerWriterForScope).toHaveBeenCalledTimes(1);

      await removeWorktree(repository, { directory: created.path });
    } finally {
      if (previousDataDirectory === undefined) delete process.env.PIARIUM_DATA_DIR;
      else process.env.PIARIUM_DATA_DIR = previousDataDirectory;
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  }, 15_000);

  it('keeps the create writer through bootstrap on the normal create path', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'piarium-vscode-sync-writer-'));
    const repository = path.join(root, 'repository');
    const dataDirectory = path.join(root, 'data');
    const setupStarted = path.join(root, 'setup-started');
    const setupFinished = path.join(root, 'setup-finished');
    const setupScript = path.join(root, 'setup.cjs');
    const previousDataDirectory = process.env.PIARIUM_DATA_DIR;
    const record = { closed: false, markCalls: 0, closeCalls: 0 };
    const documents = {
      registerWriterForScope: mock(async () => ({
        async markMutated() { record.markCalls += 1; },
        async close() { record.closeCalls += 1; record.closed = true; },
      })),
    };

    try {
      await fs.promises.mkdir(repository);
      execFileSync('git', ['init', '-b', 'main'], { cwd: repository, stdio: 'ignore', windowsHide: true });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repository, stdio: 'ignore', windowsHide: true });
      execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repository, stdio: 'ignore', windowsHide: true });
      await fs.promises.writeFile(path.join(repository, 'README.md'), '# Test\n');
      execFileSync('git', ['add', 'README.md'], { cwd: repository, stdio: 'ignore', windowsHide: true });
      execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: repository, stdio: 'ignore', windowsHide: true });
      await fs.promises.writeFile(
        setupScript,
        `const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(setupStarted)}, 'started'); setTimeout(() => fs.writeFileSync(${JSON.stringify(setupFinished)}, 'finished'), 300);\n`,
      );
      process.env.PIARIUM_DATA_DIR = dataDirectory;

      const created = await createWorktree(repository, {
        mode: 'new',
        branchName: 'feature/sync-writer-handoff',
        worktreeName: 'sync-writer-handoff',
        startCommand: `${process.execPath} ${setupScript}`,
      }, { documents });

      expect(record.closed).toBe(false);
      await waitFor(() => fs.existsSync(setupStarted));
      expect(record.closed).toBe(false);
      await waitFor(() => fs.existsSync(setupFinished));
      await waitFor(() => record.closed);
      expect(record).toMatchObject({ markCalls: 1, closeCalls: 1 });
      expect(documents.registerWriterForScope).toHaveBeenCalledTimes(1);

      await removeWorktree(repository, { directory: created.path });
    } finally {
      if (previousDataDirectory === undefined) delete process.env.PIARIUM_DATA_DIR;
      else process.env.PIARIUM_DATA_DIR = previousDataDirectory;
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  }, 15_000);

  it('keeps the create writer active until failed background attach cleanup finishes', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'piarium-vscode-writer-failure-'));
    const repository = path.join(root, 'repository');
    const dataDirectory = path.join(root, 'data');
    const previousDataDirectory = process.env.PIARIUM_DATA_DIR;
    const record = {
      closed: false,
      pathExistedAtClose: null,
      markCalls: 0,
      closeCalls: 0,
    };

    try {
      await fs.promises.mkdir(repository);
      execFileSync('git', ['init', '-b', 'main'], { cwd: repository, stdio: 'ignore', windowsHide: true });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repository, stdio: 'ignore', windowsHide: true });
      execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repository, stdio: 'ignore', windowsHide: true });
      await fs.promises.writeFile(path.join(repository, 'README.md'), '# Test\n');
      execFileSync('git', ['add', 'README.md'], { cwd: repository, stdio: 'ignore', windowsHide: true });
      execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: repository, stdio: 'ignore', windowsHide: true });
      process.env.PIARIUM_DATA_DIR = dataDirectory;

      const preview = await previewWorktreeCreate(repository, {
        branchName: 'invalid..branch',
        worktreeName: 'writer-attach-failure',
      });
      const documents = {
        registerWriterForScope: mock(async () => ({
          async markMutated() { record.markCalls += 1; },
          async close() {
            record.closeCalls += 1;
            record.pathExistedAtClose = fs.existsSync(preview.path);
            record.closed = true;
          },
        })),
      };

      const created = await createWorktree(repository, {
        mode: 'new',
        branchName: 'invalid..branch',
        worktreeName: 'writer-attach-failure',
        returnAfterDirectoryCreated: true,
      }, { documents });

      expect(created.path).toBe(preview.path);
      expect(record.closed).toBe(false);
      await waitFor(() => record.closed);
      expect(record).toMatchObject({
        pathExistedAtClose: false,
        markCalls: 1,
        closeCalls: 1,
      });
      expect(fs.existsSync(preview.path)).toBe(false);
      await expect(getWorktreeBootstrapStatus(preview.path)).resolves.toMatchObject({
        status: 'failed',
        phase: 'directory-created',
      });
    } finally {
      if (previousDataDirectory === undefined) delete process.env.PIARIUM_DATA_DIR;
      else process.env.PIARIUM_DATA_DIR = previousDataDirectory;
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  }, 15_000);
});
