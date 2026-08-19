import { describe, expect, test } from 'bun:test';
import { settingsDict as en } from './en.settings';
import { settingsDict as es } from './es.settings';
import { settingsDict as fr } from './fr.settings';
import { settingsDict as ja } from './ja.settings';
import { settingsDict as ko } from './ko.settings';
import { settingsDict as pl } from './pl.settings';
import { settingsDict as ptBr } from './pt-BR.settings';
import { settingsDict as uk } from './uk.settings';
import { settingsDict as zhCn } from './zh-CN.settings';
import { settingsDict as zhTw } from './zh-TW.settings';

const PREFIXES = [
  'settings.piarium.pluginSettings.permissionSystem.',
  'settings.piarium.plugins.package.permissionSystem',
] as const;

const dictionaries = { en, es, fr, ja, ko, pl, 'pt-BR': ptBr, uk, 'zh-CN': zhCn, 'zh-TW': zhTw };

const permissionSystemKeys = Object.keys(en).filter((key) => (
  PREFIXES.some((prefix) => key.startsWith(prefix))
));

const translatedSentenceKeys = [
  'settings.piarium.plugins.package.permissionSystem',
  'settings.piarium.pluginSettings.permissionSystem.warning.yoloMode',
  'settings.piarium.pluginSettings.permissionSystem.validation.trailingComma',
  'settings.piarium.pluginSettings.permissionSystem.runtime.notObserved',
  'settings.piarium.pluginSettings.permissionSystem.runtime.busy',
  'settings.piarium.pluginSettings.permissionSystem.runtime.commandFailed',
] as const;

describe('permission-system settings messages', () => {
  test('defines the complete adapter vocabulary in all ten settings locales', () => {
    expect(permissionSystemKeys.length > 0).toBe(true);
    for (const dict of Object.values(dictionaries)) {
      expect(permissionSystemKeys.filter((key) => !(key in dict))).toEqual([]);
    }
  });

  test('uses localized prose instead of English placeholders', () => {
    for (const [locale, dict] of Object.entries(dictionaries)) {
      if (locale === 'en') continue;
      for (const key of translatedSentenceKeys) {
        expect(dict[key as keyof typeof dict]).not.toBe(en[key]);
      }
    }
  });
});
