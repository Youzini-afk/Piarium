import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { registerOpenAgentRoutes } from './openagent-routes.js';

const createConfigPayload = (overrides = {}) => ({
  plugin: { detected: false, entry: null, configPath: null },
  target: {
    scope: 'user',
    path: '/tmp/oh-my-openagent.jsonc',
    exists: true,
    format: 'jsonc',
    isLegacy: false,
    legacyPath: null,
    mtimeMs: 123,
  },
  project: {
    path: null,
    exists: false,
    overriddenAgents: [],
    overriddenCategories: [],
  },
  agents: [],
  categories: [],
  raw: {
    agents: {},
    categories: {},
    disabled_hooks: [],
  },
  ...overrides,
});

describe('oh-my-openagent config routes', () => {
  it('loads config for the requested project directory', async () => {
    const app = express();
    app.use(express.json());
    const readOpenAgentConfig = vi.fn(() => createConfigPayload());

    registerOpenAgentRoutes(app, {
      clientReloadDelayMs: 1,
      readOpenAgentConfig,
      saveOpenAgentConfig: vi.fn(),
      refreshOpenCodeAfterConfigChange: vi.fn(),
      resolveOptionalProjectDirectory: vi.fn(async () => ({ directory: '/repo/project', error: null })),
    });

    const response = await request(app)
      .get('/api/openagent/config?directory=%2Frepo%2Fproject')
      .expect(200);

    expect(readOpenAgentConfig).toHaveBeenCalledWith({ directory: '/repo/project' });
    expect(response.body.target.path).toBe('/tmp/oh-my-openagent.jsonc');
  });

  it('saves config, refreshes OpenCode, and returns the reloaded config', async () => {
    const app = express();
    app.use(express.json());
    const saveOpenAgentConfig = vi.fn(() => ({ target: { path: '/tmp/oh-my-openagent.jsonc' } }));
    const readOpenAgentConfig = vi.fn(() => createConfigPayload({
      raw: { agents: { sisyphus: { model: 'openai/gpt-5.5' } }, categories: {} },
    }));
    const refreshOpenCodeAfterConfigChange = vi.fn(async () => undefined);

    registerOpenAgentRoutes(app, {
      clientReloadDelayMs: 25,
      readOpenAgentConfig,
      saveOpenAgentConfig,
      refreshOpenCodeAfterConfigChange,
      resolveOptionalProjectDirectory: vi.fn(async () => ({ directory: null, error: null })),
    });

    const response = await request(app)
      .patch('/api/openagent/config')
      .send({
        expectedMtimeMs: 123,
        agents: { sisyphus: { model: 'openai/gpt-5.5' } },
        categories: {},
        disabled_providers: ['openai'],
        default_mode: 'ultrawork',
        hashline_edit: true,
        runtime_fallback: { enabled: true },
      })
      .expect(200);

    expect(saveOpenAgentConfig).toHaveBeenCalledWith(expect.objectContaining({
      expectedMtimeMs: 123,
      agents: { sisyphus: { model: 'openai/gpt-5.5' } },
      categories: {},
      disabled_hooks: [],
      disabled_providers: ['openai'],
      default_mode: 'ultrawork',
      hashline_edit: true,
      runtime_fallback: { enabled: true },
    }));
    expect(refreshOpenCodeAfterConfigChange).toHaveBeenCalledWith('oh-my-openagent config updated');
    expect(response.body).toMatchObject({
      success: true,
      requiresReload: true,
      reloadDelayMs: 25,
      config: {
        raw: {
          agents: { sisyphus: { model: 'openai/gpt-5.5' } },
          categories: {},
        },
      },
    });
  });

  it('returns 409 when the saved file changed on disk', async () => {
    const app = express();
    app.use(express.json());
    const error = new Error('Config was modified outside OpenChamber. Reload before saving again.');
    error.code = 'CONFIG_MODIFIED';

    registerOpenAgentRoutes(app, {
      clientReloadDelayMs: 1,
      readOpenAgentConfig: vi.fn(),
      saveOpenAgentConfig: vi.fn(() => {
        throw error;
      }),
      refreshOpenCodeAfterConfigChange: vi.fn(),
      resolveOptionalProjectDirectory: vi.fn(async () => ({ directory: null, error: null })),
    });

    const response = await request(app)
      .patch('/api/openagent/config')
      .send({ expectedMtimeMs: 1, agents: {}, categories: {} })
      .expect(409);

    expect(response.body.error).toContain('modified outside OpenChamber');
  });

  it('validates requested directory before saving config', async () => {
    const app = express();
    app.use(express.json());
    const saveOpenAgentConfig = vi.fn();

    registerOpenAgentRoutes(app, {
      readOpenAgentConfig: vi.fn(),
      saveOpenAgentConfig,
      refreshOpenCodeAfterConfigChange: vi.fn(),
      resolveOptionalProjectDirectory: vi.fn(async () => ({ directory: null, error: 'Invalid directory' })),
    });

    const response = await request(app)
      .patch('/api/openagent/config?directory=%2Fbad')
      .send({ expectedMtimeMs: 1, agents: {}, categories: {} })
      .expect(400);

    expect(response.body.error).toBe('Invalid directory');
    expect(saveOpenAgentConfig).not.toHaveBeenCalled();
  });

  it('toggles plugin registration, refreshes OpenCode, and returns the reloaded config', async () => {
    const app = express();
    app.use(express.json());
    const setOpenAgentPluginEnabled = vi.fn();
    const readOpenAgentConfig = vi.fn(() => createConfigPayload({
      plugin: {
        detected: false,
        enabled: false,
        entry: null,
        configPath: null,
        configKey: 'plugin',
        scope: 'user',
        writeTargetPath: '/tmp/opencode.json',
        mtimeMs: 456,
      },
    }));
    const refreshOpenCodeAfterConfigChange = vi.fn(async () => undefined);

    registerOpenAgentRoutes(app, {
      clientReloadDelayMs: 25,
      readOpenAgentConfig,
      saveOpenAgentConfig: vi.fn(),
      setOpenAgentPluginEnabled,
      refreshOpenCodeAfterConfigChange,
      resolveOptionalProjectDirectory: vi.fn(async () => ({ directory: '/repo/project', error: null })),
    });

    const response = await request(app)
      .patch('/api/openagent/plugin?directory=%2Frepo%2Fproject')
      .send({
        expectedMtimeMs: 123,
        enabled: false,
        entry: 'oh-my-openagent@3.11.0',
      })
      .expect(200);

    expect(setOpenAgentPluginEnabled).toHaveBeenCalledWith({
      directory: '/repo/project',
      expectedMtimeMs: 123,
      enabled: false,
      entry: 'oh-my-openagent@3.11.0',
    });
    expect(refreshOpenCodeAfterConfigChange).toHaveBeenCalledWith('oh-my-openagent plugin disabled');
    expect(response.body).toMatchObject({
      success: true,
      requiresReload: true,
      reloadDelayMs: 25,
      config: {
        plugin: {
          enabled: false,
          writeTargetPath: '/tmp/opencode.json',
        },
      },
    });
  });
});
