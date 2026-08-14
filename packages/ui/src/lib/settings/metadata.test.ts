import { describe, expect, mock, test } from 'bun:test';
import type { SettingsRuntimeContext } from './page-types';

mock.module('@/hooks/useProviderLogo', () => ({
  preloadProviderLogos: () => undefined,
  useProviderLogo: () => ({ hasLogo: false, onError: () => undefined, src: null }),
}));

const { getSettingsPageMeta, getSettingsPageMetadata, resolveSettingsSlug } = await import('./metadata');
const {
  ensureBuiltinSettingsContributions,
  piariumSurfaceRuntime,
  setBuiltinSettingsContributionsEnabled,
} = await import('./surface-registry');

const runtimeContext = (mcpInstalled: boolean): SettingsRuntimeContext => ({
  isDesktop: false,
  isMobile: false,
  isVSCode: false,
  isWeb: true,
  mcpInstalled,
});

describe('settings metadata', () => {
  test('does not expose the removed Smart Search settings page', async () => {
    await ensureBuiltinSettingsContributions();
    const smartSearch = getSettingsPageMetadata().find((page) => page.title === 'Smart Search');

    expect(resolveSettingsSlug('smart-search')).toBe('home');
    expect(smartSearch).toBe(undefined);
  });

  test('exposes only Pi-native runtime pages', async () => {
    await ensureBuiltinSettingsContributions();
    const metadata = getSettingsPageMetadata();
    const slugs = metadata.map((page) => page.slug);

    expect(slugs).toContain('providers');
    expect(slugs).toContain('agents');
    expect(slugs).toContain('fleet');
    expect(slugs).toContain('commands');
    expect(slugs).toContain('prompts');
    expect(slugs).toContain('skills');
    expect(slugs).toContain('mcp');
    expect(slugs).toContain('plugins');
    expect(slugs).toContain('plugin-settings');
    expect(metadata.find((page) => page.slug === 'providers')?.group).toBe('pi');
    expect(metadata.find((page) => page.slug === 'agents')?.group).toBe('pi');
    expect(metadata.find((page) => page.slug === 'fleet')?.group).toBe('pi');
    expect(metadata.find((page) => page.slug === 'commands')?.group).toBe('pi');
    expect(metadata.find((page) => page.slug === 'prompts')?.group).toBe('pi');
    expect(metadata.find((page) => page.slug === 'skills')?.group).toBe('pi');
    expect(metadata.find((page) => page.slug === 'mcp')?.group).toBe('pi');
    expect(metadata.find((page) => page.slug === 'plugins')?.group).toBe('pi');
    expect(metadata.find((page) => page.slug === 'plugin-settings')?.group).toBe('pi');
    expect(metadata.find((page) => page.slug === 'plugin-settings')?.kind).toBe('split');
  });

  test('exposes the split MCP page only for an installed adapter', async () => {
    await ensureBuiltinSettingsContributions();
    const mcp = getSettingsPageMetadata().find((page) => page.slug === 'mcp');
    expect(mcp?.kind).toBe('split');
    expect(mcp?.isAvailable?.(runtimeContext(false))).toBe(false);
    expect(mcp?.isAvailable?.(runtimeContext(true))).toBe(true);
  });

  test('does not route removed OpenCode settings through compatibility aliases', async () => {
    await ensureBuiltinSettingsContributions();
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

  test('adds and withdraws an extension-owned settings page without a document refresh', async () => {
    await ensureBuiltinSettingsContributions();
    const handle = await piariumSurfaceRuntime.activate({
      owner: {
        extensionId: 'dev.example.settings-test',
        extensionVersion: '1.0.0',
        entrypointId: 'main',
        realmId: 'settings-test-realm',
        hostId: '72694a4f-093a-4f79-8763-3ca9f06b7078',
        desiredRevision: 1,
        generation: 1,
      },
    }, (context) => {
      context.contribute({
        id: 'dev.example.settings-test.page',
        kind: 'settings-page',
        contractVersion: 1,
        supports: [piariumSurfaceRuntime.surface],
        placement: { slot: 'settings.nav.general', order: 9 },
        data: {
          slug: 'extension-test',
          title: 'Extension Test',
          titleKey: 'settings.page.general.title',
          group: 'general',
          kind: 'single',
          icon: 'settings-3',
          order: 9,
          keywords: ['extension-test'],
        },
      }, { renderContent: () => null });
    });

    expect(getSettingsPageMeta('extension-test')?.title).toBe('Extension Test');
    expect(resolveSettingsSlug('extension-test')).toBe('extension-test');
    await handle.deactivate(2, 2);
    expect(getSettingsPageMeta('extension-test')).toBe(null);
    expect(resolveSettingsSlug('extension-test')).toBe('home');
  });

  test('withdraws and restores the built-in Settings contribution generation in place', async () => {
    await ensureBuiltinSettingsContributions();
    expect(getSettingsPageMeta('general')).not.toBe(null);

    await setBuiltinSettingsContributionsEnabled(false);
    expect(getSettingsPageMetadata()).toEqual([]);

    await setBuiltinSettingsContributionsEnabled(true);
    expect(getSettingsPageMeta('general')).not.toBe(null);
  });

  test('applies layout visibility through the same live Settings registry', async () => {
    await ensureBuiltinSettingsContributions();
    piariumSurfaceRuntime.setLayoutReferences([
      { contributionId: 'piarium.builtin.settings.page.general', visible: false },
      { contributionId: 'dev.example.temporarily-missing', order: 5 },
    ]);
    expect(getSettingsPageMeta('general')).toBe(null);
    expect(piariumSurfaceRuntime.getSnapshot().layoutReferences[1]?.contributionId)
      .toBe('dev.example.temporarily-missing');

    piariumSurfaceRuntime.setLayoutReferences([]);
    expect(getSettingsPageMeta('general')).not.toBe(null);
  });
});
