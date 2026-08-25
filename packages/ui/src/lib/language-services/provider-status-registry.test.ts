import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  getLanguageProviderStatus,
  replaceLanguageProviderStatus,
  resetLanguageProviderStatus,
  subscribeLanguageProviderStatus,
} from './provider-status-registry';

const workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

afterEach(() => resetLanguageProviderStatus());

describe('language provider status registry', () => {
  test('keeps the newest provider generation and exposes trigger capabilities', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeLanguageProviderStatus(listener);
    replaceLanguageProviderStatus({
      status: 'ready',
      workspaceId,
      languageId: 'typescript',
      providerId: 'fixture',
      generation: 3,
      features: { completionTriggerCharacters: ['.'] },
    });
    replaceLanguageProviderStatus({
      status: 'ready',
      workspaceId,
      languageId: 'typescript',
      providerId: 'fixture',
      generation: 3,
      features: { completionTriggerCharacters: ['.', ':'] },
    });
    replaceLanguageProviderStatus({
      status: 'absent',
      workspaceId,
      languageId: 'typescript',
      providerId: 'fixture',
      generation: 2,
    });
    expect(getLanguageProviderStatus(workspaceId, 'typescript')).toMatchObject({
      status: 'ready',
      generation: 3,
      features: { completionTriggerCharacters: ['.', ':'] },
    });
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });
});
