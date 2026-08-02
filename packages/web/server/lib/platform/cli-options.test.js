import { expect, test } from 'bun:test';
import { parseServeCliOptions } from './cli-options.js';

const parse = (argv = [], env = {}) => parseServeCliOptions({
  argv,
  env,
  defaultPort: 3000,
  cloudflareProvider: 'cloudflare',
  managedLocalMode: 'managed-local',
});

test('PIARIUM_PORT supplies the cross-platform development default', () => {
  expect(parse([], { PIARIUM_PORT: '3902' }).port).toBe(3902);
  expect(parse([], { PIARIUM_PORT: 'invalid' }).port).toBe(3000);
});

test('an explicit CLI port takes priority over PIARIUM_PORT', () => {
  expect(parse(['--port', '4100'], { PIARIUM_PORT: '3902' }).port).toBe(4100);
});
