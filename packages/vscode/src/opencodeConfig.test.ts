import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type OpenCodeConfigModule = {
  createPluginEntry: (entry: { spec: string; scope?: 'user' | 'project' }, workingDirectory?: string) => void;
  listPluginEntries: (workingDirectory?: string) => Array<{ spec: string; scope: string }>;
};

let importCounter = 0;

async function loadConfigModule(configDir: string): Promise<OpenCodeConfigModule> {
  process.env.OPENCODE_CONFIG_DIR = configDir;
  delete process.env.OPENCODE_CONFIG;
  importCounter += 1;
  return await import(`./opencodeConfig?test=${Date.now()}-${importCounter}`) as OpenCodeConfigModule;
}

describe('VS Code opencode config parity', () => {
  test('prefers opencode.jsonc over legacy config.json when listing plugins', async () => {
    const originalConfigDir = process.env.OPENCODE_CONFIG_DIR;
    const originalConfig = process.env.OPENCODE_CONFIG;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-config-'));

    try {
      fs.writeFileSync(path.join(root, 'config.json'), '{ "plugin": [] }\n');
      fs.writeFileSync(path.join(root, 'opencode.jsonc'), '{ "plugin": ["oh-my-openagent"] }\n');

      const { listPluginEntries } = await loadConfigModule(root);

      assert.deepEqual(
        listPluginEntries().map((entry) => entry.spec),
        ['oh-my-openagent'],
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      if (originalConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
      else process.env.OPENCODE_CONFIG_DIR = originalConfigDir;
      if (originalConfig === undefined) delete process.env.OPENCODE_CONFIG;
      else process.env.OPENCODE_CONFIG = originalConfig;
    }
  });

  test('creates new user plugin entries in opencode.jsonc by default', async () => {
    const originalConfigDir = process.env.OPENCODE_CONFIG_DIR;
    const originalConfig = process.env.OPENCODE_CONFIG;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-config-'));

    try {
      const { createPluginEntry, listPluginEntries } = await loadConfigModule(root);

      createPluginEntry({ spec: 'oh-my-openagent' });

      assert.equal(fs.existsSync(path.join(root, 'opencode.jsonc')), true);
      assert.equal(fs.existsSync(path.join(root, 'config.json')), false);
      assert.deepEqual(
        listPluginEntries().map((entry) => entry.spec),
        ['oh-my-openagent'],
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      if (originalConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
      else process.env.OPENCODE_CONFIG_DIR = originalConfigDir;
      if (originalConfig === undefined) delete process.env.OPENCODE_CONFIG;
      else process.env.OPENCODE_CONFIG = originalConfig;
    }
  });
});
