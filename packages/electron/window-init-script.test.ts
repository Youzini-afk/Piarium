import { describe, expect, test } from 'vitest';
import { updateWindowInitScript } from './window-init-script.js';

describe('updateWindowInitScript', () => {
  test('replaces a stale script before the window reloads', () => {
    const browserWindow = {
      __varinInitScript: 'stale-script',
      isDestroyed: () => false,
    };

    expect(updateWindowInitScript(browserWindow, 'current-script')).toBe(true);
    expect(browserWindow.__varinInitScript).toBe('current-script');
  });

  test('does not update a destroyed window', () => {
    const browserWindow = {
      __varinInitScript: 'stale-script',
      isDestroyed: () => true,
    };

    expect(updateWindowInitScript(browserWindow, 'current-script')).toBe(false);
    expect(browserWindow.__varinInitScript).toBe('stale-script');
  });
});
