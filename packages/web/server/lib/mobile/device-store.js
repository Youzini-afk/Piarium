const MOBILE_DEVICES_VERSION = 1;
const DEVICE_TOKEN_PREFIX = 'ocm_';

const normalizeString = (value) => (typeof value === 'string' ? value.trim() : '');

const normalizePlatform = (value) => {
  const normalized = normalizeString(value).toLowerCase();
  if (normalized === 'ios' || normalized === 'android') return normalized;
  return 'unknown';
};

const sanitizeDevice = (entry) => {
  if (!entry || typeof entry !== 'object') return null;
  const id = normalizeString(entry.id);
  const tokenHash = normalizeString(entry.tokenHash);
  if (!id || !tokenHash) return null;

  return {
    id,
    tokenHash,
    name: normalizeString(entry.name) || 'Mobile device',
    platform: normalizePlatform(entry.platform),
    appVersion: normalizeString(entry.appVersion) || null,
    pushProvider: normalizeString(entry.pushProvider) || null,
    pushToken: normalizeString(entry.pushToken) || null,
    enabled: entry.enabled !== false,
    createdAt: Number.isFinite(entry.createdAt) ? entry.createdAt : Date.now(),
    lastSeenAt: Number.isFinite(entry.lastSeenAt) ? entry.lastSeenAt : null,
    lastPushSuccessAt: Number.isFinite(entry.lastPushSuccessAt) ? entry.lastPushSuccessAt : null,
    lastPushFailureAt: Number.isFinite(entry.lastPushFailureAt) ? entry.lastPushFailureAt : null,
  };
};

const publicDevice = (device) => ({
  id: device.id,
  name: device.name,
  platform: device.platform,
  appVersion: device.appVersion,
  pushProvider: device.pushProvider,
  pushEnabled: Boolean(device.enabled && device.pushToken),
  enabled: device.enabled,
  createdAt: device.createdAt,
  lastSeenAt: device.lastSeenAt,
  lastPushSuccessAt: device.lastPushSuccessAt,
  lastPushFailureAt: device.lastPushFailureAt,
});

export const createMobileDeviceStore = (deps) => {
  const {
    fsPromises,
    path,
    crypto,
    mobileDevicesFilePath,
  } = deps;

  let persistLock = Promise.resolve();

  const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');
  const createDeviceToken = () => `${DEVICE_TOKEN_PREFIX}${crypto.randomBytes(32).toString('base64url')}`;
  const createDeviceId = () => `mob_${crypto.randomBytes(12).toString('base64url')}`;

  const readStore = async () => {
    try {
      const raw = await fsPromises.readFile(mobileDevicesFilePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || parsed.version !== MOBILE_DEVICES_VERSION) {
        return { version: MOBILE_DEVICES_VERSION, devices: [] };
      }
      const devices = Array.isArray(parsed.devices)
        ? parsed.devices.map(sanitizeDevice).filter(Boolean)
        : [];
      return { version: MOBILE_DEVICES_VERSION, devices };
    } catch (error) {
      if (error && typeof error === 'object' && error.code === 'ENOENT') {
        return { version: MOBILE_DEVICES_VERSION, devices: [] };
      }
      console.warn('[Mobile] Failed to read devices file:', error?.message || error);
      return { version: MOBILE_DEVICES_VERSION, devices: [] };
    }
  };

  const writeStore = async (store) => {
    await fsPromises.mkdir(path.dirname(mobileDevicesFilePath), { recursive: true });
    await fsPromises.writeFile(mobileDevicesFilePath, JSON.stringify(store, null, 2), 'utf8');
  };

  const updateStore = async (mutate) => {
    persistLock = persistLock.then(async () => {
      const current = await readStore();
      const next = await mutate({
        version: MOBILE_DEVICES_VERSION,
        devices: current.devices,
      });
      await writeStore(next);
      return next;
    });
    return persistLock;
  };

  const listDevices = async () => {
    const store = await readStore();
    return store.devices.map(publicDevice);
  };

  const createDevice = async ({ name, platform, appVersion } = {}) => {
    const token = createDeviceToken();
    const now = Date.now();
    const device = {
      id: createDeviceId(),
      tokenHash: hashToken(token),
      name: normalizeString(name) || 'Mobile device',
      platform: normalizePlatform(platform),
      appVersion: normalizeString(appVersion) || null,
      pushProvider: null,
      pushToken: null,
      enabled: true,
      createdAt: now,
      lastSeenAt: now,
      lastPushSuccessAt: null,
      lastPushFailureAt: null,
    };

    await updateStore((current) => ({
      ...current,
      devices: [device, ...current.devices.filter((entry) => entry.id !== device.id)],
    }));

    return { device: publicDevice(device), deviceToken: token };
  };

  const authenticateDevice = async (deviceId, deviceToken) => {
    const id = normalizeString(deviceId);
    const token = normalizeString(deviceToken);
    if (!id || !token) return null;
    const tokenHash = hashToken(token);
    const store = await readStore();
    const device = store.devices.find((entry) => entry.id === id && entry.tokenHash === tokenHash && entry.enabled !== false);
    return device ? publicDevice(device) : null;
  };

  const touchDevice = async (deviceId) => {
    const id = normalizeString(deviceId);
    if (!id) return null;
    let touched = null;
    await updateStore((current) => {
      const devices = current.devices.map((device) => {
        if (device.id !== id) return device;
        touched = { ...device, lastSeenAt: Date.now() };
        return touched;
      });
      return { ...current, devices };
    });
    return touched ? publicDevice(touched) : null;
  };

  const registerPushToken = async (deviceId, { pushToken, pushProvider = 'expo', appVersion } = {}) => {
    const id = normalizeString(deviceId);
    const token = normalizeString(pushToken);
    if (!id || !token) return null;
    let updated = null;
    await updateStore((current) => {
      const devices = current.devices.map((device) => {
        if (device.id !== id) return device;
        updated = {
          ...device,
          pushProvider: normalizeString(pushProvider) || 'expo',
          pushToken: token,
          appVersion: normalizeString(appVersion) || device.appVersion,
          enabled: true,
          lastSeenAt: Date.now(),
        };
        return updated;
      });
      return { ...current, devices };
    });
    return updated ? publicDevice(updated) : null;
  };

  const deleteDevice = async (deviceId) => {
    const id = normalizeString(deviceId);
    if (!id) return false;
    let removed = false;
    await updateStore((current) => {
      const devices = current.devices.filter((device) => {
        if (device.id === id) {
          removed = true;
          return false;
        }
        return true;
      });
      return { ...current, devices };
    });
    return removed;
  };

  const listPushTargets = async () => {
    const store = await readStore();
    return store.devices
      .filter((device) => device.enabled !== false && device.pushProvider === 'expo' && device.pushToken)
      .map((device) => ({
        id: device.id,
        pushProvider: device.pushProvider,
        pushToken: device.pushToken,
      }));
  };

  const markPushResult = async (deviceId, success) => {
    const id = normalizeString(deviceId);
    if (!id) return;
    await updateStore((current) => {
      const devices = current.devices.map((device) => {
        if (device.id !== id) return device;
        return {
          ...device,
          lastPushSuccessAt: success ? Date.now() : device.lastPushSuccessAt,
          lastPushFailureAt: success ? device.lastPushFailureAt : Date.now(),
        };
      });
      return { ...current, devices };
    });
  };

  const disablePushToken = async (pushToken) => {
    const token = normalizeString(pushToken);
    if (!token) return;
    await updateStore((current) => {
      const devices = current.devices.map((device) => {
        if (device.pushToken !== token) return device;
        return {
          ...device,
          pushToken: null,
          lastPushFailureAt: Date.now(),
        };
      });
      return { ...current, devices };
    });
  };

  return {
    listDevices,
    createDevice,
    authenticateDevice,
    touchDevice,
    registerPushToken,
    deleteDevice,
    listPushTargets,
    markPushResult,
    disablePushToken,
  };
};
