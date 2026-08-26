import { describe, expect, test } from 'vitest';
import { shouldPresentPiExtensionNotice } from './extensionNoticePresentation';

const notice = (message: string, type: 'info' | 'warning' | 'error' = 'info') => ({
  id: 'notice-1',
  message,
  sessionId: 'session-1',
  type,
});

describe('Pi extension notice presentation', () => {
  test('absorbs only the workspace-history preflight notice', () => {
    expect(shouldPresentPiExtensionNotice(notice(
      'Initializing workspace history for this project. The first prompt may take a moment.',
    ))).toBe(false);
    expect(shouldPresentPiExtensionNotice(notice(
      'Workspace history is finishing its initial snapshot. Your prompt will continue shortly.',
    ))).toBe(true);
    expect(shouldPresentPiExtensionNotice(notice(
      'Initializing workspace history for this project. The first prompt may take a moment.',
      'warning',
    ))).toBe(true);
    expect(shouldPresentPiExtensionNotice(notice('Another extension is ready.'))).toBe(true);
  });
});
