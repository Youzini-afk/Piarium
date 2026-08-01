import {
  createRuntimeErrorResponse,
  createRuntimeEvent,
  createRuntimeSuccessResponse,
  decodeRuntimeEnvelope,
  encodeRuntimeEnvelope,
  ProtocolDecodeError,
} from '@piarium/protocol';
import {
  dispatchRuntimeRequest,
  PiHostRequestError,
  RuntimeDispatchError,
} from '@piarium/runtime-broker';
import { WebSocketServer } from 'ws';

export const PI_RUNTIME_WS_PATH = '/api/piarium/runtime/ws';

const MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;
const MAX_PENDING_REQUESTS = 64;
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;
const HEARTBEAT_INTERVAL_MS = 30_000;
const WS_OPEN = 1;

const parsePathname = (url) => {
  try {
    return new URL(url, 'http://127.0.0.1').pathname;
  } catch {
    return typeof url === 'string' ? url.split('?')[0] : '';
  }
};

const errorResponse = (id, error) => {
  if (error instanceof RuntimeDispatchError || error instanceof PiHostRequestError) {
    return createRuntimeErrorResponse(id, {
      code: error.code,
      ...(error.details === undefined ? {} : { details: error.details }),
      message: error.message,
      ...(error.retryable === undefined ? {} : { retryable: error.retryable === true }),
    });
  }
  if (error instanceof ProtocolDecodeError) {
    return createRuntimeErrorResponse(id, {
      code: error.code,
      message: error.message,
      retryable: false,
    });
  }
  return createRuntimeErrorResponse(id, {
    code: 'runtime_request_failed',
    message: 'Pi runtime request failed',
    retryable: false,
  });
};

const readFrameId = (frame) => {
  try {
    const value = JSON.parse(frame);
    return value && typeof value === 'object' && typeof value.id === 'string' && value.id
      ? value.id
      : null;
  } catch {
    return null;
  }
};

const sendEnvelope = (socket, envelope) => {
  if (socket.readyState !== WS_OPEN) return false;
  if (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
    socket.terminate();
    return false;
  }
  try {
    socket.send(encodeRuntimeEnvelope(envelope));
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

  const unsubscribe = broker.subscribe((event) => {
    if (stopped || event.kind !== 'host') return;
    const source = {
      role: event.role,
      workerId: event.workerId,
      ...(event.sessionId ? { sessionId: event.sessionId } : {}),
    };
    const envelope = createRuntimeEvent(
      source,
      event.envelope.seq,
      event.envelope.event,
      event.envelope.data,
    );
    for (const socket of wsServer.clients) {
      if (socket.piariumHandshakeState === 'complete') sendEnvelope(socket, envelope);
    }
  });

  wsServer.on('connection', (socket, req) => {
    const pending = new Set();
    socket.isAlive = true;
    socket.authContext = req.piariumAuthContext || null;
    socket.piariumHandshakeState = 'required';
    socket.on('pong', () => {
      socket.isAlive = true;
    });
    socket.on('message', (raw, isBinary) => {
      if (isBinary) {
        socket.close(1003, 'text frames required');
        return;
      }
      const frame = raw.toString('utf8');
      let envelope;
      try {
        envelope = decodeRuntimeEnvelope(frame);
      } catch (error) {
        const id = readFrameId(frame);
        if (id) sendEnvelope(socket, errorResponse(id, error));
        else socket.close(1008, 'invalid runtime frame');
        return;
      }
      if (envelope.kind !== 'request') {
        socket.close(1008, 'client requests only');
        return;
      }
      if (envelope.method === 'host.handshake') {
        if (socket.piariumHandshakeState !== 'required') {
          sendEnvelope(socket, createRuntimeErrorResponse(envelope.id, {
            code: 'handshake_already_started',
            message: 'Runtime handshake has already started',
            retryable: false,
          }));
          return;
        }
        socket.piariumHandshakeState = 'pending';
      } else if (socket.piariumHandshakeState !== 'complete') {
        sendEnvelope(socket, createRuntimeErrorResponse(envelope.id, {
          code: 'handshake_required',
          message: 'Runtime handshake is required before other requests',
          retryable: true,
        }));
        return;
      }
      if (pending.has(envelope.id)) {
        sendEnvelope(socket, createRuntimeErrorResponse(envelope.id, {
          code: 'duplicate_request_id',
          message: 'Runtime request ID is already active',
          retryable: false,
        }));
        return;
      }
      if (pending.size >= MAX_PENDING_REQUESTS) {
        sendEnvelope(socket, createRuntimeErrorResponse(envelope.id, {
          code: 'too_many_requests',
          message: 'Too many runtime requests are active',
          retryable: true,
        }));
        return;
      }
      pending.add(envelope.id);
      void dispatchRuntimeRequest(broker, envelope.method, envelope.params).then(
        (result) => {
          if (envelope.method === 'host.handshake') {
            socket.piariumHandshakeState = 'complete';
          }
          return sendEnvelope(socket, createRuntimeSuccessResponse(envelope.id, result));
        },
        (error) => {
          if (envelope.method === 'host.handshake') {
            socket.piariumHandshakeState = 'required';
          }
          return sendEnvelope(socket, errorResponse(envelope.id, error));
        },
      ).finally(() => {
        pending.delete(envelope.id);
      });
    });
    socket.on('close', () => pending.clear());
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
      unsubscribe();
      for (const socket of wsServer.clients) {
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
