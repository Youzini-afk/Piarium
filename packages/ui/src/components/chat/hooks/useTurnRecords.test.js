import { describe, expect, it } from 'bun:test';

import { projectTurnRecords } from '../lib/turns/projectTurnRecords';
import { splitTurnProjectionForStreaming } from './useTurnRecords';

const message = (id, role, parentID) => ({
  info: {
    id,
    sessionID: 'session-1',
    role,
    ...(parentID ? { parentID } : {}),
    time: { created: 1 },
  },
  parts: [],
});

describe('splitTurnProjectionForStreaming', () => {
  it('keeps the last turn static when a trailing assistant message is waiting for its parent user message', () => {
    const oldUser = message('msg-001-user', 'user');
    const oldAssistant = message('msg-002-assistant', 'assistant', oldUser.info.id);
    const orphanAssistant = message('msg-004-assistant', 'assistant', 'msg-003-user');
    const projection = projectTurnRecords([oldUser, oldAssistant, orphanAssistant]);

    const result = splitTurnProjectionForStreaming(projection, [oldUser, oldAssistant, orphanAssistant]);

    expect(result.staticTurns.map((turn) => turn.turnId)).toEqual([oldUser.info.id]);
    expect(result.streamingTurn).toBeUndefined();
    expect(result.trailingUngroupedMessageId).toBe(orphanAssistant.info.id);
  });

  it('keeps the normal last grouped turn as the streaming turn', () => {
    const oldUser = message('msg-001-user', 'user');
    const oldAssistant = message('msg-002-assistant', 'assistant', oldUser.info.id);
    const newUser = message('msg-003-user', 'user');
    const newAssistant = message('msg-004-assistant', 'assistant', newUser.info.id);
    const projection = projectTurnRecords([oldUser, oldAssistant, newUser, newAssistant]);

    const result = splitTurnProjectionForStreaming(projection, [oldUser, oldAssistant, newUser, newAssistant]);

    expect(result.staticTurns.map((turn) => turn.turnId)).toEqual([oldUser.info.id]);
    expect(result.streamingTurn?.turnId).toBe(newUser.info.id);
    expect(result.trailingUngroupedMessageId).toBeUndefined();
  });

  it('keeps an assistant-before-user parented turn as the streaming turn without an ungrouped duplicate', () => {
    const user = message('msg-010-user', 'user');
    const earlyAssistant = message('msg-009-assistant', 'assistant', user.info.id);
    const projection = projectTurnRecords([earlyAssistant, user]);

    const result = splitTurnProjectionForStreaming(projection, [earlyAssistant, user]);

    expect(result.staticTurns).toEqual([]);
    expect(result.streamingTurn?.turnId).toBe(user.info.id);
    expect(result.streamingTurn?.assistantMessageIds).toEqual([earlyAssistant.info.id]);
    expect(result.trailingUngroupedMessageId).toBeUndefined();
  });
});
