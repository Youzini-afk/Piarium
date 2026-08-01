import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { registerMagicContextRoutes } from './magic-context-routes.js';

const createConfigPayload = (overrides = {}) => ({
  plugin: { detected: false, entry: null, configPath: null },
  target: {
    scope: 'user',
    path: '/tmp/magic-context.jsonc',
    exists: true,
    format: 'jsonc',
    mtimeMs: 123,
  },
  project: {
    path: null,
    exists: false,
    overriddenKeys: [],
  },
  raw: {},
  ...overrides,
});

describe('magic-context config routes', () => {
  it('loads config for the requested project directory', async () => {
    const app = express();
    app.use(express.json());
    const readMagicContextConfig = vi.fn(() => createConfigPayload());

    registerMagicContextRoutes(app, {
      clientReloadDelayMs: 1,
      readMagicContextConfig,
      saveMagicContextConfig: vi.fn(),
      refreshOpenCodeAfterConfigChange: vi.fn(),
      resolveOptionalProjectDirectory: vi.fn(async () => ({ directory: '/repo/project', error: null })),
    });

    const response = await request(app)
      .get('/api/magic-context/config?directory=%2Frepo%2Fproject')
      .expect(200);

    expect(readMagicContextConfig).toHaveBeenCalledWith({ directory: '/repo/project' });
    expect(response.body.target.path).toBe('/tmp/magic-context.jsonc');
  });

  it('saves config, refreshes OpenCode, and returns the reloaded config', async () => {
    const app = express();
    app.use(express.json());
    const saveMagicContextConfig = vi.fn();
    const readMagicContextConfig = vi.fn(() => createConfigPayload({
      raw: { enabled: true, historian: { model: 'openai/gpt-5.4' } },
    }));
    const refreshOpenCodeAfterConfigChange = vi.fn(async () => undefined);

    registerMagicContextRoutes(app, {
      clientReloadDelayMs: 25,
      readMagicContextConfig,
      saveMagicContextConfig,
      refreshOpenCodeAfterConfigChange,
      resolveOptionalProjectDirectory: vi.fn(async () => ({ directory: null, error: null })),
    });

    const response = await request(app)
      .patch('/api/magic-context/config')
      .send({
        expectedMtimeMs: 123,
        config: { enabled: true, historian: { model: 'openai/gpt-5.4' } },
      })
      .expect(200);

    expect(saveMagicContextConfig).toHaveBeenCalledWith({
      expectedMtimeMs: 123,
      sourcePath: null,
      sourceMtimeMs: null,
      directory: null,
      config: { enabled: true, historian: { model: 'openai/gpt-5.4' } },
    });
    expect(refreshOpenCodeAfterConfigChange).toHaveBeenCalledWith('magic-context config updated');
    expect(response.body).toMatchObject({
      success: true,
      requiresReload: true,
      reloadDelayMs: 25,
      config: {
        raw: { enabled: true, historian: { model: 'openai/gpt-5.4' } },
      },
    });
  });

  it('returns 409 when the saved file changed on disk', async () => {
    const app = express();
    app.use(express.json());
    const error = new Error('Config was modified outside OpenChamber. Reload before saving again.');
    error.code = 'CONFIG_MODIFIED';

    registerMagicContextRoutes(app, {
      clientReloadDelayMs: 1,
      readMagicContextConfig: vi.fn(),
      saveMagicContextConfig: vi.fn(() => {
        throw error;
      }),
      refreshOpenCodeAfterConfigChange: vi.fn(),
      resolveOptionalProjectDirectory: vi.fn(async () => ({ directory: null, error: null })),
    });

    const response = await request(app)
      .patch('/api/magic-context/config')
      .send({ expectedMtimeMs: 1, config: {} })
      .expect(409);

    expect(response.body.error).toContain('modified outside OpenChamber');
  });

  it('resolves and validates the directory before saving or refreshing OpenCode', async () => {
    const app = express();
    app.use(express.json());
    const saveMagicContextConfig = vi.fn();
    const refreshOpenCodeAfterConfigChange = vi.fn();

    registerMagicContextRoutes(app, {
      clientReloadDelayMs: 1,
      readMagicContextConfig: vi.fn(() => createConfigPayload()),
      saveMagicContextConfig,
      refreshOpenCodeAfterConfigChange,
      resolveOptionalProjectDirectory: vi.fn(async () => ({ directory: null, error: 'Invalid workspace directory' })),
    });

    const response = await request(app)
      .patch('/api/magic-context/config?directory=%2Fbad')
      .send({ expectedMtimeMs: 1, config: {} })
      .expect(400);

    expect(response.body.error).toBe('Invalid workspace directory');
    expect(saveMagicContextConfig).not.toHaveBeenCalled();
    expect(refreshOpenCodeAfterConfigChange).not.toHaveBeenCalled();
  });
});
