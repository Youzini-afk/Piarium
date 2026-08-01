import { describe, expect, it } from 'bun:test';

import { projectTurnRecords } from './projectTurnRecords';
import { buildTurnWindowModel, updateTurnWindowModelIncremental } from './windowTurns';

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

describe('projectTurnRecords', () => {
  it('does not attach an assistant message to the previous turn when its parent user message is not loaded yet', () => {
    const oldUser = message('msg-001-user', 'user');
    const oldAssistant = message('msg-002-assistant', 'assistant', oldUser.info.id);
    const orphanAssistant = message('msg-004-assistant', 'assistant', 'msg-003-user');

    const projection = projectTurnRecords([oldUser, oldAssistant, orphanAssistant]);

    expect(projection.turns).toHaveLength(1);
    expect(projection.turns[0].assistantMessageIds).toEqual([oldAssistant.info.id]);
    expect(projection.ungroupedMessageIds.has(orphanAssistant.info.id)).toBe(true);
  });

  it('groups an assistant message once its parent user message is present', () => {
    const oldUser = message('msg-001-user', 'user');
    const oldAssistant = message('msg-002-assistant', 'assistant', oldUser.info.id);
    const newUser = message('msg-003-user', 'user');
    const newAssistant = message('msg-004-assistant', 'assistant', newUser.info.id);

    const projection = projectTurnRecords([oldUser, oldAssistant, newUser, newAssistant]);

    expect(projection.turns.map((turn) => turn.userMessageId)).toEqual([
      oldUser.info.id,
      newUser.info.id,
    ]);
    expect(projection.turns[0].assistantMessageIds).toEqual([oldAssistant.info.id]);
    expect(projection.turns[1].assistantMessageIds).toEqual([newAssistant.info.id]);
    expect(projection.ungroupedMessageIds.size).toBe(0);
  });

  it('groups an assistant message with its parent user even when the assistant is ordered first', () => {
    const user = message('msg-010-user', 'user');
    const earlyAssistant = message('msg-009-assistant', 'assistant', user.info.id);

    const projection = projectTurnRecords([earlyAssistant, user]);

    expect(projection.turns).toHaveLength(1);
    expect(projection.turns[0].userMessageId).toBe(user.info.id);
    expect(projection.turns[0].assistantMessageIds).toEqual([earlyAssistant.info.id]);
    expect(projection.ungroupedMessageIds.size).toBe(0);
    expect(projection.indexes.messageToTurnId.get(earlyAssistant.info.id)).toBe(user.info.id);
  });
});

describe('turn window model', () => {
  it('does not map an assistant message to the previous turn when its parent user message is not loaded yet', () => {
    const oldUser = message('msg-001-user', 'user');
    const oldAssistant = message('msg-002-assistant', 'assistant', oldUser.info.id);
    const orphanAssistant = message('msg-004-assistant', 'assistant', 'msg-003-user');

    const model = buildTurnWindowModel([oldUser, oldAssistant, orphanAssistant]);

    expect(model.messageToTurnId.get(oldAssistant.info.id)).toBe(oldUser.info.id);
    expect(model.messageToTurnId.has(orphanAssistant.info.id)).toBe(false);
  });

  it('keeps incremental window updates from mapping orphan assistant messages to the previous turn', () => {
    const oldUser = message('msg-001-user', 'user');
    const oldAssistant = message('msg-002-assistant', 'assistant', oldUser.info.id);
    const orphanAssistant = message('msg-004-assistant', 'assistant', 'msg-003-user');
    const previousMessages = [oldUser, oldAssistant];
    const previousModel = buildTurnWindowModel(previousMessages);

    const nextModel = updateTurnWindowModelIncremental(
      previousModel,
      previousMessages,
      [...previousMessages, orphanAssistant],
    );

    if (nextModel) {
      expect(nextModel.messageToTurnId.has(orphanAssistant.info.id)).toBe(false);
    }
  });

  it('maps assistant messages to their parent turn even when the assistant is ordered first', () => {
    const user = message('msg-010-user', 'user');
    const earlyAssistant = message('msg-009-assistant', 'assistant', user.info.id);

    const model = buildTurnWindowModel([earlyAssistant, user]);

    expect(model.turnIds).toEqual([user.info.id]);
    expect(model.messageToTurnId.get(earlyAssistant.info.id)).toBe(user.info.id);
    expect(model.messageToTurnIndex.get(earlyAssistant.info.id)).toBe(0);
  });
});
