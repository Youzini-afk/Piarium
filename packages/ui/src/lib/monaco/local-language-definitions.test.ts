import { describe, expect, test, vi } from 'vitest';

import type { MonacoRuntime } from './runtime';
import { registerPiariumTokenizationLanguages } from './local-language-definitions';

describe('Piarium tokenization-only languages', () => {
  test('registers JSON syntax without registering a language worker', () => {
    const register = vi.fn();
    const setLanguageConfiguration = vi.fn();
    const setMonarchTokensProvider = vi.fn();
    const monaco = {
      languages: {
        getLanguages: () => [],
        register,
        setLanguageConfiguration,
        setMonarchTokensProvider,
      },
    } as unknown as MonacoRuntime;
    registerPiariumTokenizationLanguages(monaco);
    expect(register).toHaveBeenCalledWith(expect.objectContaining({ id: 'json' }));
    expect(setLanguageConfiguration).toHaveBeenCalledTimes(1);
    expect(setMonarchTokensProvider).toHaveBeenCalledTimes(1);
  });
});
