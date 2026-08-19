import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { dict as enDict } from './en';
import { settingsDict as enSettingsDict } from './en.settings';
import { dict as esDict } from './es';
import { settingsDict as esSettingsDict } from './es.settings';
import { settingsDict as frSettingsDict } from './fr.settings';
import { settingsDict as jaSettingsDict } from './ja.settings';
import { dict as koDict } from './ko';
import { settingsDict as koSettingsDict } from './ko.settings';
import { dict as plDict } from './pl';
import { settingsDict as plSettingsDict } from './pl.settings';
import { dict as ptBrDict } from './pt-BR';
import { settingsDict as ptBrSettingsDict } from './pt-BR.settings';
import { dict as ukDict } from './uk';
import { settingsDict as ukSettingsDict } from './uk.settings';
import { dict as zhCnDict } from './zh-CN';
import { settingsDict as zhCnSettingsDict } from './zh-CN.settings';
import { dict as zhTwDict } from './zh-TW';
import { settingsDict as zhTwSettingsDict } from './zh-TW.settings';

type MessageDict = Record<string, string>;

const localeDictionaries = {
  'zh-CN': zhCnDict,
  'zh-TW': zhTwDict,
  es: esDict,
  'pt-BR': ptBrDict,
  ko: koDict,
  pl: plDict,
  uk: ukDict,
} satisfies Record<string, MessageDict>;

const englishDict: MessageDict = enDict;

const communityAdapterSettingsDictionaries = {
  es: esSettingsDict,
  fr: frSettingsDict,
  ja: jaSettingsDict,
  ko: koSettingsDict,
  pl: plSettingsDict,
  'pt-BR': ptBrSettingsDict,
  uk: ukSettingsDict,
  'zh-CN': zhCnSettingsDict,
  'zh-TW': zhTwSettingsDict,
} satisfies Record<string, MessageDict>;

const placeholderPattern = /\{[a-zA-Z0-9_]+\}/g;
const messageKeyPattern = /^\s*['"]([^'"]+\.[^'"]+)['"]\s*:/gm;
const messagesDir = dirname(fileURLToPath(import.meta.url));

const localeFiles = {
  'zh-CN': ['zh-CN.ts', 'zh-CN.settings.ts'],
  'zh-TW': ['zh-TW.ts', 'zh-TW.settings.ts'],
  es: ['es.ts', 'es.settings.ts'],
  'pt-BR': ['pt-BR.ts', 'pt-BR.settings.ts'],
  ko: ['ko.ts', 'ko.settings.ts'],
  pl: ['pl.ts', 'pl.settings.ts'],
  uk: ['uk.ts', 'uk.settings.ts'],
} satisfies Record<string, readonly string[]>;

const settingsFiles = {
  'zh-CN': 'zh-CN.settings.ts',
  'zh-TW': 'zh-TW.settings.ts',
  es: 'es.settings.ts',
  'pt-BR': 'pt-BR.settings.ts',
  ko: 'ko.settings.ts',
  pl: 'pl.settings.ts',
  uk: 'uk.settings.ts',
} satisfies Record<string, string>;

function sortedKeys(dict: MessageDict): string[] {
  return Object.keys(dict).sort();
}

function placeholders(value: string): string[] {
  return [...new Set(value.match(placeholderPattern) ?? [])].sort();
}

function explicitKeysFromFile(fileName: string): string[] {
  const source = readFileSync(join(messagesDir, fileName), 'utf8');
  return [...source.matchAll(messageKeyPattern)].map((match) => match[1]).sort();
}

function explicitKeysFromFiles(fileNames: readonly string[]): string[] {
  return [...new Set(fileNames.flatMap(explicitKeysFromFile))].sort();
}

function diffKeys(expected: string[], actual: string[]) {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);

  return {
    missing: expected.filter((key) => !actualSet.has(key)),
    extra: actual.filter((key) => !expectedSet.has(key)),
  };
}

describe('i18n message parity', () => {
  test('locale dictionaries define every English key explicitly', () => {
    const englishKeys = sortedKeys(enDict);
    const failures: Record<string, { missing: string[]; extra: string[] }> = {};

    for (const [locale, fileNames] of Object.entries(localeFiles)) {
      const diff = diffKeys(englishKeys, explicitKeysFromFiles(fileNames));
      if (diff.missing.length > 0 || diff.extra.length > 0) {
        failures[locale] = diff;
      }
    }

    expect(failures).toEqual({});
  });

  test('settings split files stay aligned with English settings keys', () => {
    const englishSettingsKeys = sortedKeys(enSettingsDict);
    const failures: Record<string, { missing: string[]; extra: string[] }> = {};

    for (const [locale, fileName] of Object.entries(settingsFiles)) {
      const diff = diffKeys(englishSettingsKeys, explicitKeysFromFile(fileName));
      if (diff.missing.length > 0 || diff.extra.length > 0) {
        failures[locale] = diff;
      }
    }

    expect(failures).toEqual({});
  });

  test('community adapter settings are explicitly translated in every locale', () => {
    const englishSettings = enSettingsDict as MessageDict;
    const keys = sortedKeys(enSettingsDict).filter((key) => (
      key === 'settings.piarium.plugins.package.aft'
      || key === 'settings.piarium.plugins.package.hermesMemory'
      || key.startsWith('settings.piarium.pluginSettings.aft.')
      || key.startsWith('settings.piarium.pluginSettings.hermesMemory.')
    ));
    const failures: Record<string, unknown> = {};

    for (const [locale, dictionary] of Object.entries(communityAdapterSettingsDictionaries)) {
      const messages = dictionary as MessageDict;
      const missing = keys.filter((key) => typeof messages[key] !== 'string');
      const copied = keys.filter((key) => messages[key] === englishSettings[key]);
      const placeholderMismatch = keys.filter((key) => (
        placeholders(messages[key] ?? '').join('\0')
        !== placeholders(englishSettings[key] ?? '').join('\0')
      ));
      if (missing.length > 0 || copied.length > 0 || placeholderMismatch.length > 0) {
        failures[locale] = { copied, missing, placeholderMismatch };
      }
    }

    expect(keys.length).toBeGreaterThan(0);
    expect(failures).toEqual({});
  });

  test('locale placeholders match English placeholders', () => {
    const failures: Record<string, Record<string, { expected: string[]; actual: string[] }>> = {};

    for (const [locale, dict] of Object.entries(localeDictionaries)) {
      for (const key of sortedKeys(enDict)) {
        const localeDict: MessageDict = dict;
        const expected = placeholders(englishDict[key] ?? '');
        const actual = placeholders(localeDict[key] ?? '');
        const missing = expected.filter((placeholder) => !actual.includes(placeholder));
        if (missing.length > 0) {
          failures[locale] ??= {};
          failures[locale][key] = { expected, actual };
        }
      }
    }

    expect(failures).toEqual({});
  });
});
