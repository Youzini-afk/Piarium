import type {
  PiAssistantMessage,
  PiModelChangeEntry,
  PiSessionEntry,
  PiSessionInfoEntry,
  PiSessionMessageEntry,
  PiThinkingLevelChangeEntry,
  PiToolResultMessage,
  PiUserMessage,
} from '@piarium/protocol';

type PiTimelineControlEntry = Extract<
  PiSessionEntry,
  { type: 'model_change' | 'thinking_level_change' | 'session_info' }
>;

export type PiTimelineEntry = Exclude<PiSessionEntry, PiTimelineControlEntry>;

export interface PiTimelineTurnMetadata {
  model?: PiModelChangeEntry;
  sessionInfo?: PiSessionInfoEntry;
  thinking?: PiThinkingLevelChangeEntry;
}

export interface PiTimelineTurn {
  entries: readonly PiTimelineEntry[];
  id: string;
  liveAssistant?: PiAssistantMessage;
  liveUser: boolean;
  metadata: PiTimelineTurnMetadata;
  resultByCallId: ReadonlyMap<string, PiToolResultMessage>;
  user: PiUserMessage;
  userEntry?: PiSessionMessageEntry;
}

export type PiTimelineItem =
  | {
      entry: PiTimelineEntry;
      id: string;
      kind: 'entry';
      resultByCallId: ReadonlyMap<string, PiToolResultMessage>;
    }
  | {
      id: string;
      kind: 'live-assistant';
      message: PiAssistantMessage;
      resultByCallId: ReadonlyMap<string, PiToolResultMessage>;
    }
  | { id: string; kind: 'turn'; turn: PiTimelineTurn };

export interface PiTimelineProjection {
  items: readonly PiTimelineItem[];
  liveAssistant?: PiAssistantMessage;
  liveUser?: PiUserMessage;
  /** Stable history before live user/assistant overlays are applied. */
  persistentItems: readonly PiTimelineItem[];
  resultByCallId: ReadonlyMap<string, PiToolResultMessage>;
  /** Flat visible entries used by a single virtual turn row's presentation. */
  visibleEntries: readonly PiTimelineEntry[];
}

interface PiTimelinePersistentProjection {
  items: readonly PiTimelineItem[];
  pendingMetadata: PiTimelineTurnMetadata;
  resultByCallId: ReadonlyMap<string, PiToolResultMessage>;
  visibleEntries: readonly PiTimelineEntry[];
}

interface PiTimelineTurnDraft {
  entries: PiTimelineEntry[];
  metadata: PiTimelineTurnMetadata;
  user: PiUserMessage;
  userEntry: PiSessionMessageEntry;
}

const sameAssistantMessage = (
  left: PiAssistantMessage,
  right: PiAssistantMessage,
): boolean => (
  left.timestamp === right.timestamp
  && left.provider === right.provider
  && left.model === right.model
);

const sameUserMessage = (left: PiUserMessage, right: PiUserMessage): boolean => (
  left.timestamp === right.timestamp
);

const isTimelineControlEntry = (entry: PiSessionEntry): entry is PiTimelineControlEntry => (
  entry.type === 'model_change'
  || entry.type === 'thinking_level_change'
  || entry.type === 'session_info'
);

const isVisibleTimelineEntry = (
  entry: PiSessionEntry,
  knownToolCallIds: ReadonlySet<string>,
): entry is PiTimelineEntry => {
  if (isTimelineControlEntry(entry)) return false;
  if (entry.type === 'custom' && entry.customType === 'piarium.session-features/v1') return false;
  if (entry.type === 'custom_message' && !entry.display) return false;
  if (entry.type === 'message' && entry.message.role === 'custom' && !entry.message.display) return false;
  if (
    entry.type === 'message'
    && entry.message.role === 'toolResult'
    && knownToolCallIds.has(entry.message.toolCallId)
  ) return false;
  return true;
};

const sameEntries = (
  left: readonly PiTimelineEntry[],
  right: readonly PiTimelineEntry[],
): boolean => (
  left.length === right.length && left.every((entry, index) => entry === right[index])
);

const sameMetadata = (
  left: PiTimelineTurnMetadata,
  right: PiTimelineTurnMetadata,
): boolean => (
  left.model === right.model
  && left.sessionInfo === right.sessionInfo
  && left.thinking === right.thinking
);

const EMPTY_RESULT_MAP: ReadonlyMap<string, PiToolResultMessage> = new Map();

const sameResultMaps = (
  left: ReadonlyMap<string, PiToolResultMessage>,
  right: ReadonlyMap<string, PiToolResultMessage>,
): boolean => (
  left.size === right.size
  && [...left].every(([id, result]) => right.get(id) === result)
);

const stableResultMap = (
  next: ReadonlyMap<string, PiToolResultMessage>,
  previous: ReadonlyMap<string, PiToolResultMessage> | undefined,
): ReadonlyMap<string, PiToolResultMessage> => {
  if (next.size === 0) return EMPTY_RESULT_MAP;
  return previous && sameResultMaps(next, previous) ? previous : next;
};

const resultsForMessages = (
  entries: readonly PiTimelineEntry[],
  resultByCallId: ReadonlyMap<string, PiToolResultMessage>,
  liveAssistant?: PiAssistantMessage,
): ReadonlyMap<string, PiToolResultMessage> => {
  const results = new Map<string, PiToolResultMessage>();
  const collect = (message: PiAssistantMessage): void => {
    for (const content of message.content) {
      if (content.type !== 'toolCall') continue;
      const result = resultByCallId.get(content.id);
      if (result) results.set(content.id, result);
    }
  };
  for (const entry of entries) {
    if (entry.type === 'message' && entry.message.role === 'assistant') collect(entry.message);
  }
  if (liveAssistant) collect(liveAssistant);
  return results.size === 0 ? EMPTY_RESULT_MAP : results;
};

const persistentProjection = (
  entries: PiSessionEntry[],
  liveAssistant: PiAssistantMessage | undefined,
  previous: PiTimelineProjection | undefined,
): PiTimelinePersistentProjection => {
  const knownToolCallIds = new Set<string>();
  const resultByCallId = new Map<string, PiToolResultMessage>();
  for (const entry of entries) {
    if (entry.type !== 'message') continue;
    if (entry.message.role === 'assistant') {
      for (const content of entry.message.content) {
        if (content.type === 'toolCall') knownToolCallIds.add(content.id);
      }
    } else if (entry.message.role === 'toolResult') {
      resultByCallId.set(entry.message.toolCallId, entry.message);
    }
  }
  if (liveAssistant) {
    for (const content of liveAssistant.content) {
      if (content.type === 'toolCall') knownToolCallIds.add(content.id);
    }
  }

  const drafts: Array<
    | { entry: PiTimelineEntry; kind: 'entry' }
    | { kind: 'turn'; turn: PiTimelineTurnDraft }
  > = [];
  let pendingMetadata: PiTimelineTurnMetadata = {};
  let currentTurn: PiTimelineTurnDraft | undefined;
  const visibleEntries: PiTimelineEntry[] = [];

  for (const entry of entries) {
    if (entry.type === 'model_change') {
      pendingMetadata = { ...pendingMetadata, model: entry };
      continue;
    }
    if (entry.type === 'thinking_level_change') {
      pendingMetadata = { ...pendingMetadata, thinking: entry };
      continue;
    }
    if (entry.type === 'session_info') {
      pendingMetadata = { ...pendingMetadata, sessionInfo: entry };
      continue;
    }
    if (!isVisibleTimelineEntry(entry, knownToolCallIds)) continue;
    visibleEntries.push(entry);

    if (entry.type === 'message' && entry.message.role === 'user') {
      currentTurn = {
        entries: [],
        metadata: pendingMetadata,
        user: entry.message,
        userEntry: entry,
      };
      pendingMetadata = {};
      drafts.push({ kind: 'turn', turn: currentTurn });
      continue;
    }

    if (currentTurn) currentTurn.entries.push(entry);
    else drafts.push({ entry, kind: 'entry' });
  }

  const stableGlobalResults = stableResultMap(resultByCallId, previous?.resultByCallId);
  const previousById = new Map(previous?.persistentItems.map((item) => [item.id, item]) ?? []);
  const items = drafts.map<PiTimelineItem>((draft) => {
    if (draft.kind === 'entry') {
      const id = `entry:${draft.entry.id}`;
      const prior = previousById.get(id);
      const itemResults = stableResultMap(
        resultsForMessages([draft.entry], stableGlobalResults),
        prior?.kind === 'entry' ? prior.resultByCallId : undefined,
      );
      return prior?.kind === 'entry'
        && prior.entry === draft.entry
        && prior.resultByCallId === itemResults
        ? prior
        : { entry: draft.entry, id, kind: 'entry', resultByCallId: itemResults };
    }

    const id = `turn:${draft.turn.userEntry.id}`;
    const prior = previousById.get(id);
    const turnResults = stableResultMap(
      resultsForMessages(draft.turn.entries, stableGlobalResults),
      prior?.kind === 'turn' ? prior.turn.resultByCallId : undefined,
    );
    if (
      prior?.kind === 'turn'
      && prior.turn.userEntry === draft.turn.userEntry
      && !prior.turn.liveAssistant
      && sameEntries(prior.turn.entries, draft.turn.entries)
      && sameMetadata(prior.turn.metadata, draft.turn.metadata)
      && prior.turn.resultByCallId === turnResults
    ) return prior;
    return {
      id,
      kind: 'turn',
      turn: {
        entries: draft.turn.entries,
        id,
        liveUser: false,
        metadata: draft.turn.metadata,
        resultByCallId: turnResults,
        user: draft.turn.user,
        userEntry: draft.turn.userEntry,
      },
    };
  });

  return { items, pendingMetadata, resultByCallId: stableGlobalResults, visibleEntries };
};

export const projectPiTimeline = (
  entries: PiSessionEntry[],
  liveAssistant?: PiAssistantMessage,
  liveUser?: PiUserMessage,
  previous?: PiTimelineProjection,
): PiTimelineProjection => {
  const persistedAssistant = liveAssistant !== undefined && entries.some((entry) => (
    entry.type === 'message'
    && entry.message.role === 'assistant'
    && sameAssistantMessage(entry.message, liveAssistant)
  ));
  const projectedLiveAssistant = persistedAssistant ? undefined : liveAssistant;
  const persistedUser = liveUser !== undefined && entries.some((entry) => (
    entry.type === 'message'
    && entry.message.role === 'user'
    && sameUserMessage(entry.message, liveUser)
  ));
  const projectedLiveUser = persistedUser ? undefined : liveUser;
  const persistent = persistentProjection(entries, projectedLiveAssistant, previous);
  const items = [...persistent.items];

  if (projectedLiveUser) {
    const id = `turn:live-user:${projectedLiveUser.timestamp}`;
    items.push({
      id,
      kind: 'turn',
      turn: {
        entries: [],
        id,
        liveUser: true,
        metadata: persistent.pendingMetadata,
        resultByCallId: EMPTY_RESULT_MAP,
        user: projectedLiveUser,
      },
    });
  }

  if (projectedLiveAssistant) {
    let tailTurnIndex = -1;
    for (let index = items.length - 1; index >= 0; index -= 1) {
      if (items[index]?.kind === 'turn') {
        tailTurnIndex = index;
        break;
      }
    }
    const tailTurn = items[tailTurnIndex];
    if (tailTurn?.kind === 'turn') {
      const tailResults = stableResultMap(
        resultsForMessages(tailTurn.turn.entries, persistent.resultByCallId, projectedLiveAssistant),
        tailTurn.turn.resultByCallId,
      );
      items[tailTurnIndex] = {
        ...tailTurn,
        turn: {
          ...tailTurn.turn,
          liveAssistant: projectedLiveAssistant,
          resultByCallId: tailResults,
        },
      };
    } else {
      items.push({
        id: `live-assistant:${projectedLiveAssistant.timestamp}`,
        kind: 'live-assistant',
        message: projectedLiveAssistant,
        resultByCallId: stableResultMap(
          resultsForMessages([], persistent.resultByCallId, projectedLiveAssistant),
          undefined,
        ),
      });
    }
  }

  return {
    items,
    ...(projectedLiveAssistant ? { liveAssistant: projectedLiveAssistant } : {}),
    ...(projectedLiveUser ? { liveUser: projectedLiveUser } : {}),
    persistentItems: persistent.items,
    resultByCallId: persistent.resultByCallId,
    visibleEntries: persistent.visibleEntries,
  };
};
