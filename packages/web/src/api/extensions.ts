import {
  parsePiariumExtensionCatalogAvailability,
  type PiariumExtensionCatalogAvailability,
} from '@piarium/extension-contract';
import type { ExtensionsAPI } from '@piarium/ui/lib/api/types';
import { refreshLocalRuntimeUrlAuthToken } from '@piarium/ui/lib/runtime-auth';
import { fetchWithoutRuntimeRouting } from '@piarium/ui/lib/runtime-fetch';

const normalizeOrigin = (value: string): string => value.trim().replace(/\/+$/, '');

const applicationHostOrigin = (): string => {
  if (typeof window === 'undefined') return '';
  const injected = typeof window.__PIARIUM_LOCAL_ORIGIN__ === 'string'
    ? normalizeOrigin(window.__PIARIUM_LOCAL_ORIGIN__)
    : '';
  return injected || normalizeOrigin(window.location.origin);
};

const currentOrigin = (): string => {
  if (typeof window === 'undefined') return '';
  return normalizeOrigin(window.location.origin);
};

const errorResult = (message: string, retryable: boolean): PiariumExtensionCatalogAvailability => ({
  supported: true,
  status: 'error',
  error: { code: 'application_host_unavailable', message, retryable },
});

export const createWebExtensionsAPI = (): ExtensionsAPI => ({
  catalog: async () => {
    try {
      const origin = applicationHostOrigin();
      const target = origin
        ? new URL('/api/piarium/extensions/v1/catalog', `${origin}/`)
        : new URL('/api/piarium/extensions/v1/catalog', window.location.href);
      if (origin && origin !== currentOrigin()) {
        const token = await refreshLocalRuntimeUrlAuthToken(origin);
        target.searchParams.set('piarium_url_token', token);
      }
      const response = await fetchWithoutRuntimeRouting(target, {
        credentials: 'include',
        headers: { Accept: 'application/json' },
      });
      const payload = await response.json().catch(() => null) as unknown;
      if (!response.ok) {
        try {
          const parsed = parsePiariumExtensionCatalogAvailability(payload);
          if (parsed.supported === true && parsed.status === 'error') return parsed;
        } catch {
          // The HTTP status below remains the authoritative failure when the error body is malformed.
        }
        return errorResult(`Extension catalog request failed (${response.status})`, response.status >= 500);
      }
      return parsePiariumExtensionCatalogAvailability(payload);
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : String(error), true);
    }
  },
});
