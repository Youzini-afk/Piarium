import { describe, expect, test } from 'bun:test';
import { shouldLoadAvailableProviders } from './providerAvailability';
import {
  buildProviderSourcesFromConfig,
  canEditProviderFromDetails,
  isEditableCustomProviderConfig,
  readProviderConfigPayload,
} from './providerDetailConfig';

describe('ProvidersPage available provider loading', () => {
  test('loads available providers only in add-provider mode', () => {
    expect(shouldLoadAvailableProviders(false)).toBe(false);
    expect(shouldLoadAvailableProviders(true)).toBe(true);
  });
});

describe('provider detail config helpers', () => {
  test('reads custom provider config from web and VS Code bridge payloads', () => {
    const config = {
      providerId: 'custom',
      baseURL: 'https://api.example.com/v1',
      models: [{ id: 'model-a' }],
    };

    expect(readProviderConfigPayload({ config })).toEqual(config);
    expect(readProviderConfigPayload({ data: { config } })).toEqual(config);
    expect(readProviderConfigPayload({ data: {} })).toBe(undefined);
  });

  test('treats readable custom provider config as editable details', () => {
    const config = {
      providerId: 'custom',
      baseURL: 'https://api.example.com/v1',
      scope: 'project',
      path: 'E:\\repo\\opencode.json',
      models: [{ id: 'model-a' }],
    };

    expect(isEditableCustomProviderConfig(config)).toBe(true);

    const sources = buildProviderSourcesFromConfig(config);
    expect(sources.project).toEqual({ exists: true, path: 'E:\\repo\\opencode.json' });
    expect(canEditProviderFromDetails(null, sources)).toBe(true);
  });

  test('keeps edit hidden when neither source nor config is editable', () => {
    expect(isEditableCustomProviderConfig({ baseURL: '', models: [{ id: 'model-a' }] })).toBe(false);
    expect(canEditProviderFromDetails(null, {
      auth: { exists: true },
      user: { exists: false },
      project: { exists: false },
      custom: { exists: false },
    })).toBe(false);
  });
});
