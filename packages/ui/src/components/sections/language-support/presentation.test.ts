import { describe, expect, test } from 'bun:test';
import {
  canInstallGrammar,
  grammarStatusKey,
  grammarStatusTone,
  languageServerStatusKey,
  languageServerStatusTone,
} from './presentation';

describe('language support presentation', () => {
  test('maps language-server snapshots to settings keys without inventing a new status owner', () => {
    expect(languageServerStatusKey('ready')).toBe('settings.languageSupport.lsp.ready');
    expect(languageServerStatusKey('absent')).toBe('settings.languageSupport.lsp.absent');
    expect(languageServerStatusTone('ready')).toBe('success');
    expect(languageServerStatusTone('failed')).toBe('danger');
  });

  test('maps structure grammar statuses and only offers install for available packs', () => {
    expect(grammarStatusKey('bundled')).toBe('settings.languageSupport.grammar.bundled');
    expect(grammarStatusKey('user-unverified')).toBe('settings.languageSupport.grammar.userUnverified');
    expect(grammarStatusTone('installed')).toBe('success');
    expect(canInstallGrammar('available')).toBe(true);
    expect(canInstallGrammar('bundled')).toBe(false);
    expect(canInstallGrammar('absent')).toBe(false);
  });
});
