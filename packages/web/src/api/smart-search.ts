import type {
  SmartSearchAPI,
  SmartSearchConfigPatch,
  SmartSearchConfigResponse,
  SmartSearchDoctorResponse,
  SmartSearchStatusResponse,
} from '@openchamber/ui/lib/api/types';
import { runtimeFetch } from '@openchamber/ui/lib/runtime-fetch';

const STATUS_ENDPOINT = '/api/smart-search/status';
const CONFIG_ENDPOINT = '/api/smart-search/config';
const DOCTOR_ENDPOINT = '/api/smart-search/doctor';

const readJson = async <T>(response: Response): Promise<T> => {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = typeof payload?.error === 'string' ? payload.error : response.statusText;
    throw new Error(message || 'Smart Search request failed');
  }
  return payload as T;
};

export const createWebSmartSearchAPI = (): SmartSearchAPI => ({
  async status(): Promise<SmartSearchStatusResponse> {
    const response = await runtimeFetch(STATUS_ENDPOINT, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    return readJson<SmartSearchStatusResponse>(response);
  },

  async loadConfig(): Promise<SmartSearchConfigResponse> {
    const response = await runtimeFetch(CONFIG_ENDPOINT, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    return readJson<SmartSearchConfigResponse>(response);
  },

  async saveConfig(patch: SmartSearchConfigPatch): Promise<SmartSearchConfigResponse> {
    const response = await runtimeFetch(CONFIG_ENDPOINT, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(patch),
    });
    return readJson<SmartSearchConfigResponse>(response);
  },

  async doctor(): Promise<SmartSearchDoctorResponse> {
    const response = await runtimeFetch(DOCTOR_ENDPOINT, {
      method: 'POST',
      headers: { Accept: 'application/json' },
    });
    return readJson<SmartSearchDoctorResponse>(response);
  },
});
