import { describe, expect, test } from 'bun:test';
import { SETTINGS_PAGE_METADATA, resolveSettingsSlug } from './metadata';

describe('settings metadata', () => {
  test('does not expose the removed Smart Search settings page', () => {
    const smartSearch = SETTINGS_PAGE_METADATA.find((page) => page.title === 'Smart Search');

    expect(resolveSettingsSlug('smart-search')).toBe('home');
    expect(smartSearch).toBe(undefined);
  });

  test('exposes only Pi-native runtime pages', () => {
    const slugs = SETTINGS_PAGE_METADATA.map((page) => page.slug);

    expect(slugs).toContain('providers');
    expect(slugs).toContain('agents');
    expect(slugs).toContain('mcp');
    expect(slugs).toContain('plugins');
    expect(slugs).toContain('plugin-settings');
    expect(SETTINGS_PAGE_METADATA.find((page) => page.slug === 'providers')?.group).toBe('pi');
    expect(SETTINGS_PAGE_METADATA.find((page) => page.slug === 'agents')?.group).toBe('pi');
    expect(SETTINGS_PAGE_METADATA.find((page) => page.slug === 'mcp')?.group).toBe('pi');
    expect(SETTINGS_PAGE_METADATA.find((page) => page.slug === 'plugins')?.group).toBe('pi');
    expect(SETTINGS_PAGE_METADATA.find((page) => page.slug === 'plugin-settings')?.group).toBe('pi');
  });

  test('does not route removed OpenCode settings through compatibility aliases', () => {
    for (const slug of [
      'behavior',
      'commands',
      'skills.installed',
      'skills.catalog',
      'openagent',
      'agent-orchestration',
    ]) {
      expect(resolveSettingsSlug(slug)).toBe('home');
    }
    expect(resolveSettingsSlug('agents')).toBe('agents');
  });
});
