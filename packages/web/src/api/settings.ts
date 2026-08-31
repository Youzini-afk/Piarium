import type { SettingsAPI, SettingsLoadResult, SettingsPayload } from '@piarium/application-client';
import { runtimeFetch } from '@piarium/application-client';

const SETTINGS_ENDPOINT = '/api/config/settings';

const sanitizePayload = (data: unknown): SettingsPayload => {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid settings response');
  return data as SettingsPayload;
};

export const createWebSettingsAPI = (): SettingsAPI => ({
  async load(): Promise<SettingsLoadResult> {
    const response = await runtimeFetch(SETTINGS_ENDPOINT, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });

    if (!response.ok) {
      throw new Error(`Failed to load settings: ${response.statusText}`);
    }

    const payload = sanitizePayload(await response.json());
    return {
      settings: payload,
      source: 'web',
    };
  },

  async save(changes: Partial<SettingsPayload>): Promise<SettingsPayload> {
    const response = await runtimeFetch(SETTINGS_ENDPOINT, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(changes),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: response.statusText }));
      throw new Error(error.error || 'Failed to save settings');
    }

    const payload = sanitizePayload(await response.json());
    return payload;
  },
});
