import type { Theme } from '@/types/theme';
import { presetThemes } from './presets';
import { withPrColors } from './prColors';
import flexokiLightRaw from './flexoki-light.json';
import flexokiDarkRaw from './flexoki-dark.json';
import piariumLightRaw from './piarium-light.json';
import piariumDarkRaw from './piarium-dark.json';

const flexokiLightTheme = withPrColors(flexokiLightRaw as Theme);
const flexokiDarkTheme = withPrColors(flexokiDarkRaw as Theme);
const piariumLightTheme = withPrColors(piariumLightRaw as Theme);
const piariumDarkTheme = withPrColors(piariumDarkRaw as Theme);

export const DEFAULT_LIGHT_THEME_ID = 'piarium-light' as const;
export const DEFAULT_DARK_THEME_ID = 'piarium-dark' as const;

export const themes: Theme[] = [
  piariumLightTheme,
  piariumDarkTheme,
  flexokiLightTheme,
  flexokiDarkTheme,
  ...presetThemes.filter(
    (theme) => theme.metadata.id !== 'piarium-light' && theme.metadata.id !== 'piarium-dark',
  ),
];

export function getThemeById(id: string): Theme | undefined {
  return themes.find(theme => theme.metadata.id === id);
}

export function getDefaultTheme(prefersDark: boolean): Theme {
  const variant: Theme['metadata']['variant'] = prefersDark ? 'dark' : 'light';

  const defaultId = prefersDark ? DEFAULT_DARK_THEME_ID : DEFAULT_LIGHT_THEME_ID;
  const defaultTheme = getThemeById(defaultId);
  if (defaultTheme && defaultTheme.metadata.variant === variant) {
    return defaultTheme;
  }

  return themes.find((theme) => theme.metadata.variant === variant) ?? themes[0] ?? flexokiLightTheme;
}
