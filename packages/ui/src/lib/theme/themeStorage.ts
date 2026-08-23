import type { ThemeMode } from '@/types/theme';

export const PIARIUM_THEME_STORAGE_KEY = 'piarium.theme.v1';

export type StoredThemeColors = {
  background: string;
  foreground: string;
};

export type StoredThemeState = {
  mode: ThemeMode;
  lightThemeId: string;
  darkThemeId: string;
  splash: {
    light: StoredThemeColors;
    dark: StoredThemeColors;
  };
};

const nonEmptyString = (value: unknown): string | null =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;

export const parseStoredThemeState = (raw: string | null): StoredThemeState | null => {
  if (!raw) return null;

  try {
    const candidate = JSON.parse(raw) as Record<string, unknown>;
    const mode = candidate.mode;
    const lightThemeId = nonEmptyString(candidate.lightThemeId);
    const darkThemeId = nonEmptyString(candidate.darkThemeId);
    const splash = candidate.splash as Record<string, unknown> | undefined;
    const light = splash?.light as Record<string, unknown> | undefined;
    const dark = splash?.dark as Record<string, unknown> | undefined;
    const lightBackground = nonEmptyString(light?.background);
    const lightForeground = nonEmptyString(light?.foreground);
    const darkBackground = nonEmptyString(dark?.background);
    const darkForeground = nonEmptyString(dark?.foreground);

    if (
      (mode !== 'light' && mode !== 'dark' && mode !== 'system')
      || !lightThemeId
      || !darkThemeId
      || !lightBackground
      || !lightForeground
      || !darkBackground
      || !darkForeground
    ) {
      return null;
    }

    return {
      mode,
      lightThemeId,
      darkThemeId,
      splash: {
        light: { background: lightBackground, foreground: lightForeground },
        dark: { background: darkBackground, foreground: darkForeground },
      },
    };
  } catch {
    return null;
  }
};

export const readStoredThemeState = (): StoredThemeState | null => {
  if (typeof window === 'undefined') return null;
  try {
    return parseStoredThemeState(window.localStorage.getItem(PIARIUM_THEME_STORAGE_KEY));
  } catch {
    return null;
  }
};

export const writeStoredThemeState = (state: StoredThemeState): void => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(PIARIUM_THEME_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Theme persistence is only a first-paint optimization. React retains the
    // active theme when browser storage is unavailable.
  }
};

