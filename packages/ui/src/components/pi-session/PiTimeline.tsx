import React from 'react';
import { LegendList, type LegendListRef } from '@legendapp/list/react';
import type { PiAssistantMessage, PiSessionEntry } from '@piarium/protocol';
import { useShallow } from 'zustand/react/shallow';
import { usePiSessionStore } from '@/stores/usePiSessionStore';
import {
  projectPiTimeline,
  type PiTimelineItem,
  type PiTimelineProjection,
} from './piTimelineProjection';
import {
  PiLiveUserTurnHeader,
  PiTimelineEntryList,
  type PiTimelineProps,
} from './PiTimelineEntries';

interface PiTimelineItemViewProps extends Omit<
  PiTimelineProps,
  'entries' | 'liveAssistant' | 'liveUser' | 'toolExecutions'
> {
  item: PiTimelineItem;
}

const toolCallIdsByItem = new WeakMap<PiTimelineItem, readonly string[]>();

const toolCallIdsForItem = (item: PiTimelineItem): readonly string[] => {
  const cached = toolCallIdsByItem.get(item);
  if (cached) return cached;
  const ids = new Set<string>();
  const collect = (message: PiAssistantMessage): void => {
    for (const content of message.content) {
      if (content.type === 'toolCall') ids.add(content.id);
    }
  };
  if (item.kind === 'live-assistant') collect(item.message);
  else if (item.kind === 'entry') {
    if (item.entry.type === 'message' && item.entry.message.role === 'assistant') {
      collect(item.entry.message);
    }
  } else {
    for (const entry of item.turn.entries) {
      if (entry.type === 'message' && entry.message.role === 'assistant') collect(entry.message);
    }
    if (item.turn.liveAssistant) collect(item.turn.liveAssistant);
  }
  const result = [...ids];
  toolCallIdsByItem.set(item, result);
  return result;
};

const PiTimelineItemView: React.FC<PiTimelineItemViewProps> = ({
  cwd,
  hiddenThinkingLabel,
  item,
  liveUserStatus,
  onRecover,
  onTogglePinned,
  pinBusyEntryId,
  pinnedEntryIds,
  recoveryBusyEntryId,
  sessionId,
}) => {
  const toolCallIds = React.useMemo(() => toolCallIdsForItem(item), [item]);
  const itemExecutions = usePiSessionStore(useShallow((state) => {
    const executions = state.records[sessionId]?.toolExecutions;
    return toolCallIds.map((id) => executions?.[id]);
  }));
  const toolExecutions = React.useMemo(() => Object.fromEntries(
    toolCallIds.flatMap((id, index) => {
      const execution = itemExecutions[index];
      return execution ? [[id, execution]] : [];
    }),
  ), [itemExecutions, toolCallIds]);
  if (item.kind === 'live-assistant') {
    return (
      <div className="chat-message-column py-1.5" data-turn-entry={item.id}>
        <PiTimelineEntryList
          cwd={cwd}
          entries={[]}
          hiddenThinkingLabel={hiddenThinkingLabel}
          liveAssistant={item.message}
          onRecover={onRecover}
          onTogglePinned={onTogglePinned}
          pinBusyEntryId={pinBusyEntryId}
          pinnedEntryIds={pinnedEntryIds}
          projectedResultByCallId={item.resultByCallId}
          recoveryBusyEntryId={recoveryBusyEntryId}
          sessionId={sessionId}
          toolExecutions={toolExecutions}
        />
      </div>
    );
  }

  if (item.kind === 'entry') {
    return (
      <div className="chat-message-column py-1.5" data-turn-entry={item.id}>
        <PiTimelineEntryList
          cwd={cwd}
          entries={[item.entry]}
          hiddenThinkingLabel={hiddenThinkingLabel}
          onRecover={onRecover}
          onTogglePinned={onTogglePinned}
          pinBusyEntryId={pinBusyEntryId}
          pinnedEntryIds={pinnedEntryIds}
          projectedResultByCallId={item.resultByCallId}
          recoveryBusyEntryId={recoveryBusyEntryId}
          sessionId={sessionId}
          toolExecutions={toolExecutions}
        />
      </div>
    );
  }

  const { turn } = item;
  const turnEntries: PiSessionEntry[] = turn.userEntry
    ? [turn.userEntry, ...turn.entries]
    : [...turn.entries];
  return (
    <div
      className="chat-message-column flex flex-col gap-3 py-1.5"
      data-turn-id={turn.id}
      data-turn-entry={turn.id}
    >
      {turn.liveUser ? <PiLiveUserTurnHeader message={turn.user} status={liveUserStatus} /> : null}
      <PiTimelineEntryList
        cwd={cwd}
        entries={turnEntries}
        hiddenThinkingLabel={hiddenThinkingLabel}
        liveAssistant={turn.liveAssistant}
        onRecover={onRecover}
        onTogglePinned={onTogglePinned}
        pinBusyEntryId={pinBusyEntryId}
        pinnedEntryIds={pinnedEntryIds}
        projectedResultByCallId={item.turn.resultByCallId}
        recoveryBusyEntryId={recoveryBusyEntryId}
        sessionId={sessionId}
        toolExecutions={toolExecutions}
      />
    </div>
  );
};

export const PiTimeline: React.FC<PiTimelineProps> = (props) => {
  const listRef = React.useRef<LegendListRef>(null);
  const projectionRef = React.useRef<PiTimelineProjection | undefined>(undefined);
  const projectionSessionRef = React.useRef(props.sessionId);
  if (projectionSessionRef.current !== props.sessionId) {
    projectionSessionRef.current = props.sessionId;
    projectionRef.current = undefined;
  }
  const projection = React.useMemo(() => projectPiTimeline(
    props.entries,
    props.liveAssistant,
    props.liveUser,
    projectionRef.current,
  ), [props.entries, props.liveAssistant, props.liveUser]);
  projectionRef.current = projection;

  const extraData = React.useMemo(() => ({
    hiddenThinkingLabel: props.hiddenThinkingLabel,
    liveUserStatus: props.liveUserStatus,
    onRecover: props.onRecover,
    onTogglePinned: props.onTogglePinned,
    pinBusyEntryId: props.pinBusyEntryId,
    pinnedEntryIds: props.pinnedEntryIds,
    recoveryBusyEntryId: props.recoveryBusyEntryId,
  }), [
    props.hiddenThinkingLabel,
    props.liveUserStatus,
    props.onRecover,
    props.onTogglePinned,
    props.pinBusyEntryId,
    props.pinnedEntryIds,
    props.recoveryBusyEntryId,
  ]);
  const renderItem = React.useCallback(({ item }: { item: PiTimelineItem }) => (
    <PiTimelineItemView
      cwd={props.cwd}
      hiddenThinkingLabel={props.hiddenThinkingLabel}
      item={item}
      liveUserStatus={props.liveUserStatus}
      onRecover={props.onRecover}
      onTogglePinned={props.onTogglePinned}
      pinBusyEntryId={props.pinBusyEntryId}
      pinnedEntryIds={props.pinnedEntryIds}
      recoveryBusyEntryId={props.recoveryBusyEntryId}
      sessionId={props.sessionId}
    />
  ), [
    props.cwd,
    props.hiddenThinkingLabel,
    props.liveUserStatus,
    props.onRecover,
    props.onTogglePinned,
    props.pinBusyEntryId,
    props.pinnedEntryIds,
    props.recoveryBusyEntryId,
    props.sessionId,
  ]);

  return (
    <LegendList
      ref={listRef}
      className="min-h-0 flex-1 overscroll-contain"
      contentContainerClassName="py-5"
      data={projection.items}
      dataKey={props.sessionId}
      extraData={extraData}
      getItemType={(item) => item.kind}
      initialScrollAtEnd
      itemsAreEqual={(previous, item) => previous === item}
      keyExtractor={(item) => item.id}
      maintainScrollAtEnd={{ animated: false }}
      maintainVisibleContentPosition={{ data: true, size: true }}
      recycleItems={false}
      renderItem={renderItem}
      data-pi-timeline="true"
      tabIndex={-1}
    />
  );
};
