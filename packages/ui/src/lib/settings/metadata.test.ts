import { describe, expect, test } from 'bun:test';
import { SETTINGS_PAGE_METADATA, resolveSettingsSlug } from './metadata';

describe('settings metadata', () => {
  test('does not expose the removed Smart Search settings page', () => {
    const smartSearch = SETTINGS_PAGE_METADATA.find((page) => page.title === 'Smart Search');

    expect(resolveSettingsSlug('smart-search')).toBe('home');
    expect(smartSearch).toBe(undefined);
  });
});
