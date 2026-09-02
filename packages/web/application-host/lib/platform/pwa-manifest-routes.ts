const DEFAULT_PWA_APP_NAME = 'Piarium - Pi Coding Workspace';

export interface PwaManifestRequest {
  query?: Record<string, unknown> | undefined;
}

export interface PwaManifestResponse {
  send(value: string): unknown;
  setHeader(name: string, value: string): unknown;
  type(value: string): unknown;
}

export type PwaManifestHandler = (
  request: PwaManifestRequest,
  response: PwaManifestResponse,
) => Promise<void>;

export interface PwaManifestApp {
  get(path: string, handler: PwaManifestHandler): unknown;
}

const mapPwaOrientationToManifest = (value: unknown): string | undefined => {
  if (value === 'portrait') return 'portrait-primary';
  if (value === 'landscape') return 'landscape-primary';
  return undefined;
};

const finiteTimestamp = (...values: unknown[]): number => {
  for (const value of values) {
    const number = typeof value === 'string' && value.trim() ? Number(value) : value;
    if (typeof number === 'number' && Number.isFinite(number)) return number;
  }
  return 0;
};

interface RecentSession {
  createdAt?: number | string | undefined;
  id?: string | undefined;
  lastActiveAt?: number | string | undefined;
  name?: string | undefined;
  title?: string | undefined;
  updatedAt?: number | string | undefined;
}

interface RecentShortcut {
  description: string;
  icons: Array<{ sizes: string; src: string; type: string }>;
  name: string;
  short_name: string;
  url: string;
}

export interface PwaManifestRouteDependencies {
  listRecentSessions?: (() => Promise<RecentSession[]> | RecentSession[]) | undefined;
  normalizePwaAppName(value: unknown, fallback: string): string | undefined;
  normalizePwaOrientation(value: unknown, fallback: string): string | undefined;
  readSettingsFromDisk(): Promise<Record<string, unknown>>;
}

export const registerPwaManifestRoute = (
  app: PwaManifestApp,
  dependencies: PwaManifestRouteDependencies,
): void => {
  const {
    listRecentSessions = async () => [],
    readSettingsFromDisk,
    normalizePwaAppName,
    normalizePwaOrientation,
  } = dependencies;
  let recentSessionCache: { at: number; data: RecentShortcut[] } | null = null;

  const getRecentSessionShortcuts = async (): Promise<RecentShortcut[]> => {
    const now = Date.now();
    if (recentSessionCache && now - recentSessionCache.at < 5000) return recentSessionCache.data;
    try {
      const sessions = await listRecentSessions();
      const rows = (Array.isArray(sessions) ? sessions : [])
        .map((session, index) => {
          const id = typeof session?.id === 'string' ? session.id.trim().slice(0, 160) : '';
          if (!id) return null;
          const title = (normalizePwaAppName(session.name || session.title, `Session ${index + 1}`)
            ?? `Session ${index + 1}`).slice(0, 48);
          return {
            id,
            title,
            updatedAt: finiteTimestamp(session.lastActiveAt, session.updatedAt, session.createdAt),
          };
        })
        .filter((session): session is { id: string; title: string; updatedAt: number } => Boolean(session))
        .sort((left, right) => right.updatedAt - left.updatedAt)
        .slice(0, 3)
        .map((session) => ({
          name: session.title,
          short_name: session.title.slice(0, 32),
          description: 'Open recent Pi session',
          url: `/?session=${encodeURIComponent(session.id)}`,
          icons: [{ src: '/pwa-192.png', sizes: '192x192', type: 'image/png' }],
        }));
      recentSessionCache = { at: now, data: rows };
      return rows;
    } catch {
      recentSessionCache = { at: now, data: [] };
      return [];
    }
  };

  app.get('/manifest.webmanifest', async (req, res) => {
    const queryName = typeof req.query?.pwa_name === 'string'
      ? req.query.pwa_name
      : typeof req.query?.app_name === 'string'
        ? req.query.app_name
        : typeof req.query?.appName === 'string'
          ? req.query.appName
          : null;
    const queryOrientation = typeof req.query?.orientation === 'string' ? req.query.orientation : null;
    let storedName = '';
    let storedOrientation = 'system';
    try {
      const settings = await readSettingsFromDisk();
      storedName = normalizePwaAppName(settings.pwaAppName, '') ?? '';
      storedOrientation = normalizePwaOrientation(settings.pwaOrientation, 'system') ?? 'system';
    } catch {
      // Defaults keep the manifest valid when settings cannot be read.
    }

    const appName = queryName === null
      ? (storedName || DEFAULT_PWA_APP_NAME)
      : (normalizePwaAppName(queryName, '') || DEFAULT_PWA_APP_NAME);
    const orientation = mapPwaOrientationToManifest(
      queryOrientation === null
        ? storedOrientation
        : normalizePwaOrientation(queryOrientation, 'system') ?? 'system',
    );
    const shortcuts = await getRecentSessionShortcuts();
    const manifest = {
      name: appName,
      short_name: appName.slice(0, 30),
      description: 'Pi-native coding workspace for the Pi agent ecosystem',
      id: '/',
      start_url: '/',
      scope: '/',
      display: 'standalone',
      display_override: ['window-controls-overlay'],
      background_color: '#151313',
      theme_color: '#edb449',
      ...(orientation ? { orientation } : {}),
      icons: [
        { src: '/pwa-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: '/pwa-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
        { src: '/pwa-maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
        { src: '/pwa-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
        { src: '/apple-touch-icon-180x180.png', sizes: '180x180', type: 'image/png', purpose: 'any' },
        { src: '/apple-touch-icon-152x152.png', sizes: '152x152', type: 'image/png', purpose: 'any' },
        { src: '/favicon-32.png', sizes: '32x32', type: 'image/png' },
        { src: '/favicon-16.png', sizes: '16x16', type: 'image/png' },
      ],
      shortcuts: [
        {
          name: 'Appearance Settings',
          short_name: 'Settings',
          description: 'Open appearance settings',
          url: '/?settings=appearance',
          icons: [{ src: '/pwa-192.png', sizes: '192x192', type: 'image/png' }],
        },
        ...shortcuts,
      ],
      categories: ['developer', 'tools', 'productivity'],
      lang: 'en',
    };
    res.setHeader('Cache-Control', 'no-store, must-revalidate');
    res.type('application/manifest+json');
    res.send(JSON.stringify(manifest));
  });
};
