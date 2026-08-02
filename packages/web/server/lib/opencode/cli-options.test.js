import assert from 'node:assert/strict';
import test from 'node:test';
import { parseServeCliOptions } from './cli-options.js';

const parse = (argv = [], env = {}) => parseServeCliOptions({
  argv,
  env,
  defaultPort: 3000,
  cloudflareProvider: 'cloudflare',
  managedLocalMode: 'managed-local',
});

test('OPENCHAMBER_PORT supplies the cross-platform development default', () => {
  assert.equal(parse([], { OPENCHAMBER_PORT: '3902' }).port, 3902);
  assert.equal(parse([], { OPENCHAMBER_PORT: 'invalid' }).port, 3000);
});

test('an explicit CLI port takes priority over OPENCHAMBER_PORT', () => {
  assert.equal(parse(['--port', '4100'], { OPENCHAMBER_PORT: '3902' }).port, 4100);
});
