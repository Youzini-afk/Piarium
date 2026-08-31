import type { PiRuntimeSnapshot } from '@piarium/protocol';
import type { PiRuntimeManagementAPI } from '@piarium/application-client';
import { runtimeFetch } from '@piarium/ui/lib/runtime-fetch';
import { getRuntimeUrlResolver } from '@piarium/ui/lib/runtime-url';

const MANAGER_PREFIX = '/api/piarium/runtime-manager';

const readSnapshot = async (response: Response): Promise<PiRuntimeSnapshot> => {
  const payload = await response.json().catch(() => ({ error: response.statusText }));
  if (!response.ok) {
    throw new Error(typeof payload.error === 'string' ? payload.error : 'Pi runtime manager request failed');
  }
  return payload as PiRuntimeSnapshot;
};

const postSnapshot = async (path: string, body?: Record<string, string>): Promise<PiRuntimeSnapshot> => {
  const response = await runtimeFetch(`${MANAGER_PREFIX}${path}`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return readSnapshot(response);
};

export const createWebPiRuntimeAPI = (): PiRuntimeManagementAPI => ({
  capabilities: {
    install: true,
    openLocation: true,
    pickPackageRoot: true,
  },
  async getSnapshot() {
    const response = await runtimeFetch(MANAGER_PREFIX, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    return readSnapshot(response);
  },
  subscribe(listener) {
    const source = new EventSource(getRuntimeUrlResolver().sse(`${MANAGER_PREFIX}/events`));
    source.onmessage = (event) => {
      try {
        listener(JSON.parse(event.data) as PiRuntimeSnapshot);
      } catch {
        // Ignore a single malformed snapshot; the next event remains authoritative.
      }
    };
    return () => source.close();
  },
  refresh: () => postSnapshot('/refresh'),
  install: () => postSnapshot('/install'),
  upgrade: () => postSnapshot('/upgrade'),
  activate: (id) => postSnapshot('/activate', { id }),
  activateCustom: (packageRoot, nodePath) => postSnapshot('/activate-custom', {
    packageRoot,
    ...(nodePath ? { nodePath } : {}),
  }),
  async pickPackageRoot() {
    const response = await runtimeFetch(`${MANAGER_PREFIX}/pick`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: '{}',
    });
    if (response.status === 501) return null;
    const payload = await response.json().catch(() => ({ error: response.statusText }));
    if (!response.ok) {
      throw new Error(typeof payload.error === 'string' ? payload.error : 'Failed to choose a Pi package root');
    }
    return typeof payload.packageRoot === 'string' ? payload.packageRoot : null;
  },
  async openLocation(targetPath) {
    const response = await runtimeFetch(`${MANAGER_PREFIX}/open-location`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: targetPath }),
    });
    if (response.status === 501) return;
    if (!response.ok) {
      const payload = await response.json().catch(() => ({ error: response.statusText }));
      throw new Error(typeof payload.error === 'string' ? payload.error : 'Failed to open location');
    }
  },
});
