const EXPO_PUSH_ENDPOINT = 'https://exp.host/--/api/v2/push/send';

import type { MobileDeviceStore } from './device-store.js';

const normalizeString = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

const chunkArray = <T>(items: T[], size: number): T[][] => {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
};

interface ExpoMessage {
  body: string;
  data: Record<string, unknown>;
  deviceId: string;
  sound: string;
  title: string;
  to: string;
}

interface ExpoReceipt {
  details?: { error?: unknown } | undefined;
  status?: unknown;
}

export interface MobilePushDependencies {
  deviceStore: MobileDeviceStore;
  expoAccessToken?: string | undefined;
  expoPushEndpoint?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
}

export const createMobilePushRuntime = (deps: MobilePushDependencies) => {
  const {
    fetchImpl = fetch,
    deviceStore,
    expoPushEndpoint = EXPO_PUSH_ENDPOINT,
    expoAccessToken = process.env.EXPO_ACCESS_TOKEN || process.env.PIARIUM_EXPO_ACCESS_TOKEN || '',
  } = deps;

  const sendExpoMessages = async (messages: ExpoMessage[]): Promise<{ failed: number; sent: number }> => {
    if (messages.length === 0) {
      return { sent: 0, failed: 0 };
    }

    let sent = 0;
    let failed = 0;
    const chunks = chunkArray(messages, 100);
    for (const chunk of chunks) {
      try {
        const headers: Record<string, string> = {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        };
        if (normalizeString(expoAccessToken)) {
          headers.Authorization = `Bearer ${normalizeString(expoAccessToken)}`;
        }
        const response = await fetchImpl(expoPushEndpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify(chunk.length === 1 ? chunk[0] : chunk),
        });
        const body = await response.json().catch(() => null) as unknown;
        if (!response.ok) {
          failed += chunk.length;
          console.warn('[MobilePush] Expo push request failed:', response.status, body || response.statusText);
          continue;
        }

        const bodyRecord = body && typeof body === 'object' && !Array.isArray(body)
          ? body as Record<string, unknown>
          : {};
        const receipts: unknown[] = Array.isArray(bodyRecord.data)
          ? bodyRecord.data
          : [bodyRecord.data].filter(Boolean);
        for (let index = 0; index < chunk.length; index += 1) {
          const message = chunk[index];
          const receipt = receipts[index] && typeof receipts[index] === 'object' && !Array.isArray(receipts[index])
            ? receipts[index] as ExpoReceipt
            : null;
          if (receipt?.status === 'error') {
            failed += 1;
            const detailsError = receipt.details?.error;
            if (detailsError === 'DeviceNotRegistered') {
              await deviceStore.disablePushToken(message!.to);
            }
            await deviceStore.markPushResult(message!.deviceId, false);
            continue;
          }
          sent += 1;
          await deviceStore.markPushResult(message!.deviceId, true);
        }
      } catch (error) {
        failed += chunk.length;
        console.warn('[MobilePush] Failed to send Expo push:', error instanceof Error ? error.message : error);
      }
    }
    return { sent, failed };
  };

  const sendMobilePushToAllDevices = async (payload: unknown) => {
    const payloadRecord = payload && typeof payload === 'object' && !Array.isArray(payload)
      ? payload as Record<string, unknown>
      : {};
    const targets = await deviceStore.listPushTargets();
    const messages = targets.map((target) => ({
      deviceId: target.id,
      to: target.pushToken,
      sound: 'default',
      title: normalizeString(payloadRecord.title) || 'Piarium',
      body: normalizeString(payloadRecord.body) || 'Piarium has an update.',
      data: payloadRecord.data && typeof payloadRecord.data === 'object' && !Array.isArray(payloadRecord.data)
        ? payloadRecord.data as Record<string, unknown>
        : {},
    }));
    return sendExpoMessages(messages);
  };

  const sendTestPush = async (deviceId: string) => {
    const targets = await deviceStore.listPushTargets();
    const target = targets.find((entry) => entry.id === deviceId);
    if (!target) {
      return { ok: false, reason: 'push-token-missing' };
    }
    const result = await sendExpoMessages([{
      deviceId: target.id,
      to: target.pushToken,
      sound: 'default',
      title: 'Piarium test notification',
      body: 'Mobile push is connected.',
      data: { type: 'test', url: '/' },
    }]);
    return { ok: result.sent > 0, ...result };
  };

  return {
    sendMobilePushToAllDevices,
    sendTestPush,
  };
};

export type MobilePushRuntime = ReturnType<typeof createMobilePushRuntime>;
