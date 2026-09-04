import { describe, expect, it } from 'vitest';
import { harnessKnowledgeKey, parseHarnessKnowledgeSuggestions } from './harnessKnowledgePresentation';

describe('Harness knowledge suggestion projection', () => {
  it('keeps scope in identity because store-local ids can collide', () => {
    const parsed = parseHarnessKnowledgeSuggestions({ suggestions: [{
      id: 1,
      scope: 'workspace',
      status: 'suggested',
      content: 'Use Bun',
      trigger: 'package management',
      createdAt: 1,
      source: { sessionId: 'session-1', kind: 'block' },
      supersedesCandidates: [{ id: 2, content: 'Use npm', trigger: 'package management' }],
    }, {
      id: 1,
      scope: 'user',
      status: 'suggested',
      content: 'Be concise',
      trigger: 'response style',
      createdAt: 2,
      supersedesCandidates: [],
    }] });
    expect(parsed).toHaveLength(2);
    expect(parsed.map(harnessKnowledgeKey)).toEqual(['workspace:1', 'user:1']);
  });

  it('rejects malformed entries instead of presenting them as empty', () => {
    expect(() => parseHarnessKnowledgeSuggestions({ suggestions: [{ id: 1 }] })).toThrow(/Malformed/);
  });
});
