import { describe, expect, test } from 'bun:test';
import { SETTINGS_PAGE_METADATA, resolveSettingsSlug, type SettingsRuntimeContext } from './metadata';

const runtimeContext = (mcpInstalled: boolean): SettingsRuntimeContext => ({
  isDesktop: false,
  isMobile: false,
  isVSCode: false,
  isWeb: true,
  mcpInstalled,
});

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
    expect(slugs).toContain('fleet');
    expect(slugs).toContain('commands');
    expect(slugs).toContain('prompts');
    expect(slugs).toContain('skills');
    expect(slugs).toContain('mcp');
    expect(slugs).toContain('plugins');
    expect(slugs).toContain('plugin-settings');
    expect(SETTINGS_PAGE_METADATA.find((page) => page.slug === 'providers')?.group).toBe('pi');
    expect(SETTINGS_PAGE_METADATA.find((page) => page.slug === 'agents')?.group).toBe('pi');
    expect(SETTINGS_PAGE_METADATA.find((page) => page.slug === 'fleet')?.group).toBe('pi');
    expect(SETTINGS_PAGE_METADATA.find((page) => page.slug === 'commands')?.group).toBe('pi');
    expect(SETTINGS_PAGE_METADATA.find((page) => page.slug === 'prompts')?.group).toBe('pi');
    expect(SETTINGS_PAGE_METADATA.find((page) => page.slug === 'skills')?.group).toBe('pi');
    expect(SETTINGS_PAGE_METADATA.find((page) => page.slug === 'mcp')?.group).toBe('pi');
    expect(SETTINGS_PAGE_METADATA.find((page) => page.slug === 'plugins')?.group).toBe('pi');
    expect(SETTINGS_PAGE_METADATA.find((page) => page.slug === 'plugin-settings')?.group).toBe('pi');
    expect(SETTINGS_PAGE_METADATA.find((page) => page.slug === 'plugin-settings')?.kind).toBe('split');
  });

  test('exposes the split MCP page only for an installed adapter', () => {
    const mcp = SETTINGS_PAGE_METADATA.find((page) => page.slug === 'mcp');
    expect(mcp?.kind).toBe('split');
    expect(mcp?.isAvailable?.(runtimeContext(false))).toBe(false);
    expect(mcp?.isAvailable?.(runtimeContext(true))).toBe(true);
  });

  test('does not route removed OpenCode settings through compatibility aliases', () => {
    for (const slug of [
      'behavior',
      'skills.installed',
      'skills.catalog',
      'openagent',
      'agent-orchestration',
    ]) {
      expect(resolveSettingsSlug(slug)).toBe('home');
    }
    expect(resolveSettingsSlug('agents')).toBe('agents');
    expect(resolveSettingsSlug('commands')).toBe('commands');
  });
});
