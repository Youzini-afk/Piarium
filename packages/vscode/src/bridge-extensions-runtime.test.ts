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
    const subscriptions: Array<{ dispose(): unknown }> = [];
    const context = {
      extension: { packageJSON: { version: '1.2.3' } },
      extensionUri: { fsPath: process.cwd() },
      globalStorageUri: { fsPath: dataDir },
      subscriptions,
    } as unknown as vscode.ExtensionContext;
    const response = await handleExtensionsBridgeMessage({
      id: 'catalog-1',
      type: 'api:extensions:catalog',
    }, context);
    assert.equal(response?.success, true);
    assert.match(String((response?.data as { snapshot?: { hostId?: string } }).snapshot?.hostId), /^[0-9a-f-]{36}$/i);
    assert.equal((response?.data as { snapshot?: { storageState?: string } }).snapshot?.storageState, 'ready');
    const initialRevision = (response?.data as { snapshot?: { revision?: number } }).snapshot?.revision ?? 0;
    const hostState = await handleExtensionsBridgeMessage({ id: 'state-1', type: 'api:extensions:host-state' }, context);
    assert.equal((hostState?.data as { services?: { hostId?: string } }).services?.hostId, (response?.data as { snapshot?: { hostId?: string } }).snapshot?.hostId);

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
        expectedRevision: initialRevision,
        source: { kind: 'local', specifier: source, display: 'Fixture' },
      },
    }, context);
    const installedSnapshot = installed?.data as { extensions?: Array<{ integrity?: string }>; revision?: number };
    const entry = installedSnapshot.extensions?.[0];
    assert.match(entry?.integrity ?? '', /^sha256-[0-9a-f]{64}$/);
    const unchanged = await handleExtensionsBridgeMessage({
      id: 'reload-unchanged',
      type: 'api:extensions:reload-local-source',
      payload: {
        expectedRevision: installedSnapshot.revision,
        extensionId: 'dev.example.vscode',
      },
    }, context);
    assert.equal((unchanged?.data as { outcome?: string }).outcome, 'unchanged');

    await writeFile(join(source, 'surface.cjs'), 'module.exports={activate(){return "changed";}};', 'utf8');
    const changed = await handleExtensionsBridgeMessage({
      id: 'reload-changed',
      type: 'api:extensions:reload-local-source',
      payload: {
        expectedRevision: installedSnapshot.revision,
        extensionId: 'dev.example.vscode',
      },
    }, context);
    const changedResult = changed?.data as {
      outcome?: string;
      snapshot?: { extensions?: Array<{ candidate?: { integrity?: string }; integrity?: string }>; revision?: number };
    };
    assert.equal(changedResult.outcome, 'staged');
    assert.match(changedResult.snapshot?.extensions?.[0]?.candidate?.integrity ?? '', /^sha256-[0-9a-f]{64}$/);
    assert.notEqual(changedResult.snapshot?.extensions?.[0]?.candidate?.integrity, entry?.integrity);
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
    const disabled = await handleExtensionsBridgeMessage({
      id: 'disable-before-remove',
      type: 'api:extensions:set-enabled',
      payload: {
        enabled: false,
        expectedRevision: changedResult.snapshot?.revision,
        extensionId: 'dev.example.vscode',
      },
    }, context);
    const disabledRevision = (disabled?.data as { revision?: number }).revision;
    const removed = await handleExtensionsBridgeMessage({
      id: 'remove-with-data',
      type: 'api:extensions:remove',
      payload: {
        deleteData: true,
        expectedRevision: disabledRevision,
        extensionId: 'dev.example.vscode',
      },
    }, context);
    const remaining = (removed?.data as { extensions?: Array<{ manifest?: { id?: string } }> }).extensions ?? [];
    assert.equal(remaining.some((candidate) => candidate.manifest?.id === 'dev.example.vscode'), false);
    assert.equal(remaining.some((candidate) => candidate.manifest?.id?.startsWith('piarium.builtin.') === true), true);
    for (const disposable of subscriptions) await disposable.dispose();
  } finally {
    await rm(dataDir, { force: true, recursive: true });
  }
});
