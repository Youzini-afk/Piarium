import { describe, expect, it, vi } from 'vitest';
import {
  registerPwaManifestRoute,
  type PwaManifestHandler,
  type PwaManifestResponse,
} from './pwa-manifest-routes.js';

interface TestResponse extends PwaManifestResponse {
  body: string;
  contentType: string;
  headers: Map<string, string>;
}

const createResponse = (): TestResponse => ({
  headers: new Map<string, string>(),
  contentType: '',
  body: '',
  setHeader(name: string, value: string) {
    this.headers.set(name, value);
    return this;
  },
  type(value: string) {
    this.contentType = value;
    return this;
  },
  send(value: string) {
    this.body = value;
    return this;
  },
});

describe('PWA manifest route', () => {
  it('builds recent shortcuts from Pi sessions without an HTTP lifecycle dependency', async () => {
    const routes = new Map<string, PwaManifestHandler>();
    const listRecentSessions = vi.fn(async () => [
      { id: 'ses_old', name: 'Older task', lastActiveAt: 10 },
      { id: 'ses_new', name: 'Latest task', lastActiveAt: 20 },
    ]);
    registerPwaManifestRoute({
      get(route: string, handler: PwaManifestHandler) {
        routes.set(route, handler);
      },
    }, {
      listRecentSessions,
      readSettingsFromDisk: async () => ({}),
      normalizePwaAppName: (value, fallback) => typeof value === 'string' && value.trim() ? value.trim() : fallback,
      normalizePwaOrientation: (value, fallback) => typeof value === 'string' && value.trim() ? value.trim() : fallback,
    });

    const res = createResponse();
    const handler = routes.get('/manifest.webmanifest');
    if (!handler) throw new Error('Expected PWA manifest handler');
    await handler({ query: {} }, res);

    expect(listRecentSessions).toHaveBeenCalledOnce();
    expect(JSON.parse(res.body).shortcuts).toEqual([
      {
        name: 'Appearance Settings',
        short_name: 'Settings',
        description: 'Open appearance settings',
        url: '/?settings=appearance',
        icons: [{ src: '/pwa-192.png', sizes: '192x192', type: 'image/png' }],
      },
      {
        name: 'Latest task',
        short_name: 'Latest task',
        description: 'Open recent Pi session',
        url: '/?session=ses_new',
        icons: [{ src: '/pwa-192.png', sizes: '192x192', type: 'image/png' }],
      },
      {
        name: 'Older task',
        short_name: 'Older task',
        description: 'Open recent Pi session',
        url: '/?session=ses_old',
        icons: [{ src: '/pwa-192.png', sizes: '192x192', type: 'image/png' }],
      },
    ]);
  });
});
