import {
  createSettingsFileStore,
  type PiariumSettingsDocument,
  type SettingsFileStore,
} from '@piarium/settings-store';
import type crypto from 'node:crypto';

const MOBILE_DEVICES_VERSION = 1;
const DEVICE_TOKEN_PREFIX = 'ocm_';

const normalizeString = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

export type MobilePlatform = 'android' | 'ios' | 'unknown';

const normalizePlatform = (value: unknown): MobilePlatform => {
  const normalized = normalizeString(value).toLowerCase();
  if (normalized === 'ios' || normalized === 'android') return normalized;
  return 'unknown';
};

interface StoredMobileDevice {
  appVersion: string | null;
  createdAt: number;
  enabled: boolean;
  id: string;
  lastPushFailureAt: number | null;
  lastPushSuccessAt: number | null;
  lastSeenAt: number | null;
  name: string;
  platform: MobilePlatform;
  pushProvider: string | null;
  pushToken: string | null;
  tokenHash: string;
}

export interface PublicMobileDevice extends Omit<StoredMobileDevice, 'pushToken' | 'tokenHash'> {
  pushEnabled: boolean;
}

interface MobileDeviceDocument extends PiariumSettingsDocument {
  devices: StoredMobileDevice[];
  version: number;
}

const sanitizeDevice = (entry: unknown): StoredMobileDevice | null => {
  if (!entry || typeof entry !== 'object') return null;
  const candidate = entry as Record<string, unknown>;
  const id = normalizeString(candidate.id);
  const tokenHash = normalizeString(candidate.tokenHash);
  if (!id || !tokenHash) return null;

  return {
    id,
    tokenHash,
    name: normalizeString(candidate.name) || 'Mobile device',
    platform: normalizePlatform(candidate.platform),
    appVersion: normalizeString(candidate.appVersion) || null,
    pushProvider: normalizeString(candidate.pushProvider) || null,
    pushToken: normalizeString(candidate.pushToken) || null,
    enabled: candidate.enabled !== false,
    createdAt: typeof candidate.createdAt === 'number' && Number.isFinite(candidate.createdAt) ? candidate.createdAt : Date.now(),
    lastSeenAt: typeof candidate.lastSeenAt === 'number' && Number.isFinite(candidate.lastSeenAt) ? candidate.lastSeenAt : null,
    lastPushSuccessAt: typeof candidate.lastPushSuccessAt === 'number' && Number.isFinite(candidate.lastPushSuccessAt) ? candidate.lastPushSuccessAt : null,
    lastPushFailureAt: typeof candidate.lastPushFailureAt === 'number' && Number.isFinite(candidate.lastPushFailureAt) ? candidate.lastPushFailureAt : null,
  };
};

const publicDevice = (device: StoredMobileDevice): PublicMobileDevice => ({
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

export interface MobileDeviceStoreDependencies {
  crypto: Pick<typeof crypto, 'createHash' | 'randomBytes'>;
  deviceStore?: SettingsFileStore | undefined;
  mobileDevicesFilePath: string;
}

export const createMobileDeviceStore = (deps: MobileDeviceStoreDependencies) => {
  const {
    crypto,
    mobileDevicesFilePath,
  } = deps;

  const emptyStore = (): MobileDeviceDocument => ({ version: MOBILE_DEVICES_VERSION, devices: [] });
  const deviceStore = deps.deviceStore ?? createSettingsFileStore({
    filePath: mobileDevicesFilePath,
    defaultValue: emptyStore(),
  });

  const hashToken = (token: unknown): string => crypto.createHash('sha256').update(String(token)).digest('hex');
  const createDeviceToken = (): string => `${DEVICE_TOKEN_PREFIX}${crypto.randomBytes(32).toString('base64url')}`;
  const createDeviceId = (): string => `mob_${crypto.randomBytes(12).toString('base64url')}`;

  const readStore = async (): Promise<MobileDeviceDocument> => {
    try {
      const parsed = await deviceStore.read();
      if (!parsed || typeof parsed !== 'object' || parsed.version !== MOBILE_DEVICES_VERSION) {
        throw new Error(`Unsupported mobile devices version: ${String(parsed?.version)}`);
      }
      if (!Array.isArray(parsed.devices)) {
        throw new Error('Mobile devices file has invalid devices');
      }
      const devices = parsed.devices.map(sanitizeDevice);
      const validDevices = devices.filter((device): device is StoredMobileDevice => device !== null);
      if (validDevices.length !== devices.length) {
        throw new Error('Mobile devices file contains an invalid device');
      }
      return { version: MOBILE_DEVICES_VERSION, devices: validDevices };
    } catch (error) {
      console.warn('[Mobile] Failed to read devices file:', error instanceof Error ? error.message : error);
      throw error;
    }
  };

  const updateStore = async (
    mutate: (current: MobileDeviceDocument) => MobileDeviceDocument | Promise<MobileDeviceDocument>,
  ): Promise<PiariumSettingsDocument> => {
    return deviceStore.update(async (stored) => {
      if (stored.version !== MOBILE_DEVICES_VERSION || !Array.isArray(stored.devices)) {
        throw new Error(`Unsupported mobile devices version: ${String(stored.version)}`);
      }
      const devices = stored.devices.map(sanitizeDevice);
      const validDevices = devices.filter((device): device is StoredMobileDevice => device !== null);
      if (validDevices.length !== devices.length) {
        throw new Error('Mobile devices file contains an invalid device');
      }
      return mutate({
        version: MOBILE_DEVICES_VERSION,
        devices: validDevices,
      });
    });
  };

  const listDevices = async (): Promise<PublicMobileDevice[]> => {
    const store = await readStore();
    return store.devices.map(publicDevice);
  };

  const createDevice = async ({
    name,
    platform,
    appVersion,
  }: { name?: unknown; platform?: unknown; appVersion?: unknown } = {}) => {
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

  const authenticateDevice = async (deviceId: unknown, deviceToken: unknown): Promise<PublicMobileDevice | null> => {
    const id = normalizeString(deviceId);
    const token = normalizeString(deviceToken);
    if (!id || !token) return null;
    const tokenHash = hashToken(token);
    const store = await readStore();
    const device = store.devices.find((entry) => entry.id === id && entry.tokenHash === tokenHash && entry.enabled !== false);
    return device ? publicDevice(device) : null;
  };

  const touchDevice = async (deviceId: unknown): Promise<PublicMobileDevice | null> => {
    const id = normalizeString(deviceId);
    if (!id) return null;
    let touched: StoredMobileDevice | null = null;
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

  const registerPushToken = async (
    deviceId: unknown,
    { pushToken, pushProvider = 'expo', appVersion }: {
      pushToken?: unknown;
      pushProvider?: unknown;
      appVersion?: unknown;
    } = {},
  ): Promise<PublicMobileDevice | null> => {
    const id = normalizeString(deviceId);
    const token = normalizeString(pushToken);
    if (!id || !token) return null;
    let updated: StoredMobileDevice | null = null;
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

  const deleteDevice = async (deviceId: unknown): Promise<boolean> => {
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

  const listPushTargets = async (): Promise<Array<{ id: string; pushProvider: string; pushToken: string }>> => {
    const store = await readStore();
    return store.devices
      .filter((device): device is StoredMobileDevice & { pushProvider: 'expo'; pushToken: string } => (
        device.enabled !== false && device.pushProvider === 'expo' && Boolean(device.pushToken)
      ))
      .map((device) => ({
        id: device.id,
        pushProvider: device.pushProvider,
        pushToken: device.pushToken,
      }));
  };

  const markPushResult = async (deviceId: unknown, success: boolean): Promise<void> => {
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

  const disablePushToken = async (pushToken: unknown): Promise<void> => {
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

export type MobileDeviceStore = ReturnType<typeof createMobileDeviceStore>;
