import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';

describe('Language Support settings page', () => {
  test('consumes LanguageSupportAPI and LanguageServicesAPI, not a renderer tree-sitter', () => {
    const source = readFileSync(new URL('./LanguageSupportPage.tsx', import.meta.url), 'utf8');
    expect(source).toContain('SettingsPageLayout');
    expect(source).toContain('useRuntimeAPIs');
    expect(source).toContain('languageSupport.getStatus');
    expect(source).toContain('language.getStatus');
    expect(source).toContain('settings.page.languageSupport.title');
    expect(source).not.toContain('tree-sitter');
    expect(source).not.toContain('web-tree-sitter');
    expect(source).not.toContain('searchFilesystemFiles');
  });
});
