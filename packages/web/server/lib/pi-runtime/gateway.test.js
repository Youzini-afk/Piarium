import { afterEach, describe, expect, it } from 'bun:test';
import http from 'node:http';
import {
  createEvent,
  createRuntimeRequest,
  decodeRuntimeEnvelope,
  encodeRuntimeEnvelope,
} from '@piarium/protocol';
import { WebSocket } from 'ws';
import { createPiRuntimeGateway, PI_RUNTIME_WS_PATH } from './gateway.js';

const active = [];

afterEach(async () => {
  while (active.length > 0) {
    await active.pop()?.();
  }
});

const listen = (server) => new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => resolve(server.address().port));
});

const closeServer = async (server) => {
  server.close();
  server.closeAllConnections?.();
};

const openSocket = (url, origin = 'http://127.0.0.1') => new Promise((resolve, reject) => {
  const socket = new WebSocket(url, { headers: { Origin: origin } });
  socket.once('open', () => resolve(socket));
  socket.once('error', reject);
});

const nextMessage = (socket) => new Promise((resolve, reject) => {
  socket.once('message', (raw) => {
    try {
      resolve(decodeRuntimeEnvelope(raw.toString('utf8')));
    } catch (error) {
      reject(error);
    }
  });
  socket.once('error', reject);
});

const handshake = async (socket, id = 'handshake') => {
  const responsePromise = nextMessage(socket);
  socket.send(encodeRuntimeEnvelope(createRuntimeRequest(id, 'host.handshake', {
    clientName: 'gateway-test',
    clientVersion: '0.1.0',
    mode: 'test',
    protocolVersions: [1],
  })));
  return responsePromise;
};

const createBroker = () => {
  const listeners = new Set();
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    warmup: async () => ({
      capabilities: {
        extensionUi: true,
        models: true,
        packages: true,
        recovery: true,
        sessions: true,
        settings: true,
      },
      hostVersion: '0.1.0',
      protocolVersion: 1,
      runtime: {
        agentDir: 'C:/agent',
        nodePath: 'node',
        nodeVersion: process.version,
        piVersion: '0.83.0',
        source: 'bundled',
      },
    }),
    listSessions: async () => [],
    emit(event) {
      for (const listener of listeners) listener(event);
    },
  };
};

const setup = async ({ auth = true, origin = true } = {}) => {
  const server = http.createServer();
  const broker = createBroker();
  const rejections = [];
  const gateway = createPiRuntimeGateway({
    server,
    broker,
    uiAuthController: {
      resolveWebSocketAuthContext: async () => auth ? { type: 'session', token: 'test' } : null,
    },
    isRequestOriginAllowed: async () => origin,
    rejectWebSocketUpgrade: (socket, status, reason) => {
      rejections.push({ reason, socket, status });
    },
  });
  const port = await listen(server);
  active.push(async () => {
    await gateway.stop();
    await closeServer(server);
  });
  return { broker, rejections, server, url: `ws://127.0.0.1:${port}${PI_RUNTIME_WS_PATH}` };
};

describe('Pi runtime gateway', () => {
  it('authenticates and dispatches native runtime requests', async () => {
    const { url } = await setup();
    const socket = await openSocket(url);
    const response = await handshake(socket, 'handshake-1');
    expect(response).toMatchObject({
      id: 'handshake-1',
      kind: 'response',
      ok: true,
      result: { protocolVersion: 1 },
    });
    socket.close();
  });

  it('broadcasts host events with worker routing metadata', async () => {
    const { broker, url } = await setup();
    const socket = await openSocket(url);
    await handshake(socket);
    const message = nextMessage(socket);
    broker.emit({
      envelope: createEvent(7, 'session.closed', { sessionId: 'session-1' }),
      kind: 'host',
      role: 'session',
      sessionId: 'session-1',
      workerId: 'worker-1',
    });

    expect(await message).toMatchObject({
      event: 'session.closed',
      seq: 7,
      source: {
        role: 'session',
        sessionId: 'session-1',
        workerId: 'worker-1',
      },
    });
    socket.close();
  });

  it('rejects unauthenticated and cross-origin upgrades', async () => {
    for (const [options, expectedStatus] of [
      [{ auth: false }, 401],
      [{ origin: false }, 403],
    ]) {
      const { rejections, server } = await setup(options);
      server.emit('upgrade', {
        headers: { origin: 'http://127.0.0.1' },
        url: PI_RUNTIME_WS_PATH,
      }, {}, Buffer.alloc(0));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(rejections).toEqual([
        expect.objectContaining({ status: expectedStatus }),
      ]);
    }
  });

  it('rejects worker-only methods before dispatch', async () => {
    const { url } = await setup();
    const socket = await openSocket(url);
    const responsePromise = nextMessage(socket);
    socket.send('{"v":1,"kind":"request","id":"shutdown-1","method":"host.shutdown","params":{}}');

    expect(await responsePromise).toMatchObject({
      id: 'shutdown-1',
      ok: false,
      error: { code: 'unsupported_method' },
    });
    socket.close();
  });

  it('requires a successful handshake before runtime operations', async () => {
    const { url } = await setup();
    const socket = await openSocket(url);
    const responsePromise = nextMessage(socket);
    socket.send(encodeRuntimeEnvelope(createRuntimeRequest('list-1', 'session.list', {})));

    expect(await responsePromise).toMatchObject({
      id: 'list-1',
      ok: false,
      error: { code: 'handshake_required' },
    });
    socket.close();
  });
});
