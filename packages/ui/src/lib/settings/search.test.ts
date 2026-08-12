import { describe, expect, test } from 'bun:test';
import { buildSettingsSearchResults, type SettingsSearchAvailabilityContext } from './search';

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
  test('does not expose MCP search targets until pi-mcp-adapter is installed', () => {
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
