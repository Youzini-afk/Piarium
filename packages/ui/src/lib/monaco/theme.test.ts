import { describe, expect, test } from 'vitest';

import { getDefaultTheme } from '@/lib/theme/themes';
import { createPiariumMonacoTheme, monacoThemeName } from './theme';

describe('Piarium Monaco theme projection', () => {
  test.each([false, true])('projects semantic tokens for the %s dark preference', (prefersDark) => {
    const theme = getDefaultTheme(prefersDark);
    const projected = createPiariumMonacoTheme(theme);

    expect(projected.base).toBe(prefersDark ? 'vs-dark' : 'vs');
    expect(projected.colors['editor.background']).toBe(theme.colors.surface.background);
    expect(projected.colors['editor.foreground']).toBe(theme.colors.syntax.base.foreground);
    expect(projected.colors['editor.selectionBackground']).toBe(theme.colors.interactive.selection);
    expect(projected.colors['editorError.foreground']).toBe(theme.colors.status.error);
    expect(projected.colors['diffEditor.insertedTextBackground']).toBe(
      theme.colors.syntax.highlights?.diffAddedBackground,
    );
    expect(projected.rules.find((rule) => rule.token === 'keyword')?.foreground).toBe(
      theme.colors.syntax.base.keyword.replace(/^#/, ''),
    );
  });

  test('uses a stable, sanitized name without mutating the source theme', () => {
    const theme = getDefaultTheme(true);
    const original = structuredClone(theme);
    expect(monacoThemeName({
      ...theme,
      metadata: { ...theme.metadata, id: 'custom theme/one' },
    })).toBe('piarium-custom-theme-one');
    createPiariumMonacoTheme(theme);
    expect(theme).toEqual(original);
  });

  test('uses Monaco high-contrast primitives only when the Piarium theme declares that contract', () => {
    const theme = getDefaultTheme(true);
    expect(createPiariumMonacoTheme({
      ...theme,
      metadata: { ...theme.metadata, tags: [...theme.metadata.tags, 'high-contrast'] },
    }).base).toBe('hc-black');
  });
});
