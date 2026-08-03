import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';

describe('Pi recovery onboarding', () => {
  test('retries the Pi runtime connection without an OpenCode config reload', () => {
    const source = readFileSync(new URL('./RecoveryScreen.tsx', import.meta.url), 'utf8');
    expect(source).toContain('disconnectPiRuntime');
    expect(source).toContain('getPiRuntimeConnection');
    expect(source).not.toContain('/api/config/reload');
    expect(source).not.toContain('runtimeFetch');
  });
});
