import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';

describe('Pi main application root', () => {
  test('keeps OpenCode SyncProvider isolated to the embedded legacy route', () => {
    const source = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');
    const mainRootMarker = '// The main Pi surface is independent';
    const markerIndex = source.indexOf(mainRootMarker);
    expect(markerIndex).toBeGreaterThan(0);
    expect(source.slice(markerIndex)).not.toContain('<SyncProvider');
    expect(source.slice(0, markerIndex)).toContain('<SyncProvider');
    expect(source.slice(markerIndex)).toContain('<PiAppEffects');
  });

  test('boots the Pi catalog without OpenCode health, config, or bounded retry gates', () => {
    const source = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');
    expect(source).not.toContain("runtimeFetch('/health'");
    expect(source).not.toContain('resumeAutoReviewRun');
    expect(source).not.toContain('MAX_RETRIES');
    expect(source).not.toContain('providersCount');
    expect(source).toContain('if (embeddedSessionChat) return;');
    expect(source).toContain('void state.loadCatalog()');
    expect(source).toContain('if (!embeddedSessionChat || isVSCodeRuntime)');
    expect(source).toContain('void initializeLegacyApp()');
  });
});
