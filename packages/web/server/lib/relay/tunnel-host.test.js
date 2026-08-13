import { describe, expect, test } from 'bun:test';
import http from 'node:http';

import { createTunnelHost } from './tunnel-host.js';
import {
  decodeTunnelFrame,
  encodeJsonPayload,
  encodeTunnelFrame,
  TunnelFrameType,
} from './tunnel-codec.js';

const startLoopback = () => new Promise((resolve) => {
  const requests = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      requests.push({ body: Buffer.concat(chunks).toString('utf8'), method: request.method });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"ok":true}');
    });
  });
  server.listen(0, '127.0.0.1', () => resolve({
    port: server.address().port,
    requests,
    stop: () => new Promise((done) => server.close(done)),
  }));
});

const waitFor = async (predicate, timeoutMs = 2_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return predicate();
};

const requestHead = (overrides = {}) => encodeTunnelFrame(
  TunnelFrameType.HttpRequest,
  1,
  encodeJsonPayload({
    headers: { 'content-type': 'application/json' },
    method: 'POST',
    path: '/api/submit',
    query: '',
    ...overrides,
  }),
);

const createHarness = async (overrides = {}) => {
  const loopback = await startLoopback();
  const sentFrames = [];
  const host = createTunnelHost({
    connectionId: 'piarium-test',
    getBufferedAmount: () => 0,
    getLocalPort: () => loopback.port,
    sendFrame: async (frame) => sentFrames.push(decodeTunnelFrame(frame)),
    ...overrides,
  });
  return { host, loopback, sentFrames };
};

describe('relay request body integrity', () => {
  test('forwards buffered frames only after the complete body arrives', async () => {
    const { host, loopback } = await createHarness();
    await host.handleFrame(requestHead({ hasBody: true }));
    await host.handleFrame(encodeTunnelFrame(TunnelFrameType.HttpBody, 1, new TextEncoder().encode('alpha')));
    expect(loopback.requests).toHaveLength(0);
    await host.handleFrame(encodeTunnelFrame(TunnelFrameType.HttpBody, 1, new TextEncoder().encode('beta')));
    await host.handleFrame(encodeTunnelFrame(TunnelFrameType.StreamEnd, 1, new Uint8Array(0)));
    expect(await waitFor(() => loopback.requests.length === 1)).toBe(true);
    expect(loopback.requests[0].body).toBe('alphabeta');
    await loopback.stop();
  });

  test('rejects a declared body when all body frames were lost', async () => {
    const { host, loopback, sentFrames } = await createHarness();
    await host.handleFrame(requestHead({ hasBody: true }));
    await host.handleFrame(encodeTunnelFrame(TunnelFrameType.StreamEnd, 1, new Uint8Array(0)));
    expect(await waitFor(() => sentFrames.some((frame) => frame.frameType === TunnelFrameType.StreamAbort))).toBe(true);
    expect(loopback.requests).toHaveLength(0);
    await loopback.stop();
  });

  test('accepts a body represented by an explicit empty frame', async () => {
    const { host, loopback } = await createHarness();
    await host.handleFrame(requestHead({ hasBody: true }));
    await host.handleFrame(encodeTunnelFrame(TunnelFrameType.HttpBody, 1, new Uint8Array(0)));
    await host.handleFrame(encodeTunnelFrame(TunnelFrameType.StreamEnd, 1, new Uint8Array(0)));
    expect(await waitFor(() => loopback.requests.length === 1)).toBe(true);
    expect(loopback.requests[0].body).toBe('');
    await loopback.stop();
  });

  test('releases a stalled buffered body at the delivery deadline', async () => {
    const { host, loopback, sentFrames } = await createHarness({ bodyDeliveryTimeoutMs: 50 });
    await host.handleFrame(requestHead({ hasBody: true }));
    await host.handleFrame(encodeTunnelFrame(TunnelFrameType.HttpBody, 1, new TextEncoder().encode('partial')));
    expect(await waitFor(() => sentFrames.some((frame) => frame.frameType === TunnelFrameType.StreamAbort))).toBe(true);
    expect(loopback.requests).toHaveLength(0);
    await host.handleFrame(encodeTunnelFrame(TunnelFrameType.StreamEnd, 1, new Uint8Array(0)));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(sentFrames.filter((frame) => frame.frameType === TunnelFrameType.StreamAbort)).toHaveLength(1);
    await loopback.stop();
  });
});
