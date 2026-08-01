import { afterEach, describe, expect, mock, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

mock.module('vscode', () => ({
  workspace: {
    workspaceFolders: [],
    getConfiguration: () => ({ get: () => undefined }),
  },
}));

const { handleConfigBridgeMessage } = await import('./bridge-config-runtime.ts');
const { handleSystemBridgeMessage } = await import('./bridge-system-runtime.ts');

const tempRoots = [];
const originalOpencodeConfig = process.env.OPENCODE_CONFIG;
const originalOpencodeConfigDir = process.env.OPENCODE_CONFIG_DIR;
const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;

const createCtx = (workingDirectory, restartImpl = async () => undefined) => {
  const restart = mock(restartImpl);
  return {
    restart,
    manager: {
      getWorkingDirectory: () => workingDirectory,
      restart,
    },
  };
};

const deps = {
  readSettings: () => ({}),
  persistSettings: async (changes) => changes,
  readMagicPromptOverrides: () => ({ version: 1, overrides: {} }),
  saveMagicPromptOverride: async () => ({ version: 1, overrides: {} }),
  resetMagicPromptOverride: async () => ({ version: 1, overrides: {} }),
  resetAllMagicPromptOverrides: async () => ({ version: 1, overrides: {} }),
  fetchOpenCodeSkillsFromApi: async () => null,
  clientReloadDelayMs: 800,
};

afterEach(() => {
  if (originalOpencodeConfig === undefined) {
    delete process.env.OPENCODE_CONFIG;
  } else {
    process.env.OPENCODE_CONFIG = originalOpencodeConfig;
  }

  if (originalOpencodeConfigDir === undefined) {
    delete process.env.OPENCODE_CONFIG_DIR;
  } else {
    process.env.OPENCODE_CONFIG_DIR = originalOpencodeConfigDir;
  }

  if (originalXdgConfigHome === undefined) {
    delete process.env.XDG_CONFIG_HOME;
  } else {
    process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
  }

  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const readJson = (filePath) => JSON.parse(fs.readFileSync(filePath, 'utf8'));

describe('VS Code config bridge plugin parity', () => {
  test('returns provider sources in the same flattened shape as the web route', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-provider-sources-'));
    tempRoots.push(root);
    const ctx = createCtx(root);

    const configDir = path.join(root, '.opencode');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'opencode.json'),
      JSON.stringify({ provider: { 'custom-provider': { npm: '@example/provider' } } }, null, 2),
      'utf8',
    );

    const response = await handleSystemBridgeMessage({
      id: 'sources',
      type: 'api:provider/source:get',
      payload: { providerId: 'custom-provider', directory: root },
    }, ctx, {
      resolveUserPath: (value) => value,
      fetchModelsMetadata: async () => ({}),
      updateCheckUrl: 'https://updates.example',
      clientReloadDelayMs: 800,
    });

    expect(response?.success).toBe(true);
    expect(response?.data).toEqual({
      providerId: 'custom-provider',
      sources: {
        auth: { exists: false },
        user: expect.objectContaining({ exists: false }),
        project: expect.objectContaining({ exists: true }),
        custom: expect.objectContaining({ exists: false }),
      },
    });
    expect(response?.data?.sources?.sources).toBeUndefined();
  });

  test('removes agent fields when update payload sends null', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-agent-null-'));
    tempRoots.push(root);
    const ctx = createCtx(root);
    const configDir = path.join(root, '.opencode');
    const configPath = path.join(configDir, 'opencode.json');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({
      agent: {
        build: {
          variant: 'fast',
          temperature: 0.3,
          top_p: 0.8,
          mode: 'subagent',
        },
      },
    }, null, 2), 'utf8');

    const updated = await handleConfigBridgeMessage({
      id: 'update-agent-null-fields',
      type: 'api:config/agents',
      payload: {
        method: 'PATCH',
        name: 'build',
        directory: root,
        body: { variant: null, temperature: null, top_p: null },
      },
    }, ctx, deps);

    expect(updated?.success).toBe(true);
    expect(readJson(configPath).agent.build).toEqual({ mode: 'subagent' });
  });

  test('creates, lists, updates, and deletes project plugin entries', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-plugins-'));
    tempRoots.push(root);
    const ctx = createCtx(root);

    const created = await handleConfigBridgeMessage({
      id: 'create',
      type: 'api:config/plugins',
      payload: {
        method: 'POST',
        target: 'entry',
        directory: root,
        body: { scope: 'project', spec: 'plugin-a', options: { enabled: true } },
      },
    }, ctx, deps);

    expect(created?.success).toBe(true);
    expect(ctx.restart).toHaveBeenCalledTimes(1);

    const listed = await handleConfigBridgeMessage({
      id: 'list',
      type: 'api:config/plugins',
      payload: { method: 'GET', target: 'list', directory: root },
    }, ctx, deps);
    const entries = listed?.data?.entries || [];
    const entry = entries.find((candidate) => candidate.spec === 'plugin-a');
    expect(entry?.scope).toBe('project');

    const updated = await handleConfigBridgeMessage({
      id: 'update',
      type: 'api:config/plugins',
      payload: {
        method: 'PATCH',
        target: 'entry',
        directory: root,
        pluginId: entry?.id,
        body: { spec: 'plugin-b' },
      },
    }, ctx, deps);
    expect(updated?.success).toBe(true);

    const config = JSON.parse(fs.readFileSync(path.join(root, '.opencode', 'opencode.json'), 'utf8'));
    expect(config.plugin).toEqual([['plugin-b', { enabled: true }]]);

    const relisted = await handleConfigBridgeMessage({
      id: 'relist',
      type: 'api:config/plugins',
      payload: { method: 'GET', target: 'list', directory: root },
    }, ctx, deps);
    const updatedEntry = (relisted?.data?.entries || []).find((candidate) => candidate.spec === 'plugin-b');

    const deleted = await handleConfigBridgeMessage({
      id: 'delete',
      type: 'api:config/plugins',
      payload: { method: 'DELETE', target: 'entry', directory: root, pluginId: updatedEntry?.id },
    }, ctx, deps);
    expect(deleted?.success).toBe(true);
  });

  test('creates and reads project plugin files', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-plugin-files-'));
    tempRoots.push(root);
    const ctx = createCtx(root);

    const created = await handleConfigBridgeMessage({
      id: 'create-file',
      type: 'api:config/plugins',
      payload: {
        method: 'POST',
        target: 'file',
        directory: root,
        body: { scope: 'project', fileName: 'demo-plugin.ts', content: 'export default {}' },
      },
    }, ctx, deps);
    expect(created?.success).toBe(true);

    const listed = await handleConfigBridgeMessage({
      id: 'list',
      type: 'api:config/plugins',
      payload: { method: 'GET', target: 'list', directory: root },
    }, ctx, deps);
    const files = listed?.data?.files || [];
    const file = files.find((candidate) => candidate.fileName === 'demo-plugin.ts');
    expect(file?.scope).toBe('project');

    const read = await handleConfigBridgeMessage({
      id: 'read-file',
      type: 'api:config/plugins',
      payload: { method: 'GET', target: 'file', directory: root, pluginId: file?.id },
    }, ctx, deps);
    expect(read?.data).toEqual({ fileName: 'demo-plugin.ts', scope: 'project', content: 'export default {}' });
  });

  test('updates and deletes user plugin entries from OPENCODE_CONFIG source', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-custom-config-'));
    tempRoots.push(root);
    const configDir = path.join(root, 'custom-config');
    const configPath = path.join(configDir, 'opencode.json');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ plugin: ['custom-plugin'] }, null, 2), 'utf8');
    process.env.OPENCODE_CONFIG = configPath;
    const ctx = createCtx(root);

    const listed = await handleConfigBridgeMessage({
      id: 'list-custom',
      type: 'api:config/plugins',
      payload: { method: 'GET', target: 'list', directory: root },
    }, ctx, deps);
    const entry = (listed?.data?.entries || []).find((candidate) => candidate.spec === 'custom-plugin');
    expect(entry?.scope).toBe('user');

    const updated = await handleConfigBridgeMessage({
      id: 'update-custom',
      type: 'api:config/plugins',
      payload: {
        method: 'PATCH',
        target: 'entry',
        directory: root,
        pluginId: entry?.id,
        body: { spec: 'custom-plugin-next' },
      },
    }, ctx, deps);
    expect(updated?.success).toBe(true);
    expect(readJson(configPath).plugin).toEqual(['custom-plugin-next']);

    const relisted = await handleConfigBridgeMessage({
      id: 'relist-custom',
      type: 'api:config/plugins',
      payload: { method: 'GET', target: 'list', directory: root },
    }, ctx, deps);
    const updatedEntry = (relisted?.data?.entries || []).find((candidate) => candidate.spec === 'custom-plugin-next');

    const deleted = await handleConfigBridgeMessage({
      id: 'delete-custom',
      type: 'api:config/plugins',
      payload: { method: 'DELETE', target: 'entry', directory: root, pluginId: updatedEntry?.id },
    }, ctx, deps);
    expect(deleted?.success).toBe(true);
    expect(readJson(configPath).plugin).toBeUndefined();
  });

  test('writes user plugin files next to OPENCODE_CONFIG', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-custom-files-'));
    tempRoots.push(root);
    const configDir = path.join(root, 'custom-config');
    const configPath = path.join(configDir, 'opencode.json');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(configPath, '{}', 'utf8');
    process.env.OPENCODE_CONFIG = configPath;
    const ctx = createCtx(root);

    const created = await handleConfigBridgeMessage({
      id: 'create-custom-file',
      type: 'api:config/plugins',
      payload: {
        method: 'POST',
        target: 'file',
        directory: root,
        body: { scope: 'user', fileName: 'demo-plugin.ts', content: 'export default {}' },
      },
    }, ctx, deps);

    expect(created?.success).toBe(true);
    expect(fs.readFileSync(path.join(configDir, 'plugins', 'demo-plugin.ts'), 'utf8')).toBe('export default {}');
  });

  test('reports plugin mutation success when restart fails after writing config', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-plugin-restart-'));
    tempRoots.push(root);
    const ctx = createCtx(root, async () => {
      throw new Error('restart failed');
    });

    const created = await handleConfigBridgeMessage({
      id: 'create-restart-failure',
      type: 'api:config/plugins',
      payload: {
        method: 'POST',
        target: 'entry',
        directory: root,
        body: { scope: 'project', spec: 'plugin-restart' },
      },
    }, ctx, deps);

    expect(created?.success).toBe(true);
    expect(created?.data).toMatchObject({ success: true, requiresReload: false, reloadFailed: true });
    expect(created?.data?.warning).toContain('restart failed');
    expect(readJson(path.join(root, '.opencode', 'opencode.json')).plugin).toEqual(['plugin-restart']);
  });
});

describe('VS Code config bridge save payload preservation', () => {
  test('openagent config save preserves extended OpenAgent save fields', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-openagent-save-'));
    tempRoots.push(root);
    const configDir = path.join(root, 'config');
    fs.mkdirSync(configDir, { recursive: true });
    process.env.OPENCODE_CONFIG_DIR = configDir;
    const ctx = createCtx(root);

    const response = await handleConfigBridgeMessage({
      id: 'openagent-save-extended',
      type: 'api:openagent:config:save',
      payload: {
        directory: root,
        expectedMtimeMs: null,
        agents: {},
        categories: {},
        disabled_hooks: ['context-window-monitor'],
        disabled_skills: ['skill-a'],
        disabled_commands: ['cmd-a'],
        disabled_tools: ['tool-a'],
        disabled_mcps: ['mcp-a'],
        disabled_providers: ['prov-a'],
        mcp_env_allowlist: ['ENV_VAR'],
        default_mode: 'subagent',
        hashline_edit: true,
        model_fallback: true,
        runtime_fallback: { enabled: true },
        background_task: { enabled: true },
        team_mode: { enabled: true },
        model_capabilities: { gemini: true },
        experimental: { feature_x: true },
        skills: { custom: {} },
        tmux: { enabled: true },
      },
    }, ctx, deps);

    expect(response?.success).toBe(true);
    expect(response?.data?.success).toBe(true);
    const raw = response?.data?.config?.raw;
    expect(raw?.disabled_hooks).toEqual(['context-window-monitor']);
    expect(raw?.disabled_skills).toEqual(['skill-a']);
    expect(raw?.disabled_commands).toEqual(['cmd-a']);
    expect(raw?.disabled_tools).toEqual(['tool-a']);
    expect(raw?.disabled_mcps).toEqual(['mcp-a']);
    expect(raw?.disabled_providers).toEqual(['prov-a']);
    expect(raw?.mcp_env_allowlist).toEqual(['ENV_VAR']);
    expect(raw?.default_mode).toBe('subagent');
    expect(raw?.hashline_edit).toBe(true);
    expect(raw?.model_fallback).toBe(true);
    expect(raw?.runtime_fallback).toEqual({ enabled: true });
    expect(raw?.background_task).toEqual({ enabled: true });
    expect(raw?.team_mode).toEqual({ enabled: true });
    expect(raw?.model_capabilities).toEqual({ gemini: true });
    expect(raw?.experimental).toEqual({ feature_x: true });
    expect(raw?.skills).toEqual({ custom: {} });
    expect(raw?.tmux).toEqual({ enabled: true });
  });

  test('magic-context config save preserves sourcePath and sourceMtimeMs from legacy source', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-magic-context-save-'));
    tempRoots.push(root);
    process.env.XDG_CONFIG_HOME = path.join(root, 'xdg');
    const legacyDir = path.join(root, '.opencode');
    fs.mkdirSync(legacyDir, { recursive: true });
    const sourcePath = path.join(legacyDir, 'magic-context.json');
    fs.writeFileSync(sourcePath, JSON.stringify({ enabled: true, ctx_reduce_enabled: true }, null, 2), 'utf8');
    const sourceMtimeMs = fs.statSync(sourcePath).mtimeMs;
    const ctx = createCtx(root);

    const response = await handleConfigBridgeMessage({
      id: 'magic-context-save-source',
      type: 'api:magic-context:config:save',
      payload: {
        directory: root,
        expectedMtimeMs: null,
        sourcePath,
        sourceMtimeMs,
        config: { enabled: true, ctx_reduce_enabled: true },
      },
    }, ctx, deps);

    expect(response?.success).toBe(true);
    expect(response?.data?.success).toBe(true);
    // Target file is created under the CortexKit config dir, seeded from the legacy source.
    const targetPath = path.join(root, 'xdg', 'cortexkit', 'magic-context.jsonc');
    expect(fs.existsSync(targetPath)).toBe(true);
    const saved = JSON.parse(fs.readFileSync(targetPath, 'utf8'));
    expect(saved.enabled).toBe(true);
    expect(saved.ctx_reduce_enabled).toBe(true);
    // Read-back config exposes the preserved values via raw.
    expect(response?.data?.config?.raw?.enabled).toBe(true);
    expect(response?.data?.config?.raw?.ctx_reduce_enabled).toBe(true);
  });

  test('magic-context config save rejects with 409 when sourceMtimeMs mismatches', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-magic-context-conflict-'));
    tempRoots.push(root);
    process.env.XDG_CONFIG_HOME = path.join(root, 'xdg');
    const legacyDir = path.join(root, '.opencode');
    fs.mkdirSync(legacyDir, { recursive: true });
    const sourcePath = path.join(legacyDir, 'magic-context.json');
    fs.writeFileSync(sourcePath, JSON.stringify({ enabled: true }, null, 2), 'utf8');
    const ctx = createCtx(root);

    const response = await handleConfigBridgeMessage({
      id: 'magic-context-save-conflict',
      type: 'api:magic-context:config:save',
      payload: {
        directory: root,
        expectedMtimeMs: null,
        sourcePath,
        sourceMtimeMs: 1,
        config: { enabled: true },
      },
    }, ctx, deps);

    // sourceMtimeMs is honored: a mismatch yields a CONFIG_MODIFIED (409) error
    // and the target file is left unwritten.
    expect(response?.success).toBe(true);
    expect(response?.data?.status).toBe(409);
    expect(response?.data?.error).toBeTruthy();
    expect(fs.existsSync(path.join(root, 'xdg', 'cortexkit', 'magic-context.jsonc'))).toBe(false);
  });
});
