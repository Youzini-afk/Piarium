#!/usr/bin/env node
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveTargetArchitecture } from './target-architecture.mjs';

const electronRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repository = path.resolve(electronRoot, '../..');
const require = createRequire(import.meta.url);
const executable = require('electron');
const target = resolveTargetArchitecture();
if (target.node !== process.arch) throw new Error('Native execution verification requires a matching architecture runner');
const webRoot = path.join(repository, 'packages/web');
const environment = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
execFileSync(process.execPath, [path.join(electronRoot, 'scripts/prepare-native-runtime.mjs')], {
  cwd: electronRoot, stdio: 'inherit', windowsHide: true,
});
execFileSync(executable, [path.join(repository, 'scripts/smoke-kernel-release.mjs'), webRoot], {
  cwd: electronRoot, env: environment, stdio: 'inherit', windowsHide: true, timeout: 120_000,
});
// TriviumDB remains the existing knowledge owner. Verify its real Node-API
// loading and durable read/write under Electron rather than rebuilding PTY/SQL.
const knowledge = pathToFileURL(path.join(webRoot, 'server/lib/knowledge/store.js')).href;
const source = `
  import fs from 'node:fs/promises'; import os from 'node:os'; import path from 'node:path';
  import assert from 'node:assert/strict';
  const { openWorkspaceKnowledge } = await import(${JSON.stringify(knowledge)});
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'varin-electron-knowledge-'));
  let store;
  try {
    store = await openWorkspaceKnowledge({ dataDir, hostId: 'native-smoke', workspaceId: 'ws', embedding: null });
    const id = await store.putKnowledge({ scope: 'workspace', status: 'accepted', content: 'Native release verification', trigger: 'release verification' });
    assert.equal((await store.recall('release verification', 5))[0]?.node.id, id);
  } finally { await store?.close(); await fs.rm(dataDir, { recursive: true, force: true }); }
`;
execFileSync(executable, ['--input-type=module', '-e', source], {
  cwd: electronRoot, env: environment, stdio: 'inherit', windowsHide: true, timeout: 30_000,
});
console.log('[electron] verified Rust release authority and TriviumDB under Electron');
