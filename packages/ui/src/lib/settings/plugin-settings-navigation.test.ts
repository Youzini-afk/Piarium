import { describe, expect, test } from 'bun:test';
import {
  consumePluginSettingsTarget,
  requestPluginSettingsIntegration,
  requestPluginSettingsTarget,
} from './plugin-settings-navigation';

describe('plugin settings navigation', () => {
  test('hands a requested integration to the next plugin settings page once', () => {
    requestPluginSettingsIntegration('workspace-history');
    expect(consumePluginSettingsTarget()).toEqual({
      integrationId: 'workspace-history',
      pluginId: 'pi-workspace-history',
    });

    requestPluginSettingsTarget('npm:pi-openai-codex-compat@0.0.7-alpha.0');
    expect(consumePluginSettingsTarget()).toEqual({
      integrationId: 'openai-codex-compat',
      pluginId: 'npm:pi-openai-codex-compat@0.0.7-alpha.0',
    });

    requestPluginSettingsTarget('pi-observational-memory');
    expect(consumePluginSettingsTarget()).toEqual({
      integrationId: 'observational-memory',
      pluginId: 'pi-observational-memory',
    });
    expect(consumePluginSettingsTarget()).toBeNull();
  });

  test('maps adapted packages and preserves unadapted provider ownership', () => {
    requestPluginSettingsTarget('@cortexkit/pi-magic-context', 'agents');
    expect(consumePluginSettingsTarget()).toEqual({
      integrationId: 'magic-context',
      pluginId: '@cortexkit/pi-magic-context',
      section: 'agents',
    });

    requestPluginSettingsTarget('example-agents', 'profiles', 'project:../example-agents');
    expect(consumePluginSettingsTarget()).toEqual({
      integrationId: null,
      pluginId: 'example-agents',
      packageIdentity: 'project:../example-agents',
      section: 'profiles',
    });
  });

  test('maps pi-lens to its dedicated adapter', () => {
    requestPluginSettingsTarget('npm:pi-lens@4.0.1');
    expect(consumePluginSettingsTarget()).toEqual({
      integrationId: 'pi-lens',
      pluginId: 'npm:pi-lens@4.0.1',
    });
  });

  test('maps the scoped AFT package to its dedicated adapter', () => {
    requestPluginSettingsTarget('npm:@cortexkit/aft-pi@0.51.2');
    expect(consumePluginSettingsTarget()).toEqual({
      integrationId: 'aft',
      pluginId: 'npm:@cortexkit/aft-pi@0.51.2',
    });
  });

  test('maps the scoped permission-system package to its dedicated adapter', () => {
    requestPluginSettingsTarget('npm:@gotgenes/pi-permission-system@22.0.0');
    expect(consumePluginSettingsTarget()).toEqual({
      integrationId: 'permission-system',
      pluginId: 'npm:@gotgenes/pi-permission-system@22.0.0',
    });
  });

  test('maps pi-hermes-memory to its dedicated adapter', () => {
    requestPluginSettingsTarget('npm:pi-hermes-memory@0.9.6');
    expect(consumePluginSettingsTarget()).toEqual({
      integrationId: 'hermes-memory',
      pluginId: 'npm:pi-hermes-memory@0.9.6',
    });
  });
});
