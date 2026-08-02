import { PiRuntimeSurfaceConnection } from '@piarium/runtime-broker';
import { WebSocketServer } from 'ws';

export const PI_RUNTIME_WS_PATH = '/api/piarium/runtime/ws';

const configurableLimit = (name) => {
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

const parsePathname = (url) => {
  try {
    return new URL(url, 'http://127.0.0.1').pathname;
  } catch {
    return typeof url === 'string' ? url.split('?')[0] : '';
  }
};

const sendFrame = (socket, frame) => {
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
    }
    return false;
  }
};

export function createPiRuntimeGateway({
  server,
  broker,
  uiAuthController,
  isRequestOriginAllowed,
  rejectWebSocketUpgrade,
}) {
  if (!server || !broker) throw new Error('Pi runtime gateway requires server and broker');
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
  let stopped = false;

  wsServer.on('connection', (socket, req) => {
    socket.isAlive = true;
    socket.authContext = req.piariumAuthContext || null;
    const connection = new PiRuntimeSurfaceConnection({
      broker,
      maxPendingRequests: MAX_PENDING_REQUESTS,
      onClose: (reason) => {
        try {
          socket.close(1008, reason);
        } catch {
        }
      },
      send: (frame) => sendFrame(socket, frame),
    });
    socket.piariumRuntimeConnection = connection;
    socket.on('pong', () => {
      socket.isAlive = true;
    });
    socket.on('message', (raw, isBinary) => {
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
      if (socket.isAlive === false) {
        socket.terminate();
        continue;
      }
      socket.isAlive = false;
      try {
        socket.ping();
      } catch {
        socket.terminate();
      }
    }
  }, HEARTBEAT_INTERVAL_MS);
  heartbeat.unref?.();

  const upgradeHandler = (req, socket, head) => {
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
        req.piariumAuthContext = authContext;
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
        socket.piariumRuntimeConnection?.close();
        try {
          socket.close(1001, 'server shutting down');
        } catch {
        }
      }
      await new Promise((resolve) => {
        let settled = false;
        const finish = () => {
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
