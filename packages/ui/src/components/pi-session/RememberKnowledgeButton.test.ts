import { describe, expect, it } from 'vitest';
import { knowledgeSuggestionEndpoint, knowledgeSuggestionPayload } from './knowledgeSuggestionRequest';

describe('RememberKnowledgeButton request projection', () => {
  it('keeps session ids in the path and scope in the body', () => {
    expect(knowledgeSuggestionEndpoint('session/a b')).toBe('/api/harness/sessions/session%2Fa%20b/knowledge/suggestions');
    expect(knowledgeSuggestionPayload('user', 'Remember this', 'message:user')).toEqual({
      scope: 'user',
      content: 'Remember this',
      trigger: '',
      kind: 'message:user',
    });
  });
});
