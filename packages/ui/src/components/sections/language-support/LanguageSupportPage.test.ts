import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';

describe('Language Support settings page', () => {
  test('consumes LanguageSupportAPI and LanguageServicesAPI, not a renderer tree-sitter', () => {
    const source = readFileSync(new URL('./LanguageSupportPage.tsx', import.meta.url), 'utf8');
    expect(source).toContain('SettingsPageLayout');
    expect(source).toContain('useRuntimeAPIs');
    expect(source).toContain('languageSupport.getStatus');
    expect(source).toContain('languageSupport.install');
    expect(source).toContain('languageSupport.importUserGrammar');
    expect(source).toContain('language.getStatus');
    expect(source).toContain('settings.page.languageSupport.title');
    expect(source).not.toContain('tree-sitter');
    expect(source).not.toContain('web-tree-sitter');
    expect(source).not.toContain('searchFilesystemFiles');
  });

  test('states the download size, the structure note and an unreadable index', () => {
    const source = readFileSync(new URL('./LanguageSupportPage.tsx', import.meta.url), 'utf8');
    expect(source).toContain('formatPackBytes(row.pack.bytes)');
    expect(source).toContain('structureNoteKey(row)');
    expect(source).toContain('grammarStatusTone(row.grammarStatus, row.capabilities)');
    expect(source).toContain("status?.grammarStore === 'unreadable'");
    expect(source).toContain('settings.languageSupport.storeUnreadable');
  });
});
