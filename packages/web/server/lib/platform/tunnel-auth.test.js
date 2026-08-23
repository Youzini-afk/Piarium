import { describe, expect, it } from 'vitest';
import { createTunnelAuth } from './tunnel-auth.js';

describe('tunnel bootstrap rate limiting', () => {
  it('uses the socket peer instead of attacker-controlled forwarded addresses', () => {
    const auth = createTunnelAuth();
    const response = { setHeader() {} };

    for (let index = 0; index < 20; index += 1) {
      const result = auth.exchangeBootstrapToken({
        req: {
          connection: { remoteAddress: '203.0.113.20' },
          headers: { 'x-forwarded-for': `198.51.100.${index}` },
          socket: { remoteAddress: '203.0.113.20' },
        },
        res: response,
        token: 'invalid',
        sessionTtlMs: 60_000,
      });
      expect(result.reason).toBe('inactive');
    }

    expect(auth.exchangeBootstrapToken({
      req: {
        connection: { remoteAddress: '203.0.113.20' },
        headers: { 'x-forwarded-for': '192.0.2.200' },
        socket: { remoteAddress: '203.0.113.20' },
      },
      res: response,
      token: 'invalid',
      sessionTtlMs: 60_000,
    })).toMatchObject({ ok: false, reason: 'rate-limited' });
  });
});
