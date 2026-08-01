import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import request from 'supertest';
import { registerOpenCodeRoutes } from './routes.js';

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const originalOpenCodeConfig = process.env.OPENCODE_CONFIG;
const originalOpenCodeConfigDir = process.env.OPENCODE_CONFIG_DIR;
const originalOpenCodeAuthDir = process.env.OPENCODE_AUTH_DIR;

let tempHome;

async function loadProvidersModule() {
  return import(/* @vite-ignore */ `./providers.js?test=${Date.now()}-${Math.random()}`);
}

describe('provider config helpers', () => {
  beforeAll(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-provider-test-'));
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    process.env.OPENCODE_CONFIG_DIR = path.join(tempHome, '.config', 'opencode');
    process.env.OPENCODE_AUTH_DIR = path.join(tempHome, '.local', 'share', 'opencode');
    delete process.env.OPENCODE_CONFIG;
  });

  beforeEach(() => {
    if (!tempHome) {
      return;
    }

    for (const entry of fs.readdirSync(tempHome)) {
      fs.rmSync(path.join(tempHome, entry), { recursive: true, force: true });
    }
  });

  afterAll(() => {
    process.env.HOME = originalHome;
    process.env.USERPROFILE = originalUserProfile;
    if (originalOpenCodeConfig === undefined) {
      delete process.env.OPENCODE_CONFIG;
    } else {
      process.env.OPENCODE_CONFIG = originalOpenCodeConfig;
    }
    if (originalOpenCodeConfigDir === undefined) {
      delete process.env.OPENCODE_CONFIG_DIR;
    } else {
      process.env.OPENCODE_CONFIG_DIR = originalOpenCodeConfigDir;
    }
    if (originalOpenCodeAuthDir === undefined) {
      delete process.env.OPENCODE_AUTH_DIR;
    } else {
      process.env.OPENCODE_AUTH_DIR = originalOpenCodeAuthDir;
    }
    if (tempHome) {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
    tempHome = undefined;
  });

  it('writes an OpenAI-compatible custom provider to the user config', async () => {
    const { upsertProviderConfig } = await loadProvidersModule();

    const result = upsertProviderConfig({
      id: 'my-openai',
      name: 'My OpenAI',
      baseURL: 'https://api.example.com/v1',
      models: [{ id: 'gpt-4o', name: 'GPT 4o' }],
    });

    const configPath = path.join(tempHome, '.config', 'opencode', 'config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

    expect(result).toEqual({
      providerId: 'my-openai',
      scope: 'user',
      path: configPath,
    });
    expect(config.provider['my-openai']).toEqual({
      npm: '@ai-sdk/openai-compatible',
      name: 'My OpenAI',
      options: {
        baseURL: 'https://api.example.com/v1',
      },
      models: {
        'gpt-4o': {
          name: 'GPT 4o',
        },
      },
    });
  });

  it('preserves existing providers while adding multiple models', async () => {
    const configPath = path.join(tempHome, '.config', 'opencode', 'config.json');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({
      provider: {
        existing: {
          npm: '@ai-sdk/openai-compatible',
          name: 'Existing',
          options: { baseURL: 'https://existing.example.com/v1' },
          models: { old: { name: 'Old' } },
        },
      },
    }, null, 2));

    const { upsertProviderConfig } = await loadProvidersModule();

    upsertProviderConfig({
      id: 'deepseek-compatible',
      name: 'DeepSeek Compatible',
      baseURL: 'https://api.deepseek.com',
      models: [
        { id: 'deepseek-chat', name: 'DeepSeek Chat' },
        { id: 'deepseek-reasoner' },
      ],
    });

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

    expect(config.provider.existing.name).toBe('Existing');
    expect(config.provider['deepseek-compatible'].models).toEqual({
      'deepseek-chat': { name: 'DeepSeek Chat' },
      'deepseek-reasoner': {},
    });
  });

  it('writes custom model context and output token limits', async () => {
    const { upsertProviderConfig } = await loadProvidersModule();

    upsertProviderConfig({
      id: 'context-provider',
      name: 'Context Provider',
      baseURL: 'https://api.example.com/v1',
      models: [
        {
          id: 'long-context-model',
          name: 'Long Context Model',
          context: 200000,
          output: 8192,
        },
      ],
    });

    const configPath = path.join(tempHome, '.config', 'opencode', 'config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

    expect(config.provider['context-provider'].models['long-context-model']).toEqual({
      name: 'Long Context Model',
      limit: {
        context: 200000,
        output: 8192,
      },
    });
  });

  it('writes custom model image input capability', async () => {
    const { upsertProviderConfig } = await loadProvidersModule();

    upsertProviderConfig({
      id: 'vision-provider',
      name: 'Vision Provider',
      baseURL: 'https://api.example.com/v1',
      models: [
        {
          id: 'vision-model',
          name: 'Vision Model',
          attachment: true,
        },
      ],
    });

    const configPath = path.join(tempHome, '.config', 'opencode', 'config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

    expect(config.provider['vision-provider'].models['vision-model']).toEqual({
      name: 'Vision Model',
      attachment: true,
      modalities: {
        input: ['text', 'image'],
        output: ['text'],
      },
    });
  });

  it('writes custom model tool, reasoning, and reasoning effort metadata', async () => {
    const { upsertProviderConfig } = await loadProvidersModule();

    upsertProviderConfig({
      id: 'reasoning-provider',
      name: 'Reasoning Provider',
      baseURL: 'https://api.example.com/v1',
      models: [
        {
          id: 'reasoning-model',
          name: 'Reasoning Model',
          tool_call: true,
          reasoning: true,
          reasoningEffort: 'xhigh',
        },
      ],
    });

    const configPath = path.join(tempHome, '.config', 'opencode', 'config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

    expect(config.provider['reasoning-provider'].models['reasoning-model']).toEqual({
      name: 'Reasoning Model',
      tool_call: true,
      reasoning: true,
      options: {
        reasoningEffort: 'xhigh',
      },
      variants: {
        none: { reasoningEffort: 'none' },
        minimal: { reasoningEffort: 'minimal' },
        low: { reasoningEffort: 'low' },
        medium: { reasoningEffort: 'medium' },
        high: { reasoningEffort: 'high' },
        xhigh: { reasoningEffort: 'xhigh' },
        max: { reasoningEffort: 'max' },
      },
    });
  });

  it('defaults the output token limit when only the context token limit is configured', async () => {
    const { upsertProviderConfig } = await loadProvidersModule();

    upsertProviderConfig({
      id: 'optional-output-provider',
      name: 'Optional Output Provider',
      baseURL: 'https://api.example.com/v1',
      models: [
        {
          id: 'context-only-model',
          name: 'Context Only Model',
          context: 128000,
          output: '',
        },
      ],
    });

    const configPath = path.join(tempHome, '.config', 'opencode', 'config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

    expect(config.provider['optional-output-provider'].models['context-only-model']).toEqual({
      name: 'Context Only Model',
      limit: {
        context: 128000,
        output: 8192,
      },
    });
  });

  it('normalizes custom provider model limit aliases to standard limit metadata', async () => {
    const { upsertProviderConfig, getProviderConfig } = await loadProvidersModule();

    upsertProviderConfig({
      id: 'limit-alias-provider',
      name: 'Limit Alias Provider',
      baseURL: 'https://api.example.com/v1',
      models: [
        {
          id: 'window-model',
          name: 'Window Model',
          context_window: '256,000',
          max_output_tokens: '16,384',
        },
        {
          id: 'input-token-model',
          inputTokenLimit: 128000,
          outputTokenLimit: 8192,
        },
        {
          id: 'fallback-model',
          context: '',
          output: '0',
          limit: {
            context_window: 64000,
            max_output_tokens: 4096,
          },
        },
      ],
    });

    const configPath = path.join(tempHome, '.config', 'opencode', 'config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

    expect(config.provider['limit-alias-provider'].models['window-model']).toEqual({
      name: 'Window Model',
      limit: {
        context: 256000,
        output: 16384,
      },
    });
    expect(config.provider['limit-alias-provider'].models['input-token-model']).toEqual({
      limit: {
        context: 128000,
        output: 8192,
      },
    });
    expect(config.provider['limit-alias-provider'].models['fallback-model']).toEqual({
      limit: {
        context: 64000,
        output: 4096,
      },
    });
    expect(getProviderConfig('limit-alias-provider').models).toMatchObject([
      {
        id: 'window-model',
        context: 256000,
        output: 16384,
      },
      {
        id: 'input-token-model',
        context: 128000,
        output: 8192,
      },
      {
        id: 'fallback-model',
        context: 64000,
        output: 4096,
      },
    ]);
  });

  it('preserves fetched model limits when only one side is available', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        data: [
          { id: 'context-only', context_window: 128000 },
          { id: 'complete-limit', context_window: 128000, max_output_tokens: 8192 },
        ],
      }),
    }));
    const { fetchProviderModels } = await loadProvidersModule();

    const result = await fetchProviderModels({
      type: 'openai-compatible',
      baseURL: 'https://api.example.com/v1',
      apiKey: 'sk-test',
    }, fetchMock);

    expect(result.models).toEqual([
      {
        id: 'context-only',
        name: 'context-only',
        limit: {
          context: 128000,
          output: 8192,
        },
      },
      {
        id: 'complete-limit',
        name: 'complete-limit',
        limit: {
          context: 128000,
          output: 8192,
        },
      },
    ]);
  });

  it('reads an existing custom provider config for editing', async () => {
    const configPath = path.join(tempHome, '.config', 'opencode', 'config.json');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({
      provider: {
        editable: {
          npm: '@ai-sdk/anthropic',
          name: 'Editable Provider',
          options: { baseURL: 'https://api.example.com/v1' },
          models: {
            'claude-test': {
              name: 'Claude Test',
              attachment: true,
              tool_call: true,
              reasoning: true,
              modalities: {
                input: ['text', 'image'],
                output: ['text'],
              },
              options: {
                reasoningEffort: 'max',
                providerSpecific: 'keep-me',
              },
              variants: {
                high: {
                  reasoningEffort: 'high',
                  textVerbosity: 'low',
                },
                max: {
                  reasoningEffort: 'max',
                },
              },
              limit: {
                context: 200000,
                output: 8192,
              },
            },
            'nameless-model': {},
          },
        },
      },
    }, null, 2));

    const { getProviderConfig } = await loadProvidersModule();

    expect(getProviderConfig('editable')).toEqual({
      providerId: 'editable',
      type: 'anthropic',
      name: 'Editable Provider',
      baseURL: 'https://api.example.com/v1',
      scope: 'user',
      path: configPath,
      models: [
        {
          id: 'claude-test',
          name: 'Claude Test',
          context: 200000,
          output: 8192,
          attachment: true,
          tool_call: true,
          reasoning: true,
          reasoningEffort: 'max',
          variants: {
            high: {
              reasoningEffort: 'high',
              textVerbosity: 'low',
            },
            max: {
              reasoningEffort: 'max',
            },
          },
          options: {
            providerSpecific: 'keep-me',
          },
        },
        {
          id: 'nameless-model',
          name: '',
        },
      ],
    });
  });

  it.each([
    ['openai-compatible', '@ai-sdk/openai-compatible'],
    ['openai-responses', '@ai-sdk/openai'],
    ['anthropic', '@ai-sdk/anthropic'],
    ['google', '@ai-sdk/google'],
  ])('writes a %s custom provider using the expected AI SDK package', async (type, expectedNpm) => {
    const { upsertProviderConfig } = await loadProvidersModule();

    upsertProviderConfig({
      type,
      id: `custom-${type}`,
      name: `Custom ${type}`,
      baseURL: 'https://api.example.com/v1',
      models: [{ id: 'model-1', name: 'Model One' }],
    });

    const configPath = path.join(tempHome, '.config', 'opencode', 'config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

    expect(config.provider[`custom-${type}`]).toMatchObject({
      npm: expectedNpm,
      name: `Custom ${type}`,
      options: {
        baseURL: 'https://api.example.com/v1',
      },
      models: {
        'model-1': {
          name: 'Model One',
        },
      },
    });
  });

  it('rejects unsupported custom provider API types', async () => {
    const { upsertProviderConfig } = await loadProvidersModule();

    expect(() => upsertProviderConfig({
      type: 'not-real',
      id: 'bad-provider',
      baseURL: 'https://api.example.com/v1',
      models: [{ id: 'model-1' }],
    })).toThrow('Unsupported custom provider API type');
  });

  it('fetches OpenAI-compatible models with bearer authentication', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        data: [
          { id: 'gpt-4o', owned_by: 'openai' },
          {
            id: 'deepseek-chat',
            modalities: { input: ['text', 'image'], output: ['text'] },
            capabilities: { tool_call: true, reasoning: true },
            options: { reasoningEffort: 'high' },
          },
        ],
      }),
    }));
    const { fetchProviderModels } = await loadProvidersModule();

    const result = await fetchProviderModels({
      type: 'openai-compatible',
      baseURL: 'https://api.example.com/v1/',
      apiKey: 'sk-test',
    }, fetchMock);

    expect(fetchMock).toHaveBeenCalledWith('https://api.example.com/v1/models', {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: 'Bearer sk-test',
      },
    });
    expect(result.models).toEqual([
      { id: 'gpt-4o', name: 'gpt-4o' },
      {
        id: 'deepseek-chat',
        name: 'deepseek-chat',
        attachment: true,
        tool_call: true,
        reasoning: true,
        options: {
          reasoningEffort: 'high',
        },
      },
    ]);
  });

  it('fetches Gemini models with an API key query parameter', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        models: [
          { name: 'models/gemini-2.5-pro', displayName: 'Gemini 2.5 Pro', inputTokenLimit: 1048576, outputTokenLimit: 65536 },
          { name: 'models/gemini-2.5-flash' },
        ],
      }),
    }));
    const { fetchProviderModels } = await loadProvidersModule();

    const result = await fetchProviderModels({
      type: 'google',
      baseURL: 'https://generativelanguage.googleapis.com/v1beta',
      apiKey: 'gemini-key',
    }, fetchMock);

    expect(fetchMock).toHaveBeenCalledWith('https://generativelanguage.googleapis.com/v1beta/models?key=gemini-key', {
      method: 'GET',
      headers: {
        Accept: 'application/json',
      },
    });
    expect(result.models).toEqual([
      {
        id: 'gemini-2.5-pro',
        name: 'Gemini 2.5 Pro',
        limit: {
          context: 1048576,
          output: 65536,
        },
      },
      { id: 'gemini-2.5-flash', name: 'gemini-2.5-flash' },
    ]);
  });

  it('fetches Anthropic models with Anthropic headers', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        data: [
          { id: 'claude-sonnet-4-5', display_name: 'Claude Sonnet 4.5' },
        ],
      }),
    }));
    const { fetchProviderModels } = await loadProvidersModule();

    const result = await fetchProviderModels({
      type: 'anthropic',
      baseURL: 'https://api.anthropic.com/v1',
      apiKey: 'anthropic-key',
    }, fetchMock);

    expect(fetchMock).toHaveBeenCalledWith('https://api.anthropic.com/v1/models', {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'anthropic-version': '2023-06-01',
        'x-api-key': 'anthropic-key',
      },
    });
    expect(result.models).toEqual([
      { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5' },
    ]);
  });
});

describe('provider routes', () => {
  const createRouteDependencies = (overrides = {}) => ({
    crypto: {},
    clientReloadDelayMs: 1,
    getOpenCodeResolutionSnapshot: vi.fn(),
    formatSettingsResponse: vi.fn((settings) => settings),
    readSettingsFromDisk: vi.fn(),
    readSettingsFromDiskMigrated: vi.fn(),
    persistSettings: vi.fn(),
    sanitizeProjects: vi.fn((projects) => projects),
    validateDirectoryPath: vi.fn(),
    resolveProjectDirectory: vi.fn(async () => ({ directory: null, error: null })),
    getProviderSources: vi.fn(),
    getProviderConfig: vi.fn(),
    upsertProviderConfig: vi.fn(),
    removeProviderConfig: vi.fn(),
    fetchProviderModels: vi.fn(async (input) => ({
      type: input.type,
      baseURL: input.baseURL,
      models: [{ id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' }],
    })),
    refreshOpenCodeAfterConfigChange: vi.fn(),
    ...overrides,
  });

  it('exposes custom provider model discovery through the settings API', async () => {
    const app = express();
    app.use(express.json());
    const fetchProviderModels = vi.fn(async (input) => ({
      type: input.type,
      baseURL: input.baseURL,
      models: [{ id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' }],
    }));

    registerOpenCodeRoutes(app, createRouteDependencies({ fetchProviderModels }));

    const response = await request(app)
      .post('/api/provider/custom/models')
      .send({
        type: 'google',
        baseURL: 'https://generativelanguage.googleapis.com/v1beta',
        apiKey: 'gemini-key',
      })
      .expect(200);

    expect(fetchProviderModels).toHaveBeenCalledWith({
      type: 'google',
      baseURL: 'https://generativelanguage.googleapis.com/v1beta',
      apiKey: 'gemini-key',
    });
    expect(response.body).toEqual({
      success: true,
      type: 'google',
      baseURL: 'https://generativelanguage.googleapis.com/v1beta',
      models: [{ id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' }],
    });
  });

  it('exposes known provider options before the OpenCode proxy', async () => {
    const app = express();
    app.use(express.json());

    registerOpenCodeRoutes(app, createRouteDependencies());

    const response = await request(app)
      .get('/api/provider')
      .expect(200);

    expect(response.body.providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'anthropic', name: 'Anthropic' }),
        expect.objectContaining({ id: 'openai', name: 'OpenAI' }),
        expect.objectContaining({ id: 'google', name: 'Google' }),
      ]),
    );
    expect(response.body.all).toEqual(response.body.providers);
  });

  it('exposes provider auth methods before parameterized provider routes', async () => {
    const app = express();
    app.use(express.json());

    registerOpenCodeRoutes(app, createRouteDependencies());

    const response = await request(app)
      .get('/api/provider/auth')
      .expect(200);

    expect(response.body.openai).toEqual([expect.objectContaining({ type: 'api' })]);
    expect(response.body['github-copilot']).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'oauth' }),
      expect.objectContaining({ type: 'api' }),
    ]));
  });

  it('exposes stored provider configuration for editing', async () => {
    const app = express();
    app.use(express.json());
    const getProviderConfig = vi.fn(() => ({
      providerId: 'editable',
      type: 'anthropic',
      name: 'Editable Provider',
      baseURL: 'https://api.example.com/v1',
      scope: 'user',
      path: '/tmp/config.json',
      models: [{ id: 'claude-test', name: 'Claude Test', context: 200000, output: 8192 }],
    }));

    registerOpenCodeRoutes(app, createRouteDependencies({ getProviderConfig }));

    const response = await request(app)
      .get('/api/provider/editable/config')
      .expect(200);

    expect(getProviderConfig).toHaveBeenCalledWith('editable', null);
    expect(response.body).toEqual({
      providerId: 'editable',
      config: {
        providerId: 'editable',
        type: 'anthropic',
        name: 'Editable Provider',
        baseURL: 'https://api.example.com/v1',
        scope: 'user',
        path: '/tmp/config.json',
        models: [{ id: 'claude-test', name: 'Claude Test', context: 200000, output: 8192 }],
      },
    });
  });

  it('saves custom provider edits back to the custom config scope', async () => {
    const app = express();
    app.use(express.json());
    const upsertProviderConfig = vi.fn(() => ({
      providerId: 'env-backed',
      scope: 'custom',
      path: '/tmp/custom-opencode.json',
    }));

    registerOpenCodeRoutes(app, createRouteDependencies({ upsertProviderConfig }));

    const response = await request(app)
      .post('/api/provider/custom')
      .send({
        id: 'env-backed',
        name: 'Env Backed',
        baseURL: 'https://api.example.com/v1',
        scope: 'custom',
        models: [{ id: 'model-1' }],
      })
      .expect(200);

    expect(upsertProviderConfig).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'env-backed', scope: 'custom' }),
      null,
      'custom',
    );
    expect(response.body).toMatchObject({
      success: true,
      providerId: 'env-backed',
      scope: 'custom',
      path: '/tmp/custom-opencode.json',
    });
  });

  it('saves custom provider API key in the same request', async () => {
    const routeTempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-provider-auth-route-test-'));
    const previousHome = process.env.HOME;
    const previousUserProfile = process.env.USERPROFILE;
    const previousOpenCodeAuthDir = process.env.OPENCODE_AUTH_DIR;
    process.env.HOME = routeTempHome;
    process.env.USERPROFILE = routeTempHome;
    process.env.OPENCODE_AUTH_DIR = path.join(routeTempHome, '.local', 'share', 'opencode');

    const app = express();
    app.use(express.json());
    const upsertProviderConfig = vi.fn(() => ({
      providerId: 'api-key-provider',
      scope: 'user',
      path: '/tmp/config.json',
    }));

    try {
      registerOpenCodeRoutes(app, createRouteDependencies({ upsertProviderConfig }));

      await request(app)
        .post('/api/provider/custom')
        .send({
          id: 'api-key-provider',
          name: 'API Key Provider',
          baseURL: 'https://api.example.com/v1',
          apiKey: 'sk-test',
          models: [{ id: 'model-1' }],
        })
        .expect(200);

      const authPath = path.join(routeTempHome, '.local', 'share', 'opencode', 'auth.json');
      const auth = JSON.parse(fs.readFileSync(authPath, 'utf8'));
      expect(auth['api-key-provider']).toEqual({ type: 'api', key: 'sk-test' });
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      if (previousUserProfile === undefined) {
        delete process.env.USERPROFILE;
      } else {
        process.env.USERPROFILE = previousUserProfile;
      }
      if (previousOpenCodeAuthDir === undefined) {
        delete process.env.OPENCODE_AUTH_DIR;
      } else {
        process.env.OPENCODE_AUTH_DIR = previousOpenCodeAuthDir;
      }
      fs.rmSync(routeTempHome, { recursive: true, force: true });
    }
  });
});
