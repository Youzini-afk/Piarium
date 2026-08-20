import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { parseCompanionUri } from './companion-uri';

describe('parseCompanionUri', () => {
  test('focuses chat for empty and /chat paths', () => {
    assert.deepEqual(parseCompanionUri({ path: '', query: '' }), { action: 'focus' });
    assert.deepEqual(parseCompanionUri({ path: '/', query: '' }), { action: 'focus' });
    assert.deepEqual(parseCompanionUri({ path: '/chat', query: '' }), { action: 'focus' });
    assert.deepEqual(parseCompanionUri({ path: 'chat', query: '' }), { action: 'focus' });
    assert.deepEqual(parseCompanionUri({ path: '/chat/', query: '' }), { action: 'focus' });
  });

  test('opens a session when the query includes a non-empty session id', () => {
    assert.deepEqual(parseCompanionUri({ path: '/chat', query: 'session=abc-123' }), {
      action: 'session',
      sessionId: 'abc-123',
    });
    assert.deepEqual(parseCompanionUri({ path: '/chat', query: 'session=%20' }), { action: 'focus' });
  });

  test('rejects unknown paths without opening a second workbench', () => {
    assert.deepEqual(parseCompanionUri({ path: '/settings', query: 'session=abc' }), {
      action: 'unknown',
      path: '/settings',
    });
    assert.deepEqual(parseCompanionUri({ path: '/agent-manager', query: '' }), {
      action: 'unknown',
      path: '/agent-manager',
    });
  });
});
