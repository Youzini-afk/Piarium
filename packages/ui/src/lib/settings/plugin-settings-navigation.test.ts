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
    expect(consumePluginSettingsTarget()).toBeNull();
  });

  test('maps adapted packages and preserves unadapted provider ownership', () => {
    requestPluginSettingsTarget('@cortexkit/pi-magic-context', 'agents');
    expect(consumePluginSettingsTarget()).toEqual({
      integrationId: 'magic-context',
      pluginId: '@cortexkit/pi-magic-context',
      section: 'agents',
    });

    requestPluginSettingsTarget('example-agents', 'profiles');
    expect(consumePluginSettingsTarget()).toEqual({
      integrationId: null,
      pluginId: 'example-agents',
      section: 'profiles',
    });
  });
});
