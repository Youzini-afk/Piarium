import { describe, expect, mock, test } from 'bun:test';
import type { SettingsSearchAvailabilityContext } from './search';

mock.module('@/hooks/useProviderLogo', () => ({
  preloadProviderLogos: () => undefined,
  useProviderLogo: () => ({ hasLogo: false, onError: () => undefined, src: null }),
}));

const { buildSettingsSearchResults } = await import('./search');
const { ensureBuiltinSettingsContributions } = await import('./surface-registry');

const runtimeContext = (mcpInstalled: boolean): SettingsSearchAvailabilityContext => ({
  isDesktop: false,
  isDesktopLocalOrigin: false,
  isLinux: false,
  isMac: false,
  isMobile: false,
  isVSCode: false,
  isWeb: true,
  isWindows: false,
  isWindowsArm64: false,
  mcpInstalled,
});

describe('settings search availability', () => {
  test('does not expose MCP search targets until pi-mcp-adapter is installed', async () => {
    await ensureBuiltinSettingsContributions();
    const build = (mcpInstalled: boolean) => buildSettingsSearchResults({
      getPageTitle: (slug) => slug,
      query: 'mcp',
      runtimeCtx: runtimeContext(mcpInstalled),
      t: (key) => key,
    });

    expect(build(false).some((result) => result.page === 'mcp')).toBe(false);
    expect(build(true).some((result) => result.page === 'mcp')).toBe(true);
  });
});
