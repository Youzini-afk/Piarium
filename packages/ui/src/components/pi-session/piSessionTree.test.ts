import { describe, expect, test } from 'vitest';
import type {
  PiAssistantMessage,
  PiSessionMessageEntry,
  PiUserMessage,
  SessionTreeNode,
} from '@piarium/protocol';
import { projectPiSessionTree } from './piSessionTree';

const user = (id: string, parentId: string | null, text: string): PiSessionMessageEntry => ({
  id,
  message: { content: text, role: 'user', timestamp: 1 } satisfies PiUserMessage,
  parentId,
  timestamp: '2026-08-29T00:00:00.000Z',
  type: 'message',
});

const assistant = (id: string, parentId: string, text: string): PiSessionMessageEntry => ({
  id,
  message: {
    api: 'test',
    content: [{ text, type: 'text' }],
    model: 'test',
    provider: 'test',
    role: 'assistant',
    stopReason: 'stop',
    timestamp: 2,
    usage: {
      cacheRead: 0,
      cacheWrite: 0,
      cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
      input: 0,
      output: 0,
      totalTokens: 0,
    },
  } satisfies PiAssistantMessage,
  parentId,
  timestamp: '2026-08-29T00:00:01.000Z',
  type: 'message',
});

const node = (entry: SessionTreeNode['entry'], children: SessionTreeNode[] = []): SessionTreeNode => ({
  children,
  entry,
});

describe('Pi session tree projection', () => {
  test('keeps the active branch flat and indents alternate branches only at splits', () => {
    const first = user('user-1', null, 'start');
    const answer = assistant('assistant-1', first.id, 'answer');
    const alternate = user('user-alt', answer.id, 'alternate');
    const active = user('user-active', answer.id, 'active');
    const leaf = assistant('assistant-active', active.id, 'latest');
    const tree = node(first, [node(answer, [node(alternate), node(active, [node(leaf)])])]);

    const projected = projectPiSessionTree({
      leafId: leaf.id,
      sessionId: 'session-1',
      tree: [tree],
    });

    expect(projected.map((item) => ({
      active: item.active,
      current: item.current,
      depth: item.branchDepth,
      id: item.entry.id,
      text: item.text,
    }))).toEqual([
      { active: true, current: false, depth: 0, id: 'user-1', text: 'start' },
      { active: true, current: false, depth: 0, id: 'assistant-1', text: 'answer' },
      { active: false, current: false, depth: 1, id: 'user-alt', text: 'alternate' },
      { active: true, current: false, depth: 0, id: 'user-active', text: 'active' },
      { active: true, current: true, depth: 0, id: 'assistant-active', text: 'latest' },
    ]);
  });

  test('skips structural entries while preserving their message descendants', () => {
    const first = user('user-1', 'model-1', 'hello');
    const tree = node({
      id: 'model-1',
      modelId: 'model',
      parentId: null,
      provider: 'provider',
      timestamp: '2026-08-29T00:00:00.000Z',
      type: 'model_change',
    }, [node(first)]);

    expect(projectPiSessionTree({
      leafId: first.id,
      sessionId: 'session-1',
      tree: [tree],
    })).toEqual([expect.objectContaining({
      branchDepth: 0,
      current: true,
      entry: first,
    })]);
  });
});
