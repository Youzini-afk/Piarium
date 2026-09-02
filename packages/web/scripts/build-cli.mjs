#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..');
const webRoot = path.join(repoRoot, 'packages', 'web');
const outputDir = path.join(webRoot, 'bin');
const stagingDir = path.join(webRoot, `.cli-staging-${process.pid}`);
const backupDir = path.join(webRoot, `.cli-backup-${process.pid}`);

const clean = (target) => {
  if (path.dirname(target) !== webRoot) throw new Error(`Refusing to clean outside Web package: ${target}`);
  fs.rmSync(target, { recursive: true, force: true });
};
const log = (message) => process.stdout.write(`[build:cli] ${message}\n`);

try {
  clean(stagingDir);
  clean(backupDir);
  const tscJs = path.join(repoRoot, 'node_modules', 'typescript', 'lib', 'tsc.js');
  const result = spawnSync(process.execPath, [
    tscJs,
    '-p', path.join(webRoot, 'tsconfig.cli.json'),
    '--outDir', stagingDir,
  ], { cwd: webRoot, stdio: 'inherit', shell: false });
  if (result.status !== 0) throw new Error(`tsc exited with status ${result.status}`);

  const entry = path.join(stagingDir, 'cli.js');
  if (!fs.existsSync(entry)) throw new Error('CLI staging output does not contain cli.js');
  const source = fs.readFileSync(entry, 'utf8');
  if (!source.startsWith('#!/usr/bin/env node')) throw new Error('CLI entrypoint lost its Node shebang');
  const syntax = spawnSync(process.execPath, ['--check', entry], { stdio: 'pipe', shell: false });
  if (syntax.status !== 0) throw new Error(`CLI entrypoint failed syntax check: ${syntax.stderr?.toString() ?? ''}`);

  if (fs.existsSync(outputDir)) fs.renameSync(outputDir, backupDir);
  try {
    fs.renameSync(stagingDir, outputDir);
    clean(backupDir);
  } catch (error) {
    if (fs.existsSync(backupDir) && !fs.existsSync(outputDir)) fs.renameSync(backupDir, outputDir);
    throw error;
  }
  log('Build complete.');
} catch (error) {
  clean(stagingDir);
  log(`Build failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
