import { describe, expect, it, vi } from 'vitest';
import { registerPwaManifestRoute } from './pwa-manifest-routes.js';

const createResponse = () => ({
  headers: new Map(),
  contentType: '',
  body: '',
  setHeader(name, value) {
    this.headers.set(name, value);
    return this;
  },
  type(value) {
    this.contentType = value;
    return this;
  },
  send(value) {
    this.body = value;
    return this;
  },
});

describe('PWA manifest route', () => {
  it('builds recent shortcuts from Pi sessions without an HTTP lifecycle dependency', async () => {
    const routes = new Map();
    const listRecentSessions = vi.fn(async () => [
      { id: 'ses_old', name: 'Older task', lastActiveAt: 10 },
      { id: 'ses_new', name: 'Latest task', lastActiveAt: 20 },
    ]);
    registerPwaManifestRoute({
      get(route, handler) {
        routes.set(route, handler);
      },
    }, {
      listRecentSessions,
      readSettingsFromDisk: async () => ({}),
      normalizePwaAppName: (value, fallback) => typeof value === 'string' && value.trim() ? value.trim() : fallback,
      normalizePwaOrientation: (value, fallback) => typeof value === 'string' && value.trim() ? value.trim() : fallback,
    });

    const res = createResponse();
    await routes.get('/manifest.webmanifest')({ query: {} }, res);

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
