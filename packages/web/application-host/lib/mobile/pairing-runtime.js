const PAIRING_TOKEN_TTL_MS = 5 * 60 * 1000;
const MOBILE_LOGIN_TOKEN_TTL_MS = 60 * 1000;

const normalizeString = (value) => (typeof value === 'string' ? value.trim() : '');

export const createMobilePairingRuntime = (deps) => {
  const {
    crypto,
    deviceStore,
    pairingTokenTtlMs = PAIRING_TOKEN_TTL_MS,
    loginTokenTtlMs = MOBILE_LOGIN_TOKEN_TTL_MS,
  } = deps;

  const pairingTokens = new Map();
  const loginTokens = new Map();

  const createToken = (prefix) => `${prefix}_${crypto.randomBytes(32).toString('base64url')}`;

  const pruneExpired = (map) => {
    const now = Date.now();
    for (const [token, entry] of map.entries()) {
      if (!entry || typeof entry.expiresAt !== 'number' || entry.expiresAt <= now) {
        map.delete(token);
      }
    }
  };

  const startPairing = ({ serverUrl } = {}) => {
    pruneExpired(pairingTokens);
    const token = createToken('pair');
    const expiresAt = Date.now() + pairingTokenTtlMs;
    pairingTokens.set(token, {
      token,
      serverUrl: normalizeString(serverUrl),
      expiresAt,
      used: false,
    });
    return { pairingToken: token, expiresAt, serverUrl: normalizeString(serverUrl) || null };
  };

  const completePairing = async ({ pairingToken, deviceName, platform, appVersion } = {}) => {
    pruneExpired(pairingTokens);
    const token = normalizeString(pairingToken);
    const entry = token ? pairingTokens.get(token) : null;
    if (!entry || entry.used || entry.expiresAt <= Date.now()) {
      return { ok: false, reason: 'invalid-token' };
    }

    pairingTokens.delete(token);
    const result = await deviceStore.createDevice({
      name: deviceName,
      platform,
      appVersion,
    });
    return { ok: true, ...result };
  };

  const createLoginToken = async ({ deviceId, deviceToken } = {}) => {
    pruneExpired(loginTokens);
    const device = await deviceStore.authenticateDevice(deviceId, deviceToken);
    if (!device) {
      return { ok: false, reason: 'unauthorized' };
    }
    const token = createToken('login');
    const expiresAt = Date.now() + loginTokenTtlMs;
    loginTokens.set(token, {
      token,
      deviceId: device.id,
      expiresAt,
    });
    await deviceStore.touchDevice(device.id);
    return { ok: true, loginToken: token, expiresAt, device };
  };

  const consumeLoginToken = async (token) => {
    pruneExpired(loginTokens);
    const normalized = normalizeString(token);
    const entry = normalized ? loginTokens.get(normalized) : null;
    if (!entry || entry.expiresAt <= Date.now()) {
      return { ok: false, reason: 'invalid-token' };
    }
    loginTokens.delete(normalized);
    await deviceStore.touchDevice(entry.deviceId);
    return { ok: true, deviceId: entry.deviceId };
  };

  return {
    startPairing,
    completePairing,
    createLoginToken,
    consumeLoginToken,
  };
};
