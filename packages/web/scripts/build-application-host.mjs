#!/usr/bin/env node
/**
 * Build helper for the Application Host.
 *
 * Compiles packages/web/application-host to a staging directory, then
 * atomically replaces packages/web/server with the staged output.
 *
 * During the transitional period (Phase 2+), application-host contains
 * a mix of .js and .ts files. tsc with allowJs:true emits both. Non-JS
 * assets (templates, fixtures needed at runtime) are copied as-is.
 *
 * On failure, the staging directory is removed and the existing server/
 * is left untouched. On success, the old server/ is replaced.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..');
const webRoot = path.join(repoRoot, 'packages', 'web');
const sourceDir = path.join(webRoot, 'application-host');
const outputDir = path.join(webRoot, 'server');

const log = (message) => process.stdout.write(`[build:application-host] ${message}\n`);

// ── Step 1: Compile to a staging directory ───────────────────────────────

const stagingDir = path.join(webRoot, `.application-host-staging-${process.pid}`);

const cleanStaging = () => {
  try {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
};

try {
  // Clean any previous staging
  cleanStaging();

  // Run tsc with a unique outDir to avoid concurrent build conflicts.
  // Use process.execPath (node) to run tsc.js directly — avoids both
  // cmd.exe and bun path resolution issues on Windows.
  const tscJs = path.join(repoRoot, 'node_modules', 'typescript', 'lib', 'tsc.js');
  const configPath = path.join(webRoot, 'tsconfig.application-host.json');
  log('Compiling application-host to staging directory...');
  const tscResult = spawnSync(process.execPath, [
    tscJs,
    '-p', configPath,
    '--outDir', stagingDir,
  ], {
    cwd: webRoot,
    stdio: 'inherit',
    shell: false,
  });
  if (tscResult.status !== 0) {
    const errMsg = tscResult.stderr?.toString() ?? tscResult.error?.message ?? 'unknown error';
    throw new Error(`tsc exited with status ${tscResult.status}: ${errMsg}`);
  }

  // ── Step 2: Copy non-JS/TS runtime assets ─────────────────────────────
  // Some files in application-host are not JS/TS but are needed at runtime
  // (e.g., HTML templates, static fixtures). Copy them to staging.
  const copyAssets = (srcDir, destDir) => {
    if (!fs.existsSync(srcDir)) return;
    for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
      // Skip test files
      if (entry.name.endsWith('.test.js') || entry.name.endsWith('.test.ts')) continue;
      // Skip source maps and declarations (they're in staging from tsc)
      if (entry.name.endsWith('.d.ts') || entry.name.endsWith('.d.ts.map')) continue;

      const srcPath = path.join(srcDir, entry.name);
      const destPath = path.join(destDir, entry.name);

      if (entry.isDirectory()) {
        fs.mkdirSync(destPath, { recursive: true });
        copyAssets(srcPath, destPath);
      } else {
        // Only copy non-JS/TS files (JS/TS are emitted by tsc)
        const ext = path.extname(entry.name);
        if (ext !== '.js' && ext !== '.ts' && ext !== '.mjs' && ext !== '.mts' && ext !== '.cjs' && ext !== '.cts') {
          fs.copyFileSync(srcPath, destPath);
        }
      }
    }
  };
  copyAssets(sourceDir, stagingDir);

  // ── Step 3: Validate staging ───────────────────────────────────────────
  const indexJs = path.join(stagingDir, 'index.js');
  if (!fs.existsSync(indexJs)) {
    throw new Error('Staging directory does not contain index.js');
  }

  // Verify index.js is syntactically valid
  const checkResult = spawnSync(process.execPath, ['--check', indexJs], { stdio: 'pipe', shell: false });
  if (checkResult.status !== 0) {
    throw new Error(`Staging index.js failed syntax check: ${checkResult.stderr?.toString() ?? 'unknown error'}`);
  }

  log(`Staging complete: ${stagingDir}`);

  // ── Step 4: Atomically replace server/ ─────────────────────────────────
  // On Windows, we can't atomically rename over an existing directory.
  // Strategy: rename old server/ to a backup, rename staging to server/,
  // then remove the backup. If the rename fails, restore the backup.
  const backupDir = path.join(webRoot, `.server-backup-${process.pid}`);

  // Remove any existing backup
  try { fs.rmSync(backupDir, { recursive: true, force: true }); } catch { /* */ }

  if (fs.existsSync(outputDir)) {
    fs.renameSync(outputDir, backupDir);
  }

  try {
    fs.renameSync(stagingDir, outputDir);
    log(`Replaced ${outputDir}`);
    // Clean up backup
    try { fs.rmSync(backupDir, { recursive: true, force: true }); } catch { /* */ }
  } catch (renameError) {
    // Restore backup if rename failed
    if (fs.existsSync(backupDir)) {
      try { fs.renameSync(backupDir, outputDir); } catch { /* */ }
    }
    throw new Error(`Failed to replace server/: ${renameError.message}`);
  }

  log('Build complete.');
} catch (error) {
  cleanStaging();
  log(`Build failed: ${error.message}`);
  process.exit(1);
}
