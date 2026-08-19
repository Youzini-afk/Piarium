import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';

describe('Pi main application root', () => {
  test('uses the Pi runtime for both the primary and embedded chat roots', () => {
    const source = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');
    expect(source).not.toContain('SyncProvider');
    expect(source).not.toContain('opencodeClient');
    expect(source).toContain('openPiSessionFromNavigation');
    expect(source).toContain('<PiAppEffects');
    expect(source).toContain('<PiInteractionHost');
  });

  test('boots the Pi catalog without OpenCode health, config, or bounded retry gates', () => {
    const source = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');
    expect(source).not.toContain("runtimeFetch('/health'");
    expect(source).not.toContain('resumeAutoReviewRun');
    expect(source).not.toContain('MAX_RETRIES');
    expect(source).not.toContain('providersCount');
    expect(source).toContain('void state.loadCatalog()');
    expect(source).toContain('resolveDesktopWorkspaceView');
    expect(source).not.toContain('initializeLegacyApp');
    expect(source).not.toContain('legacyIsConnected');
  });
});
