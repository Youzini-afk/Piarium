import { createContext } from 'react';

import type { Theme, ThemeMode } from '@/types/theme';

export interface ThemeContextValue {
  currentTheme: Theme;
  availableThemes: Theme[];
  customThemesLoading: boolean;
  reloadCustomThemes: () => Promise<void>;
  themeMode: ThemeMode;
  setThemeMode: (mode: ThemeMode) => void;
  lightThemeId: string;
  darkThemeId: string;
  setLightThemePreference: (themeId: string) => void;
  setDarkThemePreference: (themeId: string) => void;
}

export const ThemeSystemContext = createContext<ThemeContextValue | undefined>(undefined);
