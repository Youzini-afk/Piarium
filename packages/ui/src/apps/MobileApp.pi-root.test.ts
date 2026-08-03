import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';

const read = (relativePath: string): string => (
  readFileSync(new URL(relativePath, import.meta.url), 'utf8')
);

describe('Pi mobile application root', () => {
  test('mounts Pi chat without the OpenCode sync runtime', () => {
    const source = read('./MobileApp.tsx');
    expect(source).not.toContain('SyncProvider');
    expect(source).not.toContain('opencodeClient');
    expect(source).not.toContain('useSessionUIStore');
    expect(source).not.toContain('piarium:system-resume');
    expect(source).toContain('<PiAppEffects');
    expect(source).toContain('<PiInteractionHost');
    expect(source).toContain('<MobileShell');
  });

  test('keeps mobile session navigation on the Pi store', () => {
    const sources = [
      './MobileSessionsSheet.tsx',
      './MobileDeleteWorktreeDialog.tsx',
      './useEdgeSwipeSessionSwitch.ts',
      './deepLinkNavigation.ts',
      './mobileWidgetSnapshot.ts',
      '../components/session/NewWorktreeDialog.tsx',
    ].map(read).join('\n');
    expect(sources).not.toContain('@opencode-ai/sdk');
    expect(sources).not.toContain('@/sync/');
    expect(sources).not.toContain('useSessionUIStore');
    expect(sources).toContain('usePiSessionStore');
    expect(sources).toContain('openPiSessionFromNavigation');
    expect(sources).toContain('createPiSessionFromNavigation');
  });
});
