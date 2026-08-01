import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createServerUtilsRuntime } from './server-utils-runtime.js';

const originalPath = process.env.PATH;
const tempDirs = [];

const createTempDir = (prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  if (originalPath === undefined) {
    delete process.env.PATH;
    return;
  }

  process.env.PATH = originalPath;
});

const createRuntime = (loginShellPath, options = {}) => {
  const { processLike: explicitProcessLike, ...overrides } = options;
  const processLike = explicitProcessLike ?? (
    options.platform || options.env
      ? { platform: options.platform ?? 'linux', env: options.env ?? process.env }
      : { platform: 'linux', env: process.env }
  );

  return createServerUtilsRuntime({
  fs,
  os,
  path,
  process: processLike,
  openCodeReadyGraceMs: 0,
  longRequestTimeoutMs: 0,
  getRuntime: () => ({}),
  getOpenCodeAuthHeaders: () => ({}),
  buildOpenCodeUrl: (route) => route,
  ensureOpenCodeApiPrefix: () => {},
  getUiNotificationClients: () => new Set(),
  getOpenCodePort: () => null,
  setOpenCodePortState: () => {},
  syncToHmrState: () => {},
  markOpenCodeNotReady: () => {},
  setOpenCodeNotReadySince: () => {},
  clearLastOpenCodeError: () => {},
  getLoginShellPath: () => loginShellPath,
  augmentPathWithBundledRipgrep: () => ({ added: false, binDir: null }),
  ...overrides,
});
};

describe('server utils runtime', () => {
  it('prefers shell PATH for managed OpenCode before appending process-only entries', () => {
    const home = os.homedir();
    const currentPath = [
      path.join(home, '.opencode', 'bin'),
      path.join(home, '.bun', 'bin'),
      path.join(home, 'Library', 'pnpm'),
      '/opt/homebrew/bin',
      '/usr/bin',
    ].join(path.delimiter);
    process.env.PATH = currentPath;

    const runtime = createRuntime([
      path.join(home, '.opencode', 'bin'),
      path.join(home, '.bun', 'bin'),
      '/opt/homebrew/bin',
      '/usr/bin',
      path.join(home, '.cargo', 'bin'),
    ].join(path.delimiter));

    expect(runtime.buildManagedOpenCodePath()).toBe([
      path.join(home, '.opencode', 'bin'),
      path.join(home, '.bun', 'bin'),
      '/opt/homebrew/bin',
      '/usr/bin',
      path.join(home, '.cargo', 'bin'),
      path.join(home, 'Library', 'pnpm'),
    ].join(path.delimiter));
  });

  it('uses login shell PATH for managed OpenCode when process PATH is minimal', () => {
    const home = os.homedir();
    const loginShellPath = [
      path.join(home, '.opencode', 'bin'),
      path.join(home, '.bun', 'bin'),
      '/opt/homebrew/bin',
      '/usr/bin',
    ].join(path.delimiter);
    process.env.PATH = ['/usr/local/bin', '/usr/bin', '/bin'].join(path.delimiter);

    const runtime = createRuntime(loginShellPath);

    // Should prefer login shell PATH but merge in any process entries not already present.
    expect(runtime.buildManagedOpenCodePath()).toBe([
      path.join(home, '.opencode', 'bin'),
      path.join(home, '.bun', 'bin'),
      '/opt/homebrew/bin',
      '/usr/bin',
      '/usr/local/bin',
      '/bin',
    ].join(path.delimiter));
  });

  it('prepends bundled ripgrep for managed OpenCode processes', () => {
    const bundledRgPath = path.join(os.tmpdir(), 'openchamber-rg-bin');
    process.env.PATH = ['/usr/local/bin', '/usr/bin'].join(path.delimiter);
    const runtime = createRuntime('/usr/bin', {
      augmentPathWithBundledRipgrep: ({ env }) => {
        env.PATH = [bundledRgPath, env.PATH].filter(Boolean).join(path.delimiter);
        return { added: true, binDir: bundledRgPath };
      },
    });

    expect(runtime.buildManagedOpenCodePath().split(path.delimiter)[0]).toBe(bundledRgPath);
  });

  it('adds existing Windows package-manager directories to managed OpenCode PATH', () => {
    const root = createTempDir('openchamber-win-path-');
    const systemDir = path.join(root, 'System32');
    const appData = path.join(root, 'Roaming');
    const programFiles = path.join(root, 'Program Files');
    const localAppData = path.join(root, 'Local');
    const programData = path.join(root, 'ProgramData');
    const userProfile = path.join(root, 'User');

    const npmBin = path.join(appData, 'npm');
    const nodeBin = path.join(programFiles, 'nodejs');
    const pnpmHome = path.join(localAppData, 'pnpm');
    const yarnBin = path.join(localAppData, 'Yarn', 'bin');
    const chocoBin = path.join(programData, 'chocolatey', 'bin');

    for (const dir of [systemDir, npmBin, nodeBin, pnpmHome, yarnBin, chocoBin]) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const runtime = createRuntime(null, {
      platform: 'win32',
      env: {
        PATH: systemDir,
        APPDATA: appData,
        ProgramFiles: programFiles,
        LOCALAPPDATA: localAppData,
        ProgramData: programData,
        USERPROFILE: userProfile,
      },
    });

    expect(runtime.buildManagedOpenCodePath()).toBe([
      systemDir,
      npmBin,
      nodeBin,
      pnpmHome,
      yarnBin,
      chocoBin,
    ].join(path.delimiter));
  });

  it('preserves user-configured process PATH order before appending shell-only entries', () => {
    const home = os.homedir();
    process.env.PATH = [
      path.join(home, '.bun', 'bin'),
      path.join(home, 'Library', 'pnpm'),
      '/opt/homebrew/bin',
      '/usr/bin',
    ].join(path.delimiter);

    const runtime = createRuntime([
      path.join(home, '.bun', 'bin'),
      '/opt/homebrew/bin',
      path.join(home, '.cargo', 'bin'),
      '/usr/bin',
    ].join(path.delimiter));

    expect(runtime.buildAugmentedPath()).toBe([
      path.join(home, '.bun', 'bin'),
      path.join(home, 'Library', 'pnpm'),
      '/opt/homebrew/bin',
      '/usr/bin',
      path.join(home, '.cargo', 'bin'),
    ].join(path.delimiter));
  });

  it('prefers login shell PATH when current process PATH is minimal', () => {
    const home = os.homedir();
    process.env.PATH = ['/usr/local/bin', '/usr/bin', '/bin'].join(path.delimiter);

    const runtime = createRuntime([
      path.join(home, '.bun', 'bin'),
      '/opt/homebrew/bin',
      '/usr/bin',
    ].join(path.delimiter));

    expect(runtime.buildAugmentedPath()).toBe([
      path.join(home, '.bun', 'bin'),
      '/opt/homebrew/bin',
      '/usr/bin',
      '/usr/local/bin',
      '/bin',
    ].join(path.delimiter));
  });

  it('prepends bundled ripgrep for terminal PATHs', () => {
    const bundledRgPath = path.join(os.tmpdir(), 'openchamber-rg-bin');
    process.env.PATH = ['/usr/local/bin', '/usr/bin'].join(path.delimiter);
    const runtime = createRuntime('/usr/bin', {
      augmentPathWithBundledRipgrep: ({ env }) => {
        env.PATH = [bundledRgPath, env.PATH].filter(Boolean).join(path.delimiter);
        return { added: true, binDir: bundledRgPath };
      },
    });

    expect(runtime.buildAugmentedPath().split(path.delimiter)[0]).toBe(bundledRgPath);
  });
});
