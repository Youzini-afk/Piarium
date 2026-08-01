import { describe, expect, test } from 'bun:test';

import {
  createCustomProviderFormStateFromConfig,
  hasEditableProviderConfigSource,
  mergeCustomProviderModelRows,
  normalizeCustomProviderModelRows,
  resolveCustomProviderApiKey,
} from './customProviderForm';

describe('custom provider form helpers', () => {
  test('uses the controlled API key state when it has a value', () => {
    expect(resolveCustomProviderApiKey(' sk-state ', { value: 'sk-dom' })).toBe('sk-state');
  });

  test('falls back to the input value when browser autofill has not updated state', () => {
    expect(resolveCustomProviderApiKey('', { value: ' sk-autofill ' })).toBe('sk-autofill');
  });

  test('returns an empty string when neither source has an API key', () => {
    expect(resolveCustomProviderApiKey(' ', { value: ' ' })).toBe('');
  });

  test('normalizes model names and token limits for custom provider saving', () => {
    expect(normalizeCustomProviderModelRows([
      { id: ' gpt-test ', name: ' GPT Test ', context: '200000', output: '8192' },
      {
        id: 'context-only',
        name: 'Context Only',
        context: '128000',
        output: '',
        attachment: true,
        tool_call: true,
        reasoning: true,
        reasoningEffort: 'xhigh',
        options: {
          providerSpecific: 'keep-me',
        },
      },
      { id: 'empty-limits', name: '', context: '', output: ' ' },
      { id: 'bad-limits', name: 'Bad Limits', context: '0', output: '-10' },
      { id: 'gpt-test', name: 'Duplicate', context: '128000', output: '4096' },
    ])).toEqual([
      {
        id: 'gpt-test',
        name: 'GPT Test',
        limit: {
          context: 200000,
          output: 8192,
        },
      },
      {
        id: 'context-only',
        name: 'Context Only',
        attachment: true,
        tool_call: true,
        reasoning: true,
        modalities: {
          input: ['text', 'image'],
          output: ['text'],
        },
        options: {
          providerSpecific: 'keep-me',
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
        limit: {
          context: 128000,
          output: 8192,
        },
      },
      { id: 'empty-limits' },
      { id: 'bad-limits', name: 'Bad Limits' },
    ]);
  });

  test('normalizes provider limit aliases to standard custom provider payload limits', () => {
    expect(normalizeCustomProviderModelRows([
      {
        id: 'window-model',
        name: 'Window Model',
        context_window: '256,000',
        max_output_tokens: '16,384',
      },
      {
        id: 'limit-model',
        limit: {
          context: 128000,
          output: 8192,
        },
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
    ])).toEqual([
      {
        id: 'window-model',
        name: 'Window Model',
        limit: {
          context: 256000,
          output: 16384,
        },
      },
      {
        id: 'limit-model',
        limit: {
          context: 128000,
          output: 8192,
        },
      },
      {
        id: 'fallback-model',
        limit: {
          context: 64000,
          output: 4096,
        },
      },
    ]);
  });

  test('creates editable form state from a saved custom provider config', () => {
    expect(createCustomProviderFormStateFromConfig({
      providerId: 'editable',
      type: 'anthropic',
      name: 'Editable Provider',
      baseURL: 'https://api.example.com/v1',
      scope: 'project',
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
            high: { reasoningEffort: 'high', textVerbosity: 'low' },
            max: { reasoningEffort: 'max' },
          },
          options: { providerSpecific: 'keep-me' },
        },
        { id: 'nameless-model' },
      ],
    })).toEqual({
      type: 'anthropic',
      id: 'editable',
      name: 'Editable Provider',
      baseURL: 'https://api.example.com/v1',
      apiKey: '',
      scope: 'project',
      models: [
        {
          id: 'claude-test',
          name: 'Claude Test',
          context: '200000',
          output: '8192',
          attachment: true,
          tool_call: true,
          reasoning: true,
          reasoningEffort: 'max',
          variants: {
            high: { reasoningEffort: 'high', textVerbosity: 'low' },
            max: { reasoningEffort: 'max' },
          },
          options: { providerSpecific: 'keep-me' },
        },
        {
          id: 'nameless-model',
          name: '',
          context: '',
          output: '',
          attachment: false,
          tool_call: false,
          reasoning: false,
          reasoningEffort: '',
        },
      ],
    });
  });

  test('moves reasoning effort out of preserved custom model options for editing', () => {
    const state = createCustomProviderFormStateFromConfig({
      providerId: 'editable',
      type: 'openai-compatible',
      name: 'Editable Provider',
      baseURL: 'https://api.example.com/v1',
      models: [
        {
          id: 'reasoning-model',
          reasoning: true,
          options: {
            providerSpecific: 'keep-me',
            reasoningEffort: 'high',
          },
          variants: {
            xhigh: { reasoningEffort: 'xhigh' },
          },
        },
      ],
    });

    expect(state.models[0]).toEqual({
      id: 'reasoning-model',
      name: '',
      context: '',
      output: '',
      attachment: false,
      tool_call: false,
      reasoning: true,
      reasoningEffort: 'high',
      options: {
        providerSpecific: 'keep-me',
      },
      variants: {
        xhigh: { reasoningEffort: 'xhigh' },
      },
    });

    expect(normalizeCustomProviderModelRows([
      {
        ...state.models[0],
        reasoningEffort: '',
      },
    ])).toEqual([
      {
        id: 'reasoning-model',
        reasoning: true,
        options: {
          providerSpecific: 'keep-me',
        },
        variants: {
          xhigh: { reasoningEffort: 'xhigh' },
          none: { reasoningEffort: 'none' },
          minimal: { reasoningEffort: 'minimal' },
          low: { reasoningEffort: 'low' },
          medium: { reasoningEffort: 'medium' },
          high: { reasoningEffort: 'high' },
          max: { reasoningEffort: 'max' },
        },
      },
    ]);
  });

  test('creates editable form state from standard limit metadata and aliases', () => {
    expect(createCustomProviderFormStateFromConfig({
      providerId: 'editable',
      baseURL: 'https://api.example.com/v1',
      models: [
        {
          id: 'limit-model',
          limit: {
            context: 256000,
            output: 16384,
          },
        },
        {
          id: 'alias-model',
          context_window: 128000,
          max_output_tokens: 8192,
        },
      ],
    }).models).toEqual([
      {
        id: 'limit-model',
        name: '',
        context: '256000',
        output: '16384',
        attachment: false,
        tool_call: false,
        reasoning: false,
        reasoningEffort: '',
      },
      {
        id: 'alias-model',
        name: '',
        context: '128000',
        output: '8192',
        attachment: false,
        tool_call: false,
        reasoning: false,
        reasoningEffort: '',
      },
    ]);
  });

  test('preserves custom config scope when editing an env-backed provider', () => {
    expect(createCustomProviderFormStateFromConfig({
      providerId: 'env-backed',
      type: 'openai-compatible',
      name: 'Env Backed',
      baseURL: 'https://api.example.com/v1',
      scope: 'custom',
      models: [{ id: 'model-1' }],
    }).scope).toBe('custom');
  });

  test('detects when a selected provider has editable provider configuration', () => {
    expect(hasEditableProviderConfigSource(undefined)).toBe(false);
    expect(hasEditableProviderConfigSource({
      auth: { exists: true },
      user: { exists: false },
      project: { exists: false },
    })).toBe(false);
    expect(hasEditableProviderConfigSource({
      auth: { exists: false },
      user: { exists: true },
      project: { exists: false },
    })).toBe(true);
    expect(hasEditableProviderConfigSource({
      auth: { exists: false },
      user: { exists: false },
      project: { exists: false },
      custom: { exists: true },
    })).toBe(true);
  });

  test('adds fetched custom provider models without deleting existing models', () => {
    expect(mergeCustomProviderModelRows([
      { id: 'old-model', name: 'Old Model', context: '128000', output: '', attachment: false, tool_call: true, reasoning: false, reasoningEffort: '' },
    ], [
      { id: 'new-model', name: 'New Model', context: '200000', output: '8192', attachment: true },
    ])).toEqual([
      { id: 'old-model', name: 'Old Model', context: '128000', output: '', attachment: false, tool_call: true, reasoning: false, reasoningEffort: '' },
      { id: 'new-model', name: 'New Model', context: '200000', output: '8192', attachment: true, tool_call: false, reasoning: false, reasoningEffort: '' },
    ]);
  });

  test('updates selected fetched models by id and keeps unselected existing models', () => {
    expect(mergeCustomProviderModelRows([
      { id: 'keep-model', name: 'Keep', context: '', output: '', attachment: false, tool_call: false, reasoning: false, reasoningEffort: '' },
      { id: 'same-model', name: 'Old Same', context: '1000', output: '', attachment: false, tool_call: false, reasoning: false, reasoningEffort: '', options: { local: true } },
    ], [
      { id: 'same-model', name: 'New Same', context: '2000', output: '', reasoning: true, reasoningEffort: 'high' },
    ])).toEqual([
      { id: 'keep-model', name: 'Keep', context: '', output: '', attachment: false, tool_call: false, reasoning: false, reasoningEffort: '' },
      {
        id: 'same-model',
        name: 'New Same',
        context: '2000',
        output: '',
        attachment: false,
        tool_call: false,
        reasoning: true,
        reasoningEffort: 'high',
        options: { local: true },
      },
    ]);
  });

  test('preserves existing model capabilities when fetched metadata omits them', () => {
    expect(mergeCustomProviderModelRows([
      {
        id: 'same-model',
        name: 'Old Same',
        context: '1000',
        output: '2000',
        attachment: true,
        tool_call: true,
        reasoning: true,
        reasoningEffort: 'high',
      },
    ], [
      { id: 'same-model', name: 'New Same' },
    ])).toEqual([
      {
        id: 'same-model',
        name: 'New Same',
        context: '1000',
        output: '2000',
        attachment: true,
        tool_call: true,
        reasoning: true,
        reasoningEffort: 'high',
      },
    ]);
  });
});
