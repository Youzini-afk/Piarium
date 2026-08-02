import { describe, expect, test } from 'bun:test';
import {
  createRuntimeSuccessResponse,
  decodeRuntimeEnvelope,
  encodeRuntimeEnvelope,
  PIARIUM_PROTOCOL_VERSION,
} from '@piarium/protocol';
import type { RuntimeWebSocket } from '@piarium/runtime-client';
import { createPiRuntimeConnection } from './client';

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
});
