import type {
  PiAssistantMessage,
  PiSessionEntry,
  PiToolResultMessage,
} from '@piarium/protocol';

export interface PiTimelineProjection {
  entries: PiTimelineEntry[];
  liveAssistant?: PiAssistantMessage;
  resultByCallId: ReadonlyMap<string, PiToolResultMessage>;
}

type PiTimelineControlEntry = Extract<
  PiSessionEntry,
  { type: 'model_change' | 'thinking_level_change' | 'session_info' }
>;

export type PiTimelineEntry = Exclude<PiSessionEntry, PiTimelineControlEntry>;

const sameAssistantMessage = (
  left: PiAssistantMessage,
  right: PiAssistantMessage,
): boolean => (
  left.timestamp === right.timestamp
  && left.provider === right.provider
  && left.model === right.model
);

const isTimelineControlEntry = (entry: PiSessionEntry): entry is PiTimelineControlEntry => (
  entry.type === 'model_change'
  || entry.type === 'thinking_level_change'
  || entry.type === 'session_info'
);

export const projectPiTimeline = (
  entries: PiSessionEntry[],
  liveAssistant?: PiAssistantMessage,
): PiTimelineProjection => {
  const persistedAssistant = liveAssistant === undefined
    ? false
    : entries.some((entry) => (
        entry.type === 'message'
        && entry.message.role === 'assistant'
        && sameAssistantMessage(entry.message, liveAssistant)
      ));
  const projectedLiveAssistant = persistedAssistant ? undefined : liveAssistant;
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
  if (projectedLiveAssistant) {
    for (const content of projectedLiveAssistant.content) {
      if (content.type === 'toolCall') knownToolCallIds.add(content.id);
    }
  }

  const projectedEntries = entries.filter((entry): entry is PiTimelineEntry => {
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
  });

  return {
    entries: projectedEntries,
    ...(projectedLiveAssistant ? { liveAssistant: projectedLiveAssistant } : {}),
    resultByCallId,
  };
};
