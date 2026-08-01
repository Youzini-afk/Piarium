import { describe, expect, test } from 'bun:test';
import { updateWindowInitScript } from './window-init-script.mjs';

describe('updateWindowInitScript', () => {
  test('replaces a stale script before the window reloads', () => {
    const browserWindow = {
      __ocInitScript: 'stale-script',
      isDestroyed: () => false,
    };

    expect(updateWindowInitScript(browserWindow, 'current-script')).toBe(true);
    expect(browserWindow.__ocInitScript).toBe('current-script');
  });

  test('does not update a destroyed window', () => {
    const browserWindow = {
      __ocInitScript: 'stale-script',
      isDestroyed: () => true,
    };

    expect(updateWindowInitScript(browserWindow, 'current-script')).toBe(false);
    expect(browserWindow.__ocInitScript).toBe('stale-script');
  });
});
