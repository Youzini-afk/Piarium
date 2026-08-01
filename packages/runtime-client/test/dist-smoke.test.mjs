import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PiRuntimeClient } from '../dist/index.js';

test('compiled runtime client exports a constructible client', () => {
  const transport = { close() {}, send() {}, start() {} };
  const client = new PiRuntimeClient({ transport });
  assert.equal(client.connected, false);
});
