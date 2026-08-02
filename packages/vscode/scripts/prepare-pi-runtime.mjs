import { existsSync } from 'node:fs';
import { copyFile, cp, mkdir, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lockedRuntimeRoot = path.resolve(packageRoot, 'runtime');
const runtimeRoot = path.resolve(packageRoot, 'dist', 'pi-runtime');
const expectedParent = path.resolve(packageRoot, 'dist');
if (path.dirname(runtimeRoot) !== expectedParent || path.basename(runtimeRoot) !== 'pi-runtime') {
  throw new Error(`Refusing to prepare an unexpected runtime path: ${runtimeRoot}`);
}

await rm(runtimeRoot, { force: true, recursive: true });
await mkdir(runtimeRoot, { recursive: true });
await Promise.all([
  copyFile(path.join(lockedRuntimeRoot, 'package.json'), path.join(runtimeRoot, 'package.json')),
  copyFile(path.join(lockedRuntimeRoot, 'package-lock.json'), path.join(runtimeRoot, 'package-lock.json')),
]);

const findNpmCli = () => {
  const direct = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (existsSync(direct)) return direct;
  const command = process.platform === 'win32' ? 'where.exe' : 'which';
  const result = spawnSync(command, [process.platform === 'win32' ? 'npm.cmd' : 'npm'], {
    encoding: 'utf8',
    timeout: 10_000,
    windowsHide: true,
  });
  if (result.status === 0) {
    for (const entry of result.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)) {
      const candidate = path.join(path.dirname(entry), 'node_modules', 'npm', 'bin', 'npm-cli.js');
      if (existsSync(candidate)) return candidate;
    }
  }
  throw new Error('npm CLI was not found next to Node.js; install a current Node.js distribution with npm');
};

const npmCli = findNpmCli();

const runNpm = (args, { capture = false } = {}) => {
  const result = spawnSync(process.execPath, [npmCli, ...args], {
    cwd: runtimeRoot,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (capture && result.stderr) process.stderr.write(result.stderr);
    throw new Error(`npm ${args[0]} failed (exit ${String(result.status)})`);
  }
  return result.stdout || '';
};

runNpm([
  'ci',
  '--omit=dev',
  '--ignore-scripts',
  '--no-audit',
  '--no-fund',
]);

// Pi publishes a shrinkwrap that currently pins an older brace-expansion copy.
// Replace that nested copy with Piarium's locked safe version after npm ci.
const safeBraceExpansion = path.join(runtimeRoot, 'node_modules', 'brace-expansion');
const nestedBraceExpansion = path.join(
  runtimeRoot,
  'node_modules',
  '@earendil-works',
  'pi-coding-agent',
  'node_modules',
  'brace-expansion',
);
await rm(nestedBraceExpansion, { force: true, recursive: true });
await cp(safeBraceExpansion, nestedBraceExpansion, { recursive: true });

const copyWorkspacePackage = async (name, sourceRoot) => {
  const targetRoot = path.join(runtimeRoot, 'node_modules', '@piarium', name);
  await mkdir(targetRoot, { recursive: true });
  await Promise.all([
    copyFile(path.join(sourceRoot, 'package.json'), path.join(targetRoot, 'package.json')),
    cp(path.join(sourceRoot, 'dist'), path.join(targetRoot, 'dist'), { recursive: true }),
  ]);
};

await Promise.all([
  copyWorkspacePackage('protocol', path.resolve(packageRoot, '..', 'protocol')),
  copyWorkspacePackage('pi-host', path.resolve(packageRoot, '..', 'pi-host')),
]);

console.log(`[piarium-vscode] prepared Pi host runtime at ${runtimeRoot}`);
