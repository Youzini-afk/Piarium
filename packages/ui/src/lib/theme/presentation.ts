import type { Theme } from '@/types/theme';
import type { I18nKey } from '@/lib/i18n';
import { getThemeById } from './themes';

const presetKeys = {
  'varin': 'settings.theme.preset.varin',
  'flexoki': 'settings.theme.preset.flexoki',
  'fields-of-the-shire': 'settings.theme.preset.fields-of-the-shire',
  'aura': 'settings.theme.preset.aura',
  'ayu': 'settings.theme.preset.ayu',
  'carbonfox': 'settings.theme.preset.carbonfox',
  'catppuccin': 'settings.theme.preset.catppuccin',
  'dracula': 'settings.theme.preset.dracula',
  'gruvbox': 'settings.theme.preset.gruvbox',
  'jetbrains': 'settings.theme.preset.jetbrains',
  'kanagawa': 'settings.theme.preset.kanagawa',
  'monokai': 'settings.theme.preset.monokai',
  'nightowl': 'settings.theme.preset.nightowl',
  'nord': 'settings.theme.preset.nord',
  'onedarkpro': 'settings.theme.preset.onedarkpro',
  'solarized': 'settings.theme.preset.solarized',
  'tokyonight': 'settings.theme.preset.tokyonight',
  'vesper': 'settings.theme.preset.vesper',
  'mono-plus': 'settings.theme.preset.mono-plus',
  'mono': 'settings.theme.preset.mono',
  'vitesse': 'settings.theme.preset.vitesse',
} as const;

/** Translate built-in display copy without changing IDs or user-authored names. */
export function getThemePresentation(theme: Theme, t: (key: I18nKey) => string) {
  const builtin = getThemeById(theme.metadata.id);
  const family = theme.metadata.id.replace(/(?:-(?:light|dark))+$/, '');
  const key = presetKeys[family as keyof typeof presetKeys];
  return {
    name: builtin && key && theme.metadata.name === builtin.metadata.name
      ? t(`${key}.name`) : theme.metadata.name,
    description: builtin && key && theme.metadata.description === builtin.metadata.description
      ? t(`${key}.description`) : theme.metadata.description,
  };
}
