#!/usr/bin/env node
import path from 'node:path';
import { existsSync } from 'node:fs';
import fsp from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { rebuild } from '@electron/rebuild';
import { resolveTargetArchitecture } from './target-architecture.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const electronDir = path.resolve(__dirname, '..');
const repoRoot = path.resolve(electronDir, '..', '..');
const require = createRequire(import.meta.url);

const electronPkg = require('electron/package.json');
const electronVersion = electronPkg.version;
const targetArchitecture = resolveTargetArchitecture();

const copyDirectory = async (src, dst) => {
  await fsp.mkdir(dst, { recursive: true });
  const entries = await fsp.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const from = path.join(src, entry.name);
    const to = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      await copyDirectory(from, to);
    } else {
      await fsp.copyFile(from, to);
    }
  }
};

const getWindowsShortPath = (target) => {
  if (process.platform !== 'win32') return target;
  try {
    const escaped = target.replace(/'/g, "''");
    const output = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-Command', `$fso = New-Object -ComObject Scripting.FileSystemObject; $fso.GetFolder('${escaped}').ShortPath`],
      { encoding: 'utf8' },
    ).trim();
    return output || target;
  } catch {
    return target;
  }
};

const createWindowsRebuildPath = (target) => {
  if (process.platform !== 'win32') {
    return { buildPath: target, cleanup: () => {} };
  }

  for (const letter of 'ZYXWVUTSRQPONMLKJIHGFED') {
    const drive = `${letter}:`;
    if (existsSync(`${drive}\\`)) continue;
    try {
      execFileSync('subst.exe', [drive, target], { stdio: 'ignore' });
      return {
        buildPath: `${drive}\\`,
        cleanup: () => {
          try {
            execFileSync('subst.exe', [drive, '/d'], { stdio: 'ignore' });
          } catch {
            // Best-effort cleanup. The build result should not depend on this.
          }
        },
      };
    } catch {
      // Try the next drive letter.
    }
  }

  const shortPath = getWindowsShortPath(target);
  if (shortPath === target && /\s/.test(target)) {
    throw new Error(
      `Unable to create a space-free Windows rebuild path for ${target}. `
      + 'All subst drive letters are unavailable and the volume did not return an 8.3 short path.',
    );
  }

  return { buildPath: shortPath, cleanup: () => {} };
};

const writeWindowsNodeAddonApiIndex = async (nodeAddonApiDir, exportedNodeAddonApiDir) => {
  if (process.platform !== 'win32') return;

  const shortDir = getWindowsShortPath(exportedNodeAddonApiDir);
  await fsp.writeFile(
    path.join(nodeAddonApiDir, 'index.js'),
    `const path = require('path');

const includeDir = ${JSON.stringify(shortDir)};

module.exports = {
  include: \`"${shortDir}"\`,
  include_dir: includeDir,
  gyp: path.join(includeDir, 'node_api.gyp:nothing'),
  targets: path.join(includeDir, 'node_addon_api.gyp'),
  isNodeApiBuiltin: true,
  needsFlag: false
};
`,
  );
};

const ensureWindowsNodeAddonApiForNodePty = async (rebuildRootPath) => {
  if (process.platform !== 'win32') return async () => {};

  const nodePtyPackagePath = require.resolve('node-pty/package.json');
  const nodePtyDir = path.dirname(nodePtyPackagePath);
  const rootNodeAddonApiDir = path.dirname(require.resolve('node-addon-api/package.json'));
  const tempNodeAddonApiDir = path.join(repoRoot, 'node_modules', '.piarium-node-addon-api-7.1.1');
  const exportedTempNodeAddonApiDir = path.join(rebuildRootPath, 'node_modules', '.piarium-node-addon-api-7.1.1');
  const localNodeAddonApiDir = path.join(nodePtyDir, 'node_modules', 'node-addon-api');

  await fsp.rm(tempNodeAddonApiDir, { recursive: true, force: true });
  await copyDirectory(rootNodeAddonApiDir, tempNodeAddonApiDir);
  await fsp.access(path.join(tempNodeAddonApiDir, 'package.json'));

  await fsp.rm(localNodeAddonApiDir, { recursive: true, force: true });
  await copyDirectory(rootNodeAddonApiDir, localNodeAddonApiDir);
  await writeWindowsNodeAddonApiIndex(localNodeAddonApiDir, exportedTempNodeAddonApiDir);
  await fsp.access(path.join(localNodeAddonApiDir, 'package.json'));

  return async () => {
    await fsp.rm(localNodeAddonApiDir, { recursive: true, force: true });
    await fsp.rm(tempNodeAddonApiDir, { recursive: true, force: true });
  };
};

const verifyWindowsNodePtyPrebuild = () => {
  if (process.platform !== 'win32') return;

  const nodePtyDir = path.dirname(require.resolve('node-pty/package.json'));
  const prebuildDir = path.join(nodePtyDir, 'prebuilds', `win32-${targetArchitecture.electronBuilder}`);
  for (const file of ['conpty.node', 'conpty_console_list.node']) {
    const candidate = path.join(prebuildDir, file);
    if (!existsSync(candidate)) {
      throw new Error(`node-pty Windows prebuild is missing ${candidate}`);
    }
  }

  const electronExecutable = require('electron');
  const verificationScript = `
const pty = require('node-pty');
const child = pty.spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'exit 0'], {
  cols: 80,
  rows: 24,
  cwd: process.cwd(),
  env: process.env,
});
const timer = setTimeout(() => process.exit(9), 10_000);
child.onExit(({ exitCode }) => {
  clearTimeout(timer);
  process.exit(exitCode);
});
`;
  execFileSync(electronExecutable, ['-e', verificationScript], {
    cwd: repoRoot,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: 'inherit',
    timeout: 15_000,
  });
  console.log(`[electron] verified node-pty win32-${targetArchitecture.electronBuilder} prebuild against Electron ${electronVersion}`);
};

console.log(`[electron] rebuilding native modules against Electron ${electronVersion}...`);

await rebuild({
  buildPath: electronDir,
  electronVersion,
  force: true,
  arch: targetArchitecture.electronBuilder,
  onlyModules: ['better-sqlite3'],
});
const betterSqliteDir = path.dirname(require.resolve('better-sqlite3/package.json'));
const betterSqliteBinary = path.join(betterSqliteDir, 'build', 'Release', 'better_sqlite3.node');
if (!existsSync(betterSqliteBinary)) {
  throw new Error(`better-sqlite3 rebuild did not produce ${betterSqliteBinary}`);
}

// node-pty publishes N-API Windows binaries and validates them in its own
// install script. Loading and spawning through Electron is a stronger check
// than rebuilding those same sources on every packager machine, which would
// additionally require Visual Studio's optional Spectre libraries. Keep a
// source-build escape hatch for node-pty contributors and non-Windows targets.
const rebuildWindowsNodePtyFromSource = process.env.PIARIUM_REBUILD_NODE_PTY_FROM_SOURCE === '1';
if (process.platform === 'win32' && !rebuildWindowsNodePtyFromSource) {
  verifyWindowsNodePtyPrebuild();
} else {
  const rebuildPath = createWindowsRebuildPath(repoRoot);
  let cleanupNodeAddonApi = async () => {};
  try {
    cleanupNodeAddonApi = await ensureWindowsNodeAddonApiForNodePty(rebuildPath.buildPath);
    await rebuild({
      buildPath: rebuildPath.buildPath,
      electronVersion,
      force: true,
      arch: targetArchitecture.electronBuilder,
      onlyModules: ['node-pty'],
    });
  } finally {
    try {
      await cleanupNodeAddonApi();
    } finally {
      rebuildPath.cleanup();
    }
  }
}

console.log('[electron] native modules rebuilt successfully');
