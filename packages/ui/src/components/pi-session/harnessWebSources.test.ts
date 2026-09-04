import { describe, expect, test } from 'bun:test';
import type { PiSessionEntry } from '@piarium/protocol';
import { projectHarnessWebSources } from './harnessWebSources';

describe('Harness web source projection', () => {
  test('projects only validated persisted web tool sources', () => {
    const entries = [{
      id: 'result-1', parentId: null, timestamp: '2026-09-05T00:00:00.000Z', type: 'message',
      message: {
        role: 'toolResult', toolCallId: 'call-1', toolName: 'websearch', content: [], isError: false, timestamp: 10,
        details: { sources: [
          { title: 'Docs', url: 'https://docs.example/page' },
          { title: 'Unsafe', url: 'javascript:alert(1)' },
          { title: 'Missing URL' },
        ] },
      },
    }, {
      id: 'result-2', parentId: null, timestamp: '2026-09-05T00:00:01.000Z', type: 'message',
      message: {
        role: 'toolResult', toolCallId: 'call-2', toolName: 'read', content: [], isError: false, timestamp: 11,
        details: { sources: [{ url: 'https://ignored.example' }] },
      },
    }] as PiSessionEntry[];
    expect(projectHarnessWebSources('session-1', entries)).toEqual([{
      sessionId: 'session-1',
      url: 'https://docs.example/page',
      title: 'Docs',
      fetchedAt: 10,
      toolCallId: 'call-1',
      tool: 'websearch',
    }]);
  });
});
