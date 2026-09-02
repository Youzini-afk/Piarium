import {
  PiRuntimeSurfaceConnection,
  type PiRuntimeBroker,
} from '@piarium/runtime-broker';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';

export const PI_RUNTIME_WS_PATH = '/api/piarium/runtime/ws';

const configurableLimit = (name: string): number => {
  const raw = process.env[name];
  if (typeof raw !== 'string' || raw.trim() === '') return 0;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer; 0 disables the limit`);
  }
  return value;
};

const MAX_PAYLOAD_BYTES = configurableLimit('PIARIUM_RUNTIME_MAX_PAYLOAD_BYTES');
const MAX_PENDING_REQUESTS = configurableLimit('PIARIUM_RUNTIME_MAX_PENDING_REQUESTS');
const MAX_BUFFERED_BYTES = configurableLimit('PIARIUM_RUNTIME_MAX_BUFFERED_BYTES');
const HEARTBEAT_INTERVAL_MS = 30_000;
const WS_OPEN = 1;

const parsePathname = (url: unknown): string => {
  if (typeof url !== 'string') return '';
  try {
    return new URL(url, 'http://127.0.0.1').pathname;
  } catch {
    return url.split('?')[0] ?? '';
  }
};

const sendFrame = (socket: WebSocket, frame: string): boolean => {
  if (socket.readyState !== WS_OPEN) return false;
  if (MAX_BUFFERED_BYTES > 0 && socket.bufferedAmount > MAX_BUFFERED_BYTES) {
    socket.terminate();
    return false;
  }
  try {
    socket.send(frame);
    return true;
  } catch {
    try {
      socket.close(1011, 'runtime encoding failed');
    } catch {
      // The peer may already have closed after the send failure.
    }
    return false;
  }
};

interface GatewaySocketState {
  authContext: unknown;
  connection: PiRuntimeSurfaceConnection;
  isAlive: boolean;
}

export interface PiRuntimeGatewayOptions {
  broker?: PiRuntimeBroker | undefined;
  getBroker?: (() => PiRuntimeBroker | null) | undefined;
  isRequestOriginAllowed(request: IncomingMessage): Promise<boolean>;
  rejectWebSocketUpgrade(socket: Duplex, statusCode: number, reason: string): void;
  server: Server;
  uiAuthController: {
    resolveWebSocketAuthContext(request: IncomingMessage): Promise<unknown | null>;
  };
}

export function createPiRuntimeGateway({
  server,
  broker,
  getBroker,
  uiAuthController,
  isRequestOriginAllowed,
  rejectWebSocketUpgrade,
}: PiRuntimeGatewayOptions) {
  const resolveBroker = typeof getBroker === 'function' ? getBroker : () => broker;
  if (!server || (typeof getBroker !== 'function' && !broker)) {
    throw new Error('Pi runtime gateway requires server and broker');
  }
  if (typeof uiAuthController?.resolveWebSocketAuthContext !== 'function') {
    throw new Error('Pi runtime gateway requires WebSocket authentication');
  }
  if (typeof isRequestOriginAllowed !== 'function' || typeof rejectWebSocketUpgrade !== 'function') {
    throw new Error('Pi runtime gateway requires WebSocket request guards');
  }

  const wsServer = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_PAYLOAD_BYTES,
  });
  const socketStates = new WeakMap<WebSocket, GatewaySocketState>();
  const upgradeAuthContexts = new WeakMap<IncomingMessage, unknown>();
  let stopped = false;

  wsServer.on('connection', (socket, req) => {
    const currentBroker = resolveBroker();
    if (!currentBroker) {
      try {
        socket.close(1013, 'Pi runtime is not ready');
      } catch {
        // The peer may have closed during broker resolution.
      }
      return;
    }
    const connection = new PiRuntimeSurfaceConnection({
      broker: currentBroker,
      maxPendingRequests: MAX_PENDING_REQUESTS,
      onClose: (reason) => {
        try {
          socket.close(1008, reason);
        } catch {
          // Connection shutdown is already in progress.
        }
      },
      send: (frame) => sendFrame(socket, frame),
    });
    socketStates.set(socket, {
      authContext: upgradeAuthContexts.get(req) ?? null,
      connection,
      isAlive: true,
    });
    socket.on('pong', () => {
      const state = socketStates.get(socket);
      if (state) state.isAlive = true;
    });
    socket.on('message', (raw: RawData, isBinary: boolean) => {
      if (isBinary) {
        socket.close(1003, 'text frames required');
        return;
      }
      const frame = raw.toString('utf8');
      connection.receive(frame);
    });
    socket.on('close', () => connection.close());
    socket.on('error', () => {
      // close follows and clears connection-local state.
    });
  });

  const heartbeat = setInterval(() => {
    for (const socket of wsServer.clients) {
      const state = socketStates.get(socket);
      if (state?.isAlive === false) {
        socket.terminate();
        continue;
      }
      if (state) state.isAlive = false;
      try {
        socket.ping();
      } catch {
        socket.terminate();
      }
    }
  }, HEARTBEAT_INTERVAL_MS);
  heartbeat.unref?.();

  const upgradeHandler = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    if (parsePathname(req.url) !== PI_RUNTIME_WS_PATH) return;
    void (async () => {
      try {
        const authContext = await uiAuthController?.resolveWebSocketAuthContext?.(req);
        if (!authContext) {
          rejectWebSocketUpgrade(socket, 401, 'UI authentication required');
          return;
        }
        if (!(await isRequestOriginAllowed(req))) {
          rejectWebSocketUpgrade(socket, 403, 'Invalid origin');
          return;
        }
        upgradeAuthContexts.set(req, authContext);
        wsServer.handleUpgrade(req, socket, head, (ws) => {
          wsServer.emit('connection', ws, req);
        });
      } catch {
        rejectWebSocketUpgrade(socket, 500, 'Upgrade failed');
      }
    })();
  };

  server.on('upgrade', upgradeHandler);

  return {
    wsServer,
    async stop() {
      if (stopped) return;
      stopped = true;
      server.off('upgrade', upgradeHandler);
      clearInterval(heartbeat);
      for (const socket of wsServer.clients) {
        socketStates.get(socket)?.connection.close();
        try {
          socket.close(1001, 'server shutting down');
        } catch {
          // Continue closing the remaining sockets.
        }
      }
      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = (): void => {
          if (settled) return;
          settled = true;
          clearTimeout(forceTimer);
          resolve();
        };
        const forceTimer = setTimeout(() => {
          for (const socket of wsServer.clients) {
            try {
              socket.terminate();
            } catch {
              // Termination is best-effort during the forced shutdown window.
            }
          }
          finish();
        }, 250);
        forceTimer.unref?.();
        try {
          wsServer.close(finish);
        } catch {
          finish();
        }
      });
    },
  };
}
