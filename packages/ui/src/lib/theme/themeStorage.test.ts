import { describe, expect, test } from 'bun:test';

import { parseStoredThemeState } from './themeStorage';

describe('theme storage', () => {
  test('accepts the complete current theme state', () => {
    expect(parseStoredThemeState(JSON.stringify({
      mode: 'system',
      lightThemeId: 'piarium-light',
      darkThemeId: 'piarium-dark',
      splash: {
        light: { background: '#fff', foreground: '#111' },
        dark: { background: '#111', foreground: '#fff' },
      },
    }))).toEqual({
      mode: 'system',
      lightThemeId: 'piarium-light',
      darkThemeId: 'piarium-dark',
      splash: {
        light: { background: '#fff', foreground: '#111' },
        dark: { background: '#111', foreground: '#fff' },
      },
    });
  });

  test('rejects partial, legacy, and malformed values', () => {
    expect(parseStoredThemeState(null)).toBeNull();
    expect(parseStoredThemeState('{')).toBeNull();
    expect(parseStoredThemeState(JSON.stringify({ themeMode: 'dark' }))).toBeNull();
    expect(parseStoredThemeState(JSON.stringify({
      mode: 'dark',
      lightThemeId: 'piarium-light',
      darkThemeId: 'piarium-dark',
      splash: { light: {}, dark: {} },
    }))).toBeNull();
  });
});

