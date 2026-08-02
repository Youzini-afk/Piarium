import { describe, expect, test } from 'bun:test';
import {
  consumePluginSettingsSelection,
  requestPluginSettingsSelection,
} from './plugin-settings-navigation';

describe('plugin settings navigation', () => {
  test('hands a requested integration to the next plugin settings page once', () => {
    requestPluginSettingsSelection('workspace-history');
    expect(consumePluginSettingsSelection()).toBe('workspace-history');
    expect(consumePluginSettingsSelection()).toBeNull();
  });
});
