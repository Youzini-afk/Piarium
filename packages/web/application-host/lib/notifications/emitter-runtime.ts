export interface NotificationSseResponse {
  write(value: string | Record<string, unknown>): unknown;
}

type NotificationPayload = Record<string, unknown>;
type NotificationBroadcaster = (payload: NotificationPayload) => void;

export const createGlobalUiEventBroadcaster = ({
  sseClients,
  writeSseEvent,
}: {
  sseClients: Set<NotificationSseResponse>;
  writeSseEvent(response: NotificationSseResponse, payload: NotificationPayload): void;
}): NotificationBroadcaster => {
  return (payload: NotificationPayload): void => {
    for (const res of sseClients) {
      try {
        writeSseEvent(res, payload);
      } catch {
        // A disconnected response is removed by the owning SSE route.
      }
    }
  };
};

export interface NotificationEmitterDependencies {
  desktopNotifyPrefix: string;
  getBroadcastGlobalUiEvent(): NotificationBroadcaster | null;
  getDesktopNotifyEnabled(): boolean;
  getUiNotificationClients(): Set<NotificationSseResponse>;
  onDesktopNotification?: NotificationBroadcaster | undefined;
  process: { stdout: { write(value: string): unknown } };
}

export const createNotificationEmitterRuntime = (dependencies: NotificationEmitterDependencies) => {
  const {
    process,
    getDesktopNotifyEnabled,
    desktopNotifyPrefix,
    getUiNotificationClients,
    getBroadcastGlobalUiEvent,
    // Optional: in-process desktop shells (Electron main) inject a callback so
    // notifications are delivered as a direct function call instead of a stdout
    // stringly-typed IPC.
    onDesktopNotification: initialOnDesktopNotification,
  } = dependencies;

  // Late-bindable: main() in server/index.js may call setOnDesktopNotification
  // after runtime construction so the in-process shell can subscribe without
  // restructuring the module-level wiring.
  let onDesktopNotification = typeof initialOnDesktopNotification === 'function'
    ? initialOnDesktopNotification
    : null;

  const setOnDesktopNotification = (cb: unknown): void => {
    onDesktopNotification = typeof cb === 'function' ? cb as NotificationBroadcaster : null;
  };

  const writeSseEvent = (res: NotificationSseResponse, payload: NotificationPayload): void => {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  const emitDesktopNotification = (payload: unknown): boolean => {
    const desktopNotifyEnabled = getDesktopNotifyEnabled();
    if (!desktopNotifyEnabled) {
      return false;
    }

    if (!payload || typeof payload !== 'object') {
      return false;
    }

    if (onDesktopNotification) {
      try {
        onDesktopNotification(payload as NotificationPayload);
        return true;
      } catch {
        // ignore host-side throw
      }
      return false;
    }

    try {
      // stdout fallback for runtimes that parse the one-line `${prefix}{json}` protocol.
      process.stdout.write(`${desktopNotifyPrefix}${JSON.stringify(payload)}\n`);
      return true;
    } catch {
      // ignore
    }

    return false;
  };

  const broadcastUiNotification = (
    payload: unknown,
    options: { desktopNotificationDelivered?: boolean | undefined } = {},
  ): void => {
    const desktopNotifyEnabled = getDesktopNotifyEnabled();
    if (!payload || typeof payload !== 'object') {
      return;
    }

    const desktopNotificationDelivered = options.desktopNotificationDelivered === true;

    const syntheticPayload = {
      type: 'piarium:notification',
      properties: {
          ...(payload as NotificationPayload),
        // Tell local desktop UI whether a native channel already accepted this
        // notification. If so, the SSE/WS event is informational only and must
        // not create a second OS notification.
        desktopNotificationDelivered,
        // Legacy marker retained for older clients that only know about stdout.
        desktopStdoutActive: desktopNotifyEnabled,
      },
    };

    const broadcastGlobalUiEvent = typeof getBroadcastGlobalUiEvent === 'function'
      ? getBroadcastGlobalUiEvent()
      : null;
    if (broadcastGlobalUiEvent) {
      broadcastGlobalUiEvent(syntheticPayload);
      return;
    }

    const clients = getUiNotificationClients();
    if (clients.size === 0) {
      return;
    }

    for (const res of clients) {
      try {
        writeSseEvent(res, syntheticPayload);
      } catch {
        // ignore
      }
    }
  };

  return {
    writeSseEvent,
    emitDesktopNotification,
    broadcastUiNotification,
    setOnDesktopNotification,
  };
};
