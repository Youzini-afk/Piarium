import { expect, test } from 'vitest';
import { parseServeCliOptions } from './cli-options.js';

const parse = (argv: string[] = [], env: NodeJS.ProcessEnv = {}) => parseServeCliOptions({
  argv,
  env,
  defaultPort: 3000,
  cloudflareProvider: 'cloudflare',
  managedLocalMode: 'managed-local',
});

test('VARIN_PORT supplies the cross-platform development default', () => {
  expect(parse([], { VARIN_PORT: '3902' }).port).toBe(3902);
  expect(parse([], { VARIN_PORT: 'invalid' }).port).toBe(3000);
});

test('an explicit CLI port takes priority over VARIN_PORT', () => {
  expect(parse(['--port', '4100'], { VARIN_PORT: '3902' }).port).toBe(4100);
});
