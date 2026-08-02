import { expect, test } from 'bun:test';
import { parseServeCliOptions } from './cli-options.js';

const parse = (argv = [], env = {}) => parseServeCliOptions({
  argv,
  env,
  defaultPort: 3000,
  cloudflareProvider: 'cloudflare',
  managedLocalMode: 'managed-local',
});

test('OPENCHAMBER_PORT supplies the cross-platform development default', () => {
  expect(parse([], { OPENCHAMBER_PORT: '3902' }).port).toBe(3902);
  expect(parse([], { OPENCHAMBER_PORT: 'invalid' }).port).toBe(3000);
});

test('an explicit CLI port takes priority over OPENCHAMBER_PORT', () => {
  expect(parse(['--port', '4100'], { OPENCHAMBER_PORT: '3902' }).port).toBe(4100);
});
