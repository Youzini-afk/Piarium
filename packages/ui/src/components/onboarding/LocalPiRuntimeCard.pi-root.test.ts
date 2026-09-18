import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';

describe('Local Pi runtime onboarding', () => {
  test('routes runtime management through RuntimeAPIs instead of starting a worker from the UI', () => {
    const source = readFileSync(new URL('./LocalPiRuntimeCard.tsx', import.meta.url), 'utf8');
    expect(source).toContain('useRuntimeAPIs');
    expect(source).toContain('piRuntime');
    expect(source).toContain('data-pi-local-runtime-continue="true"');
    expect(source).toContain('onboarding.localSetup.actions.useThisPi');
    expect(source).toContain('onboarding.localSetup.actions.installPi');
    expect(source).toContain('onboarding.localSetup.actions.upgradePi');
    expect(source).not.toContain('getPiRuntimeConnection');
    expect(source).not.toContain('ensurePiRuntime');
  });

  test('separates a broken Piarium Host installation from Pi runtime actions', () => {
    const source = readFileSync(new URL('./LocalPiRuntimeCard.tsx', import.meta.url), 'utf8');
    expect(source).toContain('PI_RUNTIME_ISSUE_HOST_ENTRY_UNAVAILABLE');
    expect(source).toContain('onboarding.localSetup.status.hostEntryUnavailable');
    expect(source).toContain('onboarding.localSetup.actions.downloadPiariumAgain');
    expect(source).toContain('https://github.com/Youzini-afk/Piarium/releases/latest');
  });
});
