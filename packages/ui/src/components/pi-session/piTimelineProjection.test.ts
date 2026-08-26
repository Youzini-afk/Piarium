import { describe, expect, test } from 'bun:test';
import type { PiAssistantMessage, PiSessionEntry } from '@piarium/protocol';
import { projectPiTimeline } from './piTimelineProjection';

const assistant = (text: string, timestamp = 1): PiAssistantMessage => ({
  api: 'messages',
  content: [{ text, type: 'text' }],
  model: 'model',
  provider: 'provider',
  role: 'assistant',
  stopReason: 'stop',
  timestamp,
  usage: {
    cacheRead: 0,
    cacheWrite: 0,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
    input: 0,
    output: 0,
    totalTokens: 0,
  },
});

const entry = (value: PiSessionEntry): PiSessionEntry => value;

describe('Pi timeline projection', () => {
  test('keeps runtime configuration history out of the conversation', () => {
    const entries: PiSessionEntry[] = [
      entry({ id: 'model', modelId: 'gpt', parentId: null, provider: 'openai', timestamp: '1', type: 'model_change' }),
      entry({ id: 'thinking', parentId: 'model', thinkingLevel: 'high', timestamp: '2', type: 'thinking_level_change' }),
      entry({ id: 'title', name: 'Renamed', parentId: 'thinking', timestamp: '3', type: 'session_info' }),
      entry({
        id: 'user',
        message: { content: 'hello', role: 'user', timestamp: 4 },
        parentId: 'title',
        timestamp: '4',
        type: 'message',
      }),
    ];

    expect(projectPiTimeline(entries).entries.map((candidate) => candidate.id)).toEqual(['user']);
  });

  test('does not render a completed assistant again as the streaming tail', () => {
    const message = assistant('done', 42);
    const entries: PiSessionEntry[] = [entry({
      id: 'assistant',
      message,
      parentId: null,
      timestamp: '42',
      type: 'message',
    })];

    const projection = projectPiTimeline(entries, { ...message, content: [{ text: 'done', type: 'text' }] });
    expect(projection.entries).toHaveLength(1);
    expect(projection.liveAssistant).toBeUndefined();
  });

  test('keeps a runtime user message visible until its persisted entry arrives', () => {
    const message = { content: 'hello', role: 'user' as const, timestamp: 9 };
    expect(projectPiTimeline([], undefined, message).liveUser).toEqual(message);

    const entries: PiSessionEntry[] = [entry({
      id: 'user',
      message,
      parentId: null,
      timestamp: '9',
      type: 'message',
    })];
    expect(projectPiTimeline(entries, undefined, message).liveUser).toBeUndefined();
  });
});
