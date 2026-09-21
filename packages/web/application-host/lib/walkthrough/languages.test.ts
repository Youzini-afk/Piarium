import { describe, expect, it } from 'vitest';
import { normalizeLanguage } from './languages.js';

const uiRuntime = new URL('../../../../ui/src/lib/i18n/runtime.ts', import.meta.url).href;
const { LOCALES } = await import(uiRuntime) as { LOCALES: readonly string[] };

// Check the actual picker values, without locking the spelling of its source
// declaration or exposing the server's private lookup table to tests.
describe('supported languages', () => {
  it('resolves every interface locale to itself rather than to the default', () => {
    for (const locale of LOCALES) {
      expect(normalizeLanguage(locale)).toBe(locale);
    }
  });
});
