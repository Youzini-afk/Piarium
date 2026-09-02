import type { Express, Request, RequestHandler } from 'express';
import type { MobileDeviceStore, PublicMobileDevice } from './device-store.js';
import type { MobilePairingRuntime } from './pairing-runtime.js';
import type { MobilePushRuntime } from './push-runtime.js';

const normalizeString = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

const getBearerToken = (req: Request): string => {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? normalizeString(match[1]) : '';
};

const resolveServerUrl = (req: Request, explicitOrigin: unknown): string => {
  const configured = normalizeString(explicitOrigin)
    || normalizeString(process.env.PIARIUM_PUBLIC_ORIGIN);
  if (configured) return configured.replace(/\/$/, '');

  const proto = normalizeString(req.headers['x-forwarded-proto']).split(',')[0] || (req.secure ? 'https' : 'http');
  const host = normalizeString(req.headers['x-forwarded-host']).split(',')[0]
    || normalizeString(req.headers.host);
  return host ? `${proto}://${host}` : '';
};

const requireMobileDevice = (
  deviceStore: MobileDeviceStore,
  authenticatedDevices: WeakMap<Request, PublicMobileDevice>,
): RequestHandler => async (req, res, next) => {
  const deviceId = normalizeString(req.headers['x-piarium-device-id']) || normalizeString(req.body?.deviceId);
  const deviceToken = getBearerToken(req) || normalizeString(req.body?.deviceToken);
  const device = await deviceStore.authenticateDevice(deviceId, deviceToken);
  if (!device) {
    return res.status(401).json({ error: 'Mobile device authentication required' });
  }
  authenticatedDevices.set(req, device);
  return next();
};

export interface MobileRoutesDependencies {
  deviceStore: MobileDeviceStore;
  mobilePushRuntime: MobilePushRuntime;
  pairingRuntime: MobilePairingRuntime;
  uiAuthController: {
    issueTrustedSession?: ((req: Request, res: import('express').Response) => Promise<unknown>) | undefined;
    requireAuth: RequestHandler;
  };
}

export const registerMobileRoutes = (app: Express, dependencies: MobileRoutesDependencies): void => {
  const {
    uiAuthController,
    deviceStore,
    pairingRuntime,
    mobilePushRuntime,
  } = dependencies;

  const authenticatedDevices = new WeakMap<Request, PublicMobileDevice>();
  const requireDevice = requireMobileDevice(deviceStore, authenticatedDevices);

  app.use('/api/mobile', (req, res, next) => {
    if (req.path === '/pair/complete') {
      return next();
    }
    const hasDeviceCredentials = Boolean(normalizeString(req.headers['x-piarium-device-id']) && getBearerToken(req));
    if (hasDeviceCredentials) {
      return next();
    }
    return uiAuthController.requireAuth(req, res, next);
  });

  app.post('/api/mobile/pair/start', async (req, res, next) => {
    try {
      const serverUrl = resolveServerUrl(req, req.body?.serverUrl);
      const result = pairingRuntime.startPairing({ serverUrl });
      return res.json({
        ...result,
        qrPayload: {
          serverUrl: result.serverUrl,
          pairingToken: result.pairingToken,
        },
      });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/mobile/pair/complete', async (req, res) => {
    const result = await pairingRuntime.completePairing({
      pairingToken: req.body?.pairingToken,
      deviceName: req.body?.deviceName,
      platform: req.body?.platform,
      appVersion: req.body?.appVersion,
    });
    if (!result.ok) {
      return res.status(401).json({ error: 'Pairing token is invalid or expired' });
    }
    return res.json({
      device: result.device,
      deviceId: result.device.id,
      deviceToken: result.deviceToken,
    });
  });

  app.get('/api/mobile/devices', async (req, res, next) => {
    try {
      const devices = await deviceStore.listDevices();
      return res.json({ devices });
    } catch (error) {
      next(error);
    }
  });

  app.delete('/api/mobile/devices/:id', async (req, res, next) => {
    try {
      const deleted = await deviceStore.deleteDevice(req.params.id);
      return res.json({ ok: true, deleted });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/mobile/devices/register-push', requireDevice, async (req, res) => {
    const pushToken = normalizeString(req.body?.pushToken);
    if (!pushToken) {
      return res.status(400).json({ error: 'pushToken required' });
    }
    const authenticatedDevice = authenticatedDevices.get(req);
    if (!authenticatedDevice) return res.status(401).json({ error: 'Mobile device authentication required' });
    const device = await deviceStore.registerPushToken(authenticatedDevice.id, {
      pushToken,
      pushProvider: req.body?.pushProvider || 'expo',
      appVersion: req.body?.appVersion,
    });
    if (!device) {
      return res.status(404).json({ error: 'Device not found' });
    }
    return res.json({ ok: true, device });
  });

  app.post('/api/mobile/session', requireDevice, async (req, res) => {
    const authenticatedDevice = authenticatedDevices.get(req);
    if (!authenticatedDevice) return res.status(401).json({ error: 'Mobile device authentication required' });
    const result = await pairingRuntime.createLoginToken({
      deviceId: authenticatedDevice.id,
      deviceToken: getBearerToken(req) || req.body?.deviceToken,
    });
    if (!result.ok) {
      return res.status(401).json({ error: 'Mobile device authentication required' });
    }
    return res.json({
      loginUrl: `/mobile-login?t=${encodeURIComponent(result.loginToken)}`,
      expiresAt: result.expiresAt,
    });
  });

  app.get('/mobile-login', async (req, res, next) => {
    try {
      const token = normalizeString(req.query?.t);
      const result = await pairingRuntime.consumeLoginToken(token);
      res.setHeader('Cache-Control', 'no-store');
      if (!result.ok) {
        return res.status(401).type('text/plain').send('Mobile login link is invalid or expired.');
      }
      if (typeof uiAuthController.issueTrustedSession === 'function') {
        await uiAuthController.issueTrustedSession(req, res);
      }
      return res.redirect(302, '/');
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/mobile/devices/:id/test-push', async (req, res, next) => {
    try {
      const result = await mobilePushRuntime.sendTestPush(req.params.id);
      if (!result.ok) {
        return res.status(400).json({ error: result.reason || 'Failed to send test push' });
      }
      return res.json(result);
    } catch (error) {
      next(error);
    }
  });
};
