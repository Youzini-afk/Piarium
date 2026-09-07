import type {
  LanguageSupportAPI,
  LanguageSupportInstallResult,
  LanguageSupportStatus,
} from '@piarium/application-client';
import { LanguageSupportError, parseLanguageSupportFailureReason } from '@piarium/application-client';
import { runtimeFetch } from '@piarium/application-client';
import { getRuntimeEndpointGeneration } from '@piarium/application-client';

const assertGeneration = (generation: number): void => {
  if (generation !== getRuntimeEndpointGeneration()) {
    throw new LanguageSupportError('Application host endpoint changed', { reason: 'failed' });
  }
};

const postJson = async (path: string, body: unknown): Promise<unknown> => {
  const generation = getRuntimeEndpointGeneration();
  const response = await runtimeFetch(path, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  assertGeneration(generation);
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText })) as {
      error?: string;
      reason?: unknown;
    };
    throw new LanguageSupportError(error.error || 'Language support request failed', {
      reason: parseLanguageSupportFailureReason(error.reason),
      status: response.status,
    });
  }
  return response.json();
};

export const createWebLanguageSupportAPI = (): LanguageSupportAPI => ({
  getStatus: (request) => postJson('/api/language-support/status', request) as Promise<LanguageSupportStatus>,
  install: (request) => postJson('/api/language-support/install', request) as Promise<LanguageSupportInstallResult>,
  cancelInstall: (request) => postJson('/api/language-support/cancel', request) as Promise<LanguageSupportInstallResult>,
  importUserGrammar: (request) => postJson('/api/language-support/import', request) as Promise<LanguageSupportInstallResult>,
});
