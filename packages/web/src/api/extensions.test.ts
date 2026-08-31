import { afterEach, describe, expect, it, vi } from 'vitest';

const refreshLocalRuntimeUrlAuthToken = vi.fn();
const fetchWithoutRuntimeRouting = vi.fn();

vi.mock('@piarium/application-client', () => ({
  fetchWithoutRuntimeRouting,
  refreshLocalRuntimeUrlAuthToken,
}));

const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');

afterEach(() => {
  vi.restoreAllMocks();
  refreshLocalRuntimeUrlAuthToken.mockReset();
  fetchWithoutRuntimeRouting.mockReset();
  if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
  else Reflect.deleteProperty(globalThis, 'window');
});

describe('createWebExtensionsAPI', () => {
  it('reads from the application host instead of the selected Pi runtime', async () => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        __PIARIUM_API_BASE_URL__: 'https://remote-pi.example',
        __PIARIUM_LOCAL_ORIGIN__: 'http://127.0.0.1:57123',
        location: { href: 'piarium-ui://app/', origin: 'piarium-ui://app' },
      },
    });
    refreshLocalRuntimeUrlAuthToken.mockResolvedValue('local-url-token');
    fetchWithoutRuntimeRouting.mockResolvedValue(Response.json({
      supported: true,
      status: 'ready',
      snapshot: {
        schemaVersion: 1,
        hostId: '2d7b1dc1-7ccd-4be7-9fd1-23f31dc8cf1a',
        revision: 0,
        loadedAt: '2026-08-14T00:00:00.000Z',
        authoritative: true,
        storageState: 'missing',
        diagnostics: [],
        extensions: [],
      },
    }));

    const { createWebExtensionsAPI } = await import('./extensions');
    const result = await createWebExtensionsAPI().catalog();

    expect(result.supported).toBe(true);
    expect(refreshLocalRuntimeUrlAuthToken).toHaveBeenCalledWith('http://127.0.0.1:57123');
    const target = new URL(String(fetchWithoutRuntimeRouting.mock.calls[0]?.[0]));
    expect(target.origin).toBe('http://127.0.0.1:57123');
    expect(target.pathname).toBe('/api/piarium/extensions/v1/catalog');
    expect(target.searchParams.get('piarium_url_token')).toBe('local-url-token');
  });

  it('reloads a local source by stored extension identity without sending a source specifier', async () => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        __PIARIUM_LOCAL_ORIGIN__: 'http://127.0.0.1:57123',
        location: { href: 'piarium-ui://app/', origin: 'piarium-ui://app' },
      },
    });
    refreshLocalRuntimeUrlAuthToken.mockResolvedValue('local-url-token');
    fetchWithoutRuntimeRouting.mockResolvedValue(Response.json({
      outcome: 'unchanged',
      snapshot: {
        schemaVersion: 1,
        hostId: '2d7b1dc1-7ccd-4be7-9fd1-23f31dc8cf1a',
        revision: 7,
        loadedAt: '2026-08-14T00:00:00.000Z',
        authoritative: true,
        storageState: 'ready',
        diagnostics: [],
        extensions: [],
      },
    }));

    const { createWebExtensionsAPI } = await import('./extensions');
    const result = await createWebExtensionsAPI().reloadLocalSource({
      expectedRevision: 7,
      extensionId: 'dev.example.local',
    });

    expect(result.outcome).toBe('unchanged');
    const [target, init] = fetchWithoutRuntimeRouting.mock.calls[0] as [URL, RequestInit];
    expect(target.pathname).toBe('/api/piarium/extensions/v1/extensions/dev.example.local/reload-local-source');
    expect(JSON.parse(String(init.body))).toEqual({
      expectedRevision: 7,
      extensionId: 'dev.example.local',
    });
    expect(String(init.body)).not.toContain('specifier');
  });

  it('sends the explicit extension-data choice when removing an extension', async () => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        __PIARIUM_LOCAL_ORIGIN__: 'http://127.0.0.1:57123',
        location: { href: 'piarium-ui://app/', origin: 'piarium-ui://app' },
      },
    });
    refreshLocalRuntimeUrlAuthToken.mockResolvedValue('local-url-token');
    fetchWithoutRuntimeRouting.mockResolvedValue(Response.json({
      snapshot: {
        schemaVersion: 1,
        hostId: '2d7b1dc1-7ccd-4be7-9fd1-23f31dc8cf1a',
        revision: 8,
        loadedAt: '2026-08-14T00:00:00.000Z',
        authoritative: true,
        storageState: 'ready',
        diagnostics: [],
        extensions: [],
      },
    }));

    const { createWebExtensionsAPI } = await import('./extensions');
    await createWebExtensionsAPI().removeExtension({
      deleteData: true,
      expectedRevision: 7,
      extensionId: 'dev.example.local',
    });

    const [target, init] = fetchWithoutRuntimeRouting.mock.calls[0] as [URL, RequestInit];
    expect(target.pathname).toBe('/api/piarium/extensions/v1/extensions/dev.example.local');
    expect(init.method).toBe('DELETE');
    expect(JSON.parse(String(init.body))).toEqual({
      deleteData: true,
      expectedRevision: 7,
      extensionId: 'dev.example.local',
    });
  });
});
