import { describe, expect, test } from 'bun:test';
import type { PiSessionEntry, SessionSnapshot } from '@piarium/protocol';
import { piWorkStatusEntryPreview, piWorkStatusQueueCount } from './piWorkStatus';

const snapshot = (updates: Partial<SessionSnapshot> = {}): SessionSnapshot => ({
  activeTools: [],
  busy: false,
  cwd: 'D:/work',
  features: { pinnedContext: [], revision: 0, schemaVersion: 1 },
  followUp: [],
  followUpMode: 'all',
  isCompacting: false,
  isStreaming: false,
  leafId: null,
  pendingMessageCount: 0,
  retryAttempt: 0,
  sessionId: 'session-a',
  steering: [],
  steeringMode: 'all',
  thinkingLevel: 'medium',
  ...updates,
});

describe('Pi Work Status projection', () => {
  test('counts every Pi-owned queued lane', () => {
    expect(piWorkStatusQueueCount(snapshot({
      followUp: ['two'],
      pendingMessageCount: 2,
      steering: ['one'],
    }))).toBe(4);
  });

  test('projects readable pinned text without exposing image payloads', () => {
    const entry: PiSessionEntry = {
      id: 'entry-a',
      message: {
        content: [{ data: 'base64', mimeType: 'image/png', type: 'image' }, { text: '  Keep   this decision  ', type: 'text' }],
        role: 'user',
        timestamp: 1,
      },
      parentId: null,
      timestamp: '2026-08-13T00:00:00.000Z',
      type: 'message',
    };
    expect(piWorkStatusEntryPreview(entry)).toBe('Keep this decision');
  });
});

