import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';

describe('Pi Runtime settings page', () => {
  test('uses Settings primitives and RuntimeAPIs instead of the plugins page', () => {
    const source = readFileSync(new URL('./PiRuntimeSettingsPage.tsx', import.meta.url), 'utf8');
    expect(source).toContain('SettingsPageLayout');
    expect(source).toContain('SettingsSection');
    expect(source).toContain('useRuntimeAPIs');
    expect(source).toContain('settings.page.runtime.title');
    expect(source).not.toContain('PluginsPage');
    expect(source).not.toContain('getPiRuntimeConnection');
  });
});
