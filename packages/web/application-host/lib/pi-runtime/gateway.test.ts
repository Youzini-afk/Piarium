import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import { PassThrough } from 'node:stream';
import {
  createEvent,
  createRuntimeRequest,
  decodeRuntimeEnvelope,
  encodeRuntimeEnvelope,
  PIARIUM_PROTOCOL_VERSION,
  type RuntimeWireEnvelope,
} from '@piarium/protocol';
import {
  PiRuntimeBroker,
  type PiRuntimeBrokerEvent,
} from '@piarium/runtime-broker';
import { WebSocket } from 'ws';
import { createPiRuntimeGateway, PI_RUNTIME_WS_PATH } from './gateway.js';

const active: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (active.length > 0) {
    await active.pop()?.();
  }
});

const listen = (server: http.Server): Promise<number> => new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP server address');
    resolve(address.port);
  });
});

const closeServer = async (server: http.Server): Promise<void> => {
  server.close();
  server.closeAllConnections?.();
};

const openSocket = (url: string, origin = 'http://127.0.0.1'): Promise<WebSocket> => new Promise((resolve, reject) => {
  const socket = new WebSocket(url, { headers: { Origin: origin } });
  socket.once('open', () => resolve(socket));
  socket.once('error', reject);
});

const nextMessage = (socket: WebSocket): Promise<RuntimeWireEnvelope> => new Promise((resolve, reject) => {
  socket.once('message', (raw) => {
    try {
      resolve(decodeRuntimeEnvelope(raw.toString('utf8')));
    } catch (error) {
      reject(error);
    }
  });
  socket.once('error', reject);
});

const handshake = async (socket: WebSocket, id = 'handshake'): Promise<RuntimeWireEnvelope> => {
  const responsePromise = nextMessage(socket);
  socket.send(encodeRuntimeEnvelope(createRuntimeRequest(id, 'host.handshake', {
    clientName: 'gateway-test',
    clientVersion: '0.1.0',
    mode: 'test',
    protocolVersions: [PIARIUM_PROTOCOL_VERSION],
  })));
  return responsePromise;
};

interface TestBroker extends PiRuntimeBroker {
  emitTest(event: PiRuntimeBrokerEvent): void;
}

const createBroker = (): TestBroker => {
  const listeners = new Set<(event: PiRuntimeBrokerEvent) => void>();
  const broker = Object.create(PiRuntimeBroker.prototype) as PiRuntimeBroker;
  return Object.assign(broker, {
    subscribe(listener: (event: PiRuntimeBrokerEvent) => void) {
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
      protocolVersion: PIARIUM_PROTOCOL_VERSION,
      runtime: {
        agentDir: 'C:/agent',
        nodePath: 'node',
        nodeVersion: process.version,
        piVersion: '0.83.0',
        source: 'bundled',
      },
    }),
    listSessions: async () => [],
    emitTest(event: PiRuntimeBrokerEvent) {
      for (const listener of listeners) listener(event);
    },
  }) as TestBroker;
};

const setup = async ({ auth = true, origin = true }: {
  auth?: boolean | undefined;
  origin?: boolean | undefined;
} = {}) => {
  const server = http.createServer();
  const broker = createBroker();
  const rejections: Array<{ reason: string; status: number }> = [];
  const gateway = createPiRuntimeGateway({
    server,
    broker,
    uiAuthController: {
      resolveWebSocketAuthContext: async () => auth ? { type: 'session', token: 'test' } : null,
    },
    isRequestOriginAllowed: async () => origin,
    rejectWebSocketUpgrade: (socket, status, reason) => {
      rejections.push({ reason, status });
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
      result: { protocolVersion: PIARIUM_PROTOCOL_VERSION },
    });
    socket.close();
  });

  it('broadcasts host events with worker routing metadata', async () => {
    const { broker, url } = await setup();
    const socket = await openSocket(url);
    await handshake(socket);
    const message = nextMessage(socket);
    broker.emitTest({
      envelope: createEvent(7, 'session.closed', { sessionId: 'session-1' }),
      kind: 'host',
      role: 'session',
      runtimeGeneration: 1,
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
    ] as const) {
      const { rejections, server } = await setup(options);
      server.emit('upgrade', {
        headers: { origin: 'http://127.0.0.1' },
        url: PI_RUNTIME_WS_PATH,
      }, new PassThrough(), Buffer.alloc(0));
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(rejections).toEqual([
        expect.objectContaining({ status: expectedStatus }),
      ]);
    }
  });

  it('rejects worker-only methods before dispatch', async () => {
    const { url } = await setup();
    const socket = await openSocket(url);
    const responsePromise = nextMessage(socket);
    socket.send(JSON.stringify({
      id: 'shutdown-1',
      kind: 'request',
      method: 'host.shutdown',
      params: {},
      v: PIARIUM_PROTOCOL_VERSION,
    }));

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

  it('does not impose a product payload ceiling by default', async () => {
    const { url } = await setup();
    const socket = await openSocket(url);
    await handshake(socket);
    const responsePromise = nextMessage(socket);
    socket.send(JSON.stringify({
      id: 'large-list',
      kind: 'request',
      method: 'session.list',
      params: { deploymentOwnedPayload: 'x'.repeat(6 * 1024 * 1024) },
      v: PIARIUM_PROTOCOL_VERSION,
    }));

    expect(await responsePromise).toMatchObject({ id: 'large-list', ok: true, result: [] });
    socket.close();
  });
});
