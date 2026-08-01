import { describe, expect, test } from 'bun:test';

import {
  buildEmbeddedSessionChatURL,
  isEmbeddedSessionChatReady,
  readEmbeddedSessionChatConfigFromSearch,
  shouldConsumeSessionUrlParams,
} from './embeddedSessionChat';

describe('embedded session chat URL helpers', () => {
  test('builds embedded session chat URLs with namespaced params', () => {
    const url = buildEmbeddedSessionChatURL({
      sessionId: 'child-123',
      directory: '/tmp/project',
      readOnly: true,
      basePath: '/app',
      origin: 'https://openchamber.test',
    });

    expect(url).toBe('https://openchamber.test/app?surface=desktop&ocPanel=session-chat&ocSessionId=child-123&ocReadOnly=1&ocDirectory=%2Ftmp%2Fproject');
    expect(url).not.toContain('sessionId=');
    expect(url).not.toContain('directory=');
    expect(url).not.toContain('readOnly=');
  });

  test('parses embedded session chat config from namespaced ocPanel URL params', () => {
    const config = readEmbeddedSessionChatConfigFromSearch('?ocPanel=session-chat&ocSessionId=child-123&ocDirectory=%2Ftmp%2Fproject&ocReadOnly=1');

    expect(config).toEqual({
      sessionId: 'child-123',
      directory: '/tmp/project',
      readOnly: true,
    });
  });

  test('parses legacy embedded session chat params for existing tabs', () => {
    const config = readEmbeddedSessionChatConfigFromSearch('?ocPanel=session-chat&sessionId=child-123&directory=%2Ftmp%2Fproject&readOnly=1');

    expect(config).toEqual({
      sessionId: 'child-123',
      directory: '/tmp/project',
      readOnly: true,
    });
  });

  test('does not let generic session URL cleanup consume embedded session chat params', () => {
    const params = new URLSearchParams('?ocPanel=session-chat&ocSessionId=child-123&ocDirectory=%2Ftmp%2Fproject&ocReadOnly=1');

    expect(shouldConsumeSessionUrlParams(params)).toBe(false);
  });

  test('still consumes normal session deep-link params', () => {
    expect(shouldConsumeSessionUrlParams(new URLSearchParams('?sessionId=session-123&directory=%2Ftmp%2Fproject'))).toBe(true);
    expect(shouldConsumeSessionUrlParams(new URLSearchParams('?session=session-123'))).toBe(true);
  });

  test('does not allow embedded ChatView to render before target session is active', () => {
    const embeddedSessionChat = {
      sessionId: 'child-123',
      directory: '/tmp/project/',
      readOnly: true,
    };

    expect(isEmbeddedSessionChatReady({
      embeddedSessionChat,
      currentSessionId: null,
      currentDirectory: '/tmp/project',
    })).toBe(false);

    expect(isEmbeddedSessionChatReady({
      embeddedSessionChat,
      currentSessionId: 'parent-123',
      currentDirectory: '/tmp/project',
    })).toBe(false);

    expect(isEmbeddedSessionChatReady({
      embeddedSessionChat,
      currentSessionId: 'child-123',
      currentDirectory: '/tmp/other',
    })).toBe(false);

    expect(isEmbeddedSessionChatReady({
      embeddedSessionChat,
      currentSessionId: 'child-123',
      currentDirectory: '/tmp/project',
    })).toBe(true);
  });
});
