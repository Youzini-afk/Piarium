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
});
