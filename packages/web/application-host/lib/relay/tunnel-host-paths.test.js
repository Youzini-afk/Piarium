import { describe, expect, test } from 'bun:test';
import { isRelayWebSocketPathAllowed } from './tunnel-host.js';

describe('relay WebSocket path policy', () => {
  test('allows the Pi runtime socket and rejects arbitrary API upgrades', () => {
    expect(isRelayWebSocketPathAllowed('/api/piarium/runtime/ws')).toBe(true);
    expect(isRelayWebSocketPathAllowed('/api/untrusted/ws')).toBe(false);
  });
});
