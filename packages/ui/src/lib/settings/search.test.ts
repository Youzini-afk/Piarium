import { describe, expect, mock, test } from 'bun:test';
import type { SettingsSearchAvailabilityContext } from './search';

mock.module('@/hooks/useProviderLogo', () => ({
  preloadProviderLogos: () => undefined,
  useProviderLogo: () => ({ hasLogo: false, onError: () => undefined, src: null }),
}));

const { buildSettingsSearchResults } = await import('./search');
const { getSettingsPageMeta } = await import('./metadata');
const { ensureBuiltinSettingsContributions, piariumSurfaceRuntime } = await import('./surface-registry');
const {
  PIARIUM_BUILTIN_MCP_EXTENSION,
  PIARIUM_BUILTIN_PLUGIN_SETTINGS_EXTENSION,
} = await import('@piarium/extension-builtins');
const { activateBuiltinPiIntegration } = await import('@/lib/extensions/builtin-pi-integrations');

const runtimeContext = (mcpInstalled: boolean): SettingsSearchAvailabilityContext => ({
  isDesktop: false,
  isDesktopLocalOrigin: false,
  isLinux: false,
  isMac: false,
  isMobile: false,
  isVSCode: false,
  isWeb: true,
  isWindows: false,
  mcpInstalled,
});

describe('settings search availability', () => {
  test('does not expose MCP search targets until pi-mcp-adapter is installed', async () => {
    await ensureBuiltinSettingsContributions();
    if (!getSettingsPageMeta('mcp')) await piariumSurfaceRuntime.activate({
      owner: {
        desiredRevision: 1,
        entrypointId: 'main',
        extensionId: PIARIUM_BUILTIN_MCP_EXTENSION.manifest.id,
        extensionVersion: PIARIUM_BUILTIN_MCP_EXTENSION.manifest.version,
        generation: 1,
        hostId: '72694a4f-093a-4f79-8763-3ca9f06b7078',
        realmId: 'mcp-search-test',
      },
    }, activateBuiltinPiIntegration(PIARIUM_BUILTIN_MCP_EXTENSION));
    const build = (mcpInstalled: boolean) => buildSettingsSearchResults({
      getPageTitle: (slug) => slug,
      query: 'mcp',
      runtimeCtx: runtimeContext(mcpInstalled),
      t: (key) => key,
    });

    expect(build(false).some((result) => result.page === 'mcp')).toBe(false);
    expect(build(true).some((result) => result.page === 'mcp')).toBe(true);
  });

  test('indexes the permission-system adapter under Plugin Settings', async () => {
    await ensureBuiltinSettingsContributions();
    if (!getSettingsPageMeta('plugin-settings')) await piariumSurfaceRuntime.activate({
      owner: {
        desiredRevision: 1,
        entrypointId: 'main',
        extensionId: PIARIUM_BUILTIN_PLUGIN_SETTINGS_EXTENSION.manifest.id,
        extensionVersion: PIARIUM_BUILTIN_PLUGIN_SETTINGS_EXTENSION.manifest.version,
        generation: 1,
        hostId: '72694a4f-093a-4f79-8763-3ca9f06b7078',
        realmId: 'plugin-settings-search-test',
      },
    }, activateBuiltinPiIntegration(PIARIUM_BUILTIN_PLUGIN_SETTINGS_EXTENSION));
    const results = buildSettingsSearchResults({
      getPageTitle: (slug) => slug,
      query: 'permission system',
      runtimeCtx: runtimeContext(false),
      t: (key) => key,
    });
    expect(results.some((result) => (
      result.id === 'plugin-settings.configuration'
      && result.page === 'plugin-settings'
    ))).toBe(true);

    const rtkResults = buildSettingsSearchResults({
      getPageTitle: (slug) => slug,
      query: 'rtk optimizer',
      runtimeCtx: runtimeContext(false),
      t: (key) => key,
    });
    expect(rtkResults.some((result) => (
      result.id === 'plugin-settings.configuration'
      && result.page === 'plugin-settings'
    ))).toBe(true);
  });
});
