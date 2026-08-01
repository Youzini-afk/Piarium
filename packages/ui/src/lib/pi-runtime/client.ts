import {
  PiRuntimeClient,
  WebSocketRuntimeTransport,
  type RuntimeWebSocket,
} from '@piarium/runtime-client';
import {
  PIARIUM_PROTOCOL_VERSION,
  type HostHandshakeResult,
  type HostMode,
} from '@piarium/protocol';
import { openRuntimeWebSocket } from '@/lib/relay/runtime-socket';
import { refreshRuntimeUrlAuthToken } from '@/lib/runtime-auth';
import {
  getRuntimeApiBaseUrl,
  getRuntimeKey,
  subscribeRuntimeEndpointWillChange,
} from '@/lib/runtime-switch';
import { getRuntimeUrlResolver } from '@/lib/runtime-url';

export interface PiRuntimeConnection {
  client: PiRuntimeClient;
  handshake: HostHandshakeResult;
  runtimeKey: string;
}

export interface CreatePiRuntimeConnectionOptions {
  clientName?: string;
  clientVersion?: string;
  mode?: HostMode;
  onProtocolError?(error: Error): void;
  onSequenceGap?: ConstructorParameters<typeof PiRuntimeClient>[0]['onSequenceGap'];
  openSocket?: (url: string, protocols?: string[]) => RuntimeWebSocket;
  refreshAuth?: (apiBaseUrl?: string | null) => Promise<string>;
  resolveWebSocketUrl?: () => string;
  runtimeKey?: string;
}

const defaultMode = (): HostMode => {
  if (typeof window === 'undefined') return 'web';
  const capacitor = (window as typeof window & {
    Capacitor?: { isNativePlatform?: () => boolean };
  }).Capacitor;
  return capacitor?.isNativePlatform?.() === true ? 'mobile' : 'web';
};

export const createPiRuntimeConnection = async (
  options: CreatePiRuntimeConnectionOptions = {},
): Promise<PiRuntimeConnection> => {
  const refreshAuth = options.refreshAuth ?? refreshRuntimeUrlAuthToken;
  await refreshAuth(getRuntimeApiBaseUrl() || undefined);
  const url = options.resolveWebSocketUrl?.()
    ?? getRuntimeUrlResolver().websocket('/api/piarium/runtime/ws');
  const transport = new WebSocketRuntimeTransport({
    url,
    webSocketFactory: options.openSocket ?? ((socketUrl, protocols) =>
      openRuntimeWebSocket(socketUrl, protocols) as unknown as RuntimeWebSocket),
  });
  const client = new PiRuntimeClient({
    ...(options.onProtocolError ? { onProtocolError: options.onProtocolError } : {}),
    ...(options.onSequenceGap ? { onSequenceGap: options.onSequenceGap } : {}),
    transport,
  });
  try {
    await client.connect();
    const handshake = await client.handshake({
      clientName: options.clientName ?? 'piarium-ui',
      clientVersion: options.clientVersion ?? '0.1.0',
      mode: options.mode ?? defaultMode(),
      protocolVersions: [PIARIUM_PROTOCOL_VERSION],
    });
    return {
      client,
      handshake,
      runtimeKey: options.runtimeKey ?? getRuntimeKey(),
    };
  } catch (error) {
    await client.close();
    throw error;
  }
};

let activeConnection: PiRuntimeConnection | null = null;
let activeConnectionPromise: Promise<PiRuntimeConnection> | null = null;
let connectionGeneration = 0;

export const getPiRuntimeConnection = (): Promise<PiRuntimeConnection> => {
  const runtimeKey = getRuntimeKey();
  if (activeConnection?.runtimeKey === runtimeKey && activeConnection.client.connected) {
    return Promise.resolve(activeConnection);
  }
  if (activeConnectionPromise) return activeConnectionPromise;
  const generation = connectionGeneration;
  const promise = createPiRuntimeConnection({ runtimeKey }).then(async (connection) => {
    if (generation !== connectionGeneration || connection.runtimeKey !== getRuntimeKey()) {
      await connection.client.close();
      throw new Error('Pi runtime changed while connecting');
    }
    activeConnection = connection;
    return connection;
  }).finally(() => {
    if (activeConnectionPromise === promise) activeConnectionPromise = null;
  });
  activeConnectionPromise = promise;
  return promise;
};

export const disconnectPiRuntime = async (): Promise<void> => {
  connectionGeneration += 1;
  const connection = activeConnection;
  activeConnection = null;
  activeConnectionPromise = null;
  if (connection) await connection.client.close();
};

subscribeRuntimeEndpointWillChange(() => {
  void disconnectPiRuntime();
});
