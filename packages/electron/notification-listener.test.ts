import { afterEach, describe, expect, test } from 'vitest';
import http from 'node:http';

import { NotificationListener } from './notification-listener.js';

const servers = [];
const listeners = [];

const noopLogger = {
  info() {},
  warn() {},
  error() {},
};

const listen = async (server) => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP server address');
  return `http://127.0.0.1:${address.port}`;
};

afterEach(async () => {
  while (listeners.length > 0) {
    const listener = listeners.pop();
    try { listener.stop(); } catch {}
  }
  while (servers.length > 0) {
    const server = servers.pop();
    await new Promise((resolve) => server.close(() => resolve()));
  }
});

describe('NotificationListener', () => {
  test('forwards sanitized custom requestHeaders to /auth/session', async () => {
    let observedAuthHeaders = null;
    const server = http.createServer((req, res) => {
      if (req.url === '/auth/session') {
        observedAuthHeaders = req.headers;
        res.writeHead(204);
        res.end();
        return;
      }
      if (req.url === '/api/notifications/stream') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: \n\n');
        res.end();
        return;
      }
      res.writeHead(404);
      res.end();
    });
    const baseUrl = await listen(server);

    const listener = new NotificationListener({
      serverUrl: baseUrl,
      password: 'shh',
      requestHeaders: {
        'CF-Access-Client-Id': 'client-id',
        'X-Custom-Header': 'value',
        // Reserved — must not be forwarded / must not override listener's own value.
        Authorization: 'Bearer evil',
        Cookie: 'stolen=1',
        'Content-Length': '999',
        'Content-Type': 'text/evil',
        '': 'empty-name',
        'Bad\nName': 'value',
        'Bad-Value': 'line\nbreak',
      },
      onNotification: () => {},
      logger: noopLogger,
    });
    listeners.push(listener);

    await listener.start();
    // Give the SSE stream a tick to open.
    await new Promise((resolve) => setTimeout(resolve, 30));
    listener.stop();

    expect(observedAuthHeaders).not.toBeNull();
    expect(observedAuthHeaders['cf-access-client-id']).toBe('client-id');
    expect(observedAuthHeaders['x-custom-header']).toBe('value');
    // Reserved headers dropped from custom set; listener's own values win.
    expect(observedAuthHeaders['content-type']).toBe('application/json');
    expect(observedAuthHeaders['authorization']).toBeUndefined();
    expect(observedAuthHeaders['cookie']).toBeUndefined();
  });

  test('forwards sanitized custom requestHeaders to /api/notifications/stream and preserves auth', async () => {
    let observedStreamHeaders = null;
    const server = http.createServer((req, res) => {
      if (req.url === '/auth/session') {
        res.writeHead(401);
        res.end();
        return;
      }
      if (req.url === '/api/notifications/stream') {
        observedStreamHeaders = req.headers;
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: \n\n');
        res.end();
        return;
      }
      res.writeHead(404);
      res.end();
    });
    const baseUrl = await listen(server);

    const listener = new NotificationListener({
      serverUrl: baseUrl,
      password: '',
      clientToken: 'token-abc',
      requestHeaders: {
        'X-Forwarded-Host': 'example.com',
        // Reserved — must not override listener's own Authorization/Accept/Cache-Control.
        Authorization: 'Bearer evil',
        Accept: 'text/evil',
        'Cache-Control': 'must-revalidate',
      },
      onNotification: () => {},
      logger: noopLogger,
    });
    listeners.push(listener);

    await listener.start();
    await new Promise((resolve) => setTimeout(resolve, 30));
    listener.stop();

    expect(observedStreamHeaders).not.toBeNull();
    expect(observedStreamHeaders['x-forwarded-host']).toBe('example.com');
    expect(observedStreamHeaders['authorization']).toBe('Bearer token-abc');
    expect(observedStreamHeaders['accept']).toBe('text/event-stream');
    expect(observedStreamHeaders['cache-control']).toBe('no-cache');
  });

  test('updateAuth replaces requestHeaders and re-sanitizes reserved names', async () => {
    let observedStreamHeaders = null;
    const server = http.createServer((req, res) => {
      if (req.url === '/api/notifications/stream') {
        observedStreamHeaders = req.headers;
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: \n\n');
        res.end();
        return;
      }
      res.writeHead(404);
      res.end();
    });
    const baseUrl = await listen(server);

    const listener = new NotificationListener({
      serverUrl: baseUrl,
      clientToken: 'tok',
      requestHeaders: { 'X-Old': 'old' },
      onNotification: () => {},
      logger: noopLogger,
    });
    listeners.push(listener);

    listener.updateAuth({
      clientToken: 'tok',
      requestHeaders: { 'X-New': 'new', Authorization: 'Bearer evil', Cookie: 'c=1' },
    });

    await listener.start();
    await new Promise((resolve) => setTimeout(resolve, 30));
    listener.stop();

    expect(observedStreamHeaders).not.toBeNull();
    expect(observedStreamHeaders['x-new']).toBe('new');
    expect(observedStreamHeaders['x-old']).toBeUndefined();
    expect(observedStreamHeaders['authorization']).toBe('Bearer tok');
    expect(observedStreamHeaders['cookie']).toBeUndefined();
  });
});
