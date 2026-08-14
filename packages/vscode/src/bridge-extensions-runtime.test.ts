import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type * as vscode from 'vscode';
import { handleExtensionsBridgeMessage } from './bridge-extensions-runtime';

test('VS Code owns an application-host extension catalog in global storage', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'piarium-vscode-extension-host-'));
  try {
    const context = { globalStorageUri: { fsPath: dataDir } } as vscode.ExtensionContext;
    const response = await handleExtensionsBridgeMessage({
      id: 'catalog-1',
      type: 'api:extensions:catalog',
    }, context);
    assert.equal(response?.success, true);
    assert.match(String((response?.data as { snapshot?: { hostId?: string } }).snapshot?.hostId), /^[0-9a-f-]{36}$/i);
    assert.equal((response?.data as { snapshot?: { storageState?: string } }).snapshot?.storageState, 'missing');

    const source = join(dataDir, 'fixture');
    await mkdir(source, { recursive: true });
    await writeFile(join(source, 'piarium.extension.json'), JSON.stringify({
      schemaVersion: 1,
      id: 'dev.example.vscode',
      version: '1.0.0',
      engines: { piarium: '*' },
      entrypoints: {
        surfaces: [{ id: 'main', file: 'surface.cjs', mode: 'managed', supports: ['vscode'] }],
      },
    }), 'utf8');
    await writeFile(join(source, 'surface.cjs'), 'module.exports={activate(){}};', 'utf8');
    const installed = await handleExtensionsBridgeMessage({
      id: 'install-1',
      type: 'api:extensions:install',
      payload: {
        expectedRevision: 0,
        source: { kind: 'local', specifier: source, display: 'Fixture' },
      },
    }, context);
    const entry = (installed?.data as { extensions?: Array<{ integrity?: string }> }).extensions?.[0];
    assert.match(entry?.integrity ?? '', /^sha256-[0-9a-f]{64}$/);
    const entrypoint = await handleExtensionsBridgeMessage({
      id: 'entrypoint-1',
      type: 'api:extensions:entrypoint',
      payload: {
        entrypointId: 'main',
        extensionId: 'dev.example.vscode',
        integrity: entry?.integrity,
        slot: 'selected',
      },
    }, context);
    assert.equal(entrypoint?.success, true);
    assert.equal((entrypoint?.data as { module?: { bytesBase64?: string } }).module?.bytesBase64, Buffer.from('module.exports={activate(){}};').toString('base64'));
  } finally {
    await rm(dataDir, { force: true, recursive: true });
  }
});
