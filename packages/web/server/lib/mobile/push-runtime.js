const EXPO_PUSH_ENDPOINT = 'https://exp.host/--/api/v2/push/send';

const normalizeString = (value) => (typeof value === 'string' ? value.trim() : '');

const chunkArray = (items, size) => {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
};

export const createMobilePushRuntime = (deps) => {
  const {
    fetchImpl = fetch,
    deviceStore,
    expoPushEndpoint = EXPO_PUSH_ENDPOINT,
    expoAccessToken = process.env.EXPO_ACCESS_TOKEN || process.env.OPENCHAMBER_EXPO_ACCESS_TOKEN || '',
  } = deps;

  const sendExpoMessages = async (messages) => {
    if (messages.length === 0) {
      return { sent: 0, failed: 0 };
    }

    let sent = 0;
    let failed = 0;
    const chunks = chunkArray(messages, 100);
    for (const chunk of chunks) {
      try {
        const headers = {
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
        const body = await response.json().catch(() => null);
        if (!response.ok) {
          failed += chunk.length;
          console.warn('[MobilePush] Expo push request failed:', response.status, body || response.statusText);
          continue;
        }

        const receipts = Array.isArray(body?.data) ? body.data : [body?.data].filter(Boolean);
        for (let index = 0; index < chunk.length; index += 1) {
          const message = chunk[index];
          const receipt = receipts[index];
          if (receipt?.status === 'error') {
            failed += 1;
            const detailsError = receipt?.details?.error;
            if (detailsError === 'DeviceNotRegistered') {
              await deviceStore.disablePushToken(message.to);
            }
            await deviceStore.markPushResult(message.deviceId, false);
            continue;
          }
          sent += 1;
          await deviceStore.markPushResult(message.deviceId, true);
        }
      } catch (error) {
        failed += chunk.length;
        console.warn('[MobilePush] Failed to send Expo push:', error?.message || error);
      }
    }
    return { sent, failed };
  };

  const sendMobilePushToAllDevices = async (payload) => {
    const targets = await deviceStore.listPushTargets();
    const messages = targets.map((target) => ({
      deviceId: target.id,
      to: target.pushToken,
      sound: 'default',
      title: normalizeString(payload?.title) || 'OpenChamber',
      body: normalizeString(payload?.body) || 'OpenChamber has an update.',
      data: payload?.data && typeof payload.data === 'object' ? payload.data : {},
    }));
    return sendExpoMessages(messages);
  };

  const sendTestPush = async (deviceId) => {
    const targets = await deviceStore.listPushTargets();
    const target = targets.find((entry) => entry.id === deviceId);
    if (!target) {
      return { ok: false, reason: 'push-token-missing' };
    }
    const result = await sendExpoMessages([{
      deviceId: target.id,
      to: target.pushToken,
      sound: 'default',
      title: 'OpenChamber test notification',
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
