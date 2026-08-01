import { describe, expect, test } from 'bun:test';

import { getMessagesBeforeRevert, partitionMessagesByRevert, sortMessagesForRevert } from './revert-filter';

type TestMessage = {
  id: string;
  role: 'user' | 'assistant';
  parentID?: string;
  time?: { created?: number; completed?: number };
};

const ids = (messages: TestMessage[]) => messages.map((message) => message.id);

describe('revert message filtering', () => {
  test('removes target and later descendants even when ids sort before the target', () => {
    const messages: TestMessage[] = [
      { id: 'a-assistant-after', role: 'assistant', parentID: 'z-target-user', time: { created: 30 } },
      { id: 'b-user-after', role: 'user', parentID: 'a-assistant-after', time: { created: 40 } },
      { id: 'm-user-before', role: 'user', time: { created: 10 } },
      { id: 'n-assistant-before', role: 'assistant', parentID: 'm-user-before', time: { created: 20 } },
      { id: 'z-target-user', role: 'user', parentID: 'n-assistant-before', time: { created: 25 } },
    ];

    const result = partitionMessagesByRevert(messages, 'z-target-user');

    expect(ids(result.kept)).toEqual(['m-user-before', 'n-assistant-before']);
    expect(ids(result.removed)).toEqual(['a-assistant-after', 'b-user-after', 'z-target-user']);
  });

  test('removes descendants of the revert marker even when the target message is not loaded', () => {
    const messages: TestMessage[] = [
      { id: 'assistant-child', role: 'assistant', parentID: 'target-user', time: { created: 30 } },
      { id: 'user-grandchild', role: 'user', parentID: 'assistant-child', time: { created: 40 } },
      { id: 'unrelated-before', role: 'user', time: { created: 10 } },
    ];

    expect(ids(getMessagesBeforeRevert(messages, 'target-user'))).toEqual(['unrelated-before']);
  });

  test('falls back to current array position when messages have no usable time', () => {
    const messages: TestMessage[] = [
      { id: 'before', role: 'user' },
      { id: 'target', role: 'user' },
      { id: 'after-without-parent', role: 'assistant' },
    ];

    expect(ids(getMessagesBeforeRevert(messages, 'target'))).toEqual(['before']);
  });

  test('sorts messages by time before falling back to id order for revert controls', () => {
    const messages: TestMessage[] = [
      { id: 'z-later-id', role: 'user', time: { created: 20 } },
      { id: 'a-earlier-id', role: 'user', time: { created: 10 } },
      { id: 'm-no-time', role: 'user' },
    ];

    expect(ids(sortMessagesForRevert(messages))).toEqual(['a-earlier-id', 'z-later-id', 'm-no-time']);
  });
});
