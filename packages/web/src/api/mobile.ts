import type {
  MobileAPI,
  MobileDevice,
  MobilePairStartResult,
  MobileTestPushResult,
} from '@openchamber/ui/lib/api/types';

const fetchJson = async <T>(input: RequestInfo | URL, init?: RequestInit): Promise<T | null> => {
  try {
    const res = await fetch(input, {
      ...init,
      credentials: 'include',
      headers: {
        Accept: 'application/json',
        ...(init?.headers ?? {}),
      },
    });

    if (!res.ok) {
      return null;
    }

    return (await res.json()) as T;
  } catch {
    return null;
  }
};

export const createWebMobileAPI = (): MobileAPI => ({
  async startPairing(payload = {}) {
    return fetchJson<MobilePairStartResult>('/api/mobile/pair/start', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
  },

  async listDevices() {
    return fetchJson<{ devices: MobileDevice[] }>('/api/mobile/devices');
  },

  async deleteDevice(deviceId: string) {
    return fetchJson<{ ok: true; deleted: boolean }>(`/api/mobile/devices/${encodeURIComponent(deviceId)}`, {
      method: 'DELETE',
    });
  },

  async sendTestPush(deviceId: string) {
    return fetchJson<MobileTestPushResult>(`/api/mobile/devices/${encodeURIComponent(deviceId)}/test-push`, {
      method: 'POST',
    });
  },
});
