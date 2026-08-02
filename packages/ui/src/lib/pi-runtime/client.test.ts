import { afterEach, describe, expect, test } from 'bun:test';
import {
  createRuntimeSuccessResponse,
  decodeRuntimeEnvelope,
  encodeRuntimeEnvelope,
  PIARIUM_PROTOCOL_VERSION,
} from '@piarium/protocol';
import type {
  RuntimeTransport,
  RuntimeTransportHandlers,
  RuntimeWebSocket,
} from '@piarium/runtime-client';
import {
  configurePiRuntimeSurface,
  createPiRuntimeConnection,
  disconnectPiRuntime,
  getPiRuntimeConnection,
} from './client';

class HandshakeSocket implements RuntimeWebSocket {
  readonly readyState = 1;
  onclose: RuntimeWebSocket['onclose'] = null;
  onerror: RuntimeWebSocket['onerror'] = null;
  onmessage: RuntimeWebSocket['onmessage'] = null;
  onopen: RuntimeWebSocket['onopen'] = null;

  close(): void {}

  send(frame: string): void {
    const request = decodeRuntimeEnvelope(frame);
    if (request.kind !== 'request' || request.method !== 'host.handshake') return;
    queueMicrotask(() => {
      this.onmessage?.({
        data: encodeRuntimeEnvelope(createRuntimeSuccessResponse(request.id, {
          capabilities: {
            agentProviders: true,
            extensionUi: true,
            models: true,
            packages: true,
            providerConfiguration: true,
            recovery: true,
            resources: true,
            sessions: true,
            settings: true,
          },
          hostVersion: '0.1.0',
          protocolVersion: PIARIUM_PROTOCOL_VERSION,
          runtime: {
            agentDir: 'C:/agent',
            nodePath: 'node',
            nodeVersion: '24.0.0',
            piVersion: '0.83.0',
            source: 'bundled',
          },
        })),
      });
    });
  }
}

class HandshakeTransport implements RuntimeTransport {
  handshakeParams: Record<string, unknown> | null = null;
  handlers: RuntimeTransportHandlers | null = null;

  close(): void {}

  send(frame: string): void {
    const request = decodeRuntimeEnvelope(frame);
    if (request.kind !== 'request' || request.method !== 'host.handshake') return;
    this.handshakeParams = request.params as unknown as Record<string, unknown>;
    this.handlers?.message(encodeRuntimeEnvelope(createRuntimeSuccessResponse(request.id, {
      capabilities: {
        agentProviders: true,
        extensionUi: true,
        models: true,
        packages: true,
        providerConfiguration: true,
        recovery: true,
        resources: true,
        sessions: true,
        settings: true,
      },
      hostVersion: '0.1.0',
      protocolVersion: PIARIUM_PROTOCOL_VERSION,
      runtime: {
        agentDir: 'C:/agent',
        nodePath: 'node',
        nodeVersion: '24.0.0',
        piVersion: '0.83.0',
        source: 'bundled',
      },
    })));
  }

  start(handlers: RuntimeTransportHandlers): void {
    this.handlers = handlers;
  }
}

afterEach(async () => {
  configurePiRuntimeSurface(null);
  await disconnectPiRuntime();
});

describe('Pi runtime UI connection', () => {
  test('mints URL auth before opening and handshakes over the shared socket contract', async () => {
    const order: string[] = [];
    const socket = new HandshakeSocket();
    const connectionPromise = createPiRuntimeConnection({
      mode: 'web',
      openSocket: () => {
        order.push('socket');
        queueMicrotask(() => socket.onopen?.());
        return socket;
      },
      refreshAuth: async () => {
        order.push('auth');
        return 'url-token';
      },
      resolveWebSocketUrl: () => 'ws://runtime.test/api/piarium/runtime/ws',
      runtimeKey: 'runtime-test',
    });

    const connection = await connectionPromise;
    expect(order).toEqual(['auth', 'socket']);
    expect(connection.handshake.runtime.piVersion).toBe('0.83.0');
    expect(connection.runtimeKey).toBe('runtime-test');
    await connection.client.close();
  });

  test('uses an editor-owned message transport without URL authentication', async () => {
    const transport = new HandshakeTransport();
    configurePiRuntimeSurface({
      clientName: 'piarium-vscode-webview',
      clientVersion: '1.0.0',
      createTransport: () => transport,
      mode: 'vscode',
      runtimeKey: 'vscode:local',
    });

    const connection = await getPiRuntimeConnection();
    expect(connection.runtimeKey).toBe('vscode:local');
    expect(transport.handshakeParams?.clientName).toBe('piarium-vscode-webview');
    expect(transport.handshakeParams?.clientVersion).toBe('1.0.0');
    expect(transport.handshakeParams?.mode).toBe('vscode');
  });
});
