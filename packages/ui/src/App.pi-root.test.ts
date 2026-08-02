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
});
