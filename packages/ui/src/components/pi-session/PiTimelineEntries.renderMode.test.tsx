import React from 'react';
import { afterEach, describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PiAssistantMessage, PiSessionEntry } from '@piarium/protocol';
import type { RuntimeAPIs } from '@piarium/application-client';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import { I18nProvider } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';
import { usePiSessionStore } from '@/stores/usePiSessionStore';
import { PiTimelineEntryList } from './PiTimelineEntries';

const liveAssistant: PiAssistantMessage = {
  api: 'messages',
  content: [
    { thinking: 'Inspecting the current implementation.', type: 'thinking' },
    { text: 'This unfinished answer must not appear yet.', type: 'text' },
  ],
  model: 'model',
  provider: 'provider',
  role: 'assistant',
  stopReason: 'pending',
  timestamp: 2,
  usage: {
    cacheRead: 0,
    cacheWrite: 0,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
    input: 0,
    output: 0,
    totalTokens: 0,
  },
};

const runtimeAPIs = { editor: undefined } as unknown as RuntimeAPIs;

const renderTimeline = (
  assistant: PiAssistantMessage = liveAssistant,
  entries: PiSessionEntry[] = [],
  onOpenThread?: (entry: Extract<PiSessionEntry, { type: 'message' }>, options: { carryBlocks: boolean }) => void,
): string => {
  // Zustand deliberately exposes the creation snapshot during SSR. Mirror the
  // selected fields into that snapshot so this server render exercises them.
  const serverState = useUIStore.getInitialState();
  const currentState = useUIStore.getState();
  const piServerState = usePiSessionStore.getInitialState();
  const previous = {
    activityRenderMode: serverState.activityRenderMode,
    chatRenderMode: serverState.chatRenderMode,
  };
  serverState.activityRenderMode = currentState.activityRenderMode;
  serverState.chatRenderMode = currentState.chatRenderMode;
  const previousSessionId = piServerState.currentSessionId;
  piServerState.currentSessionId = 'session';
  try {
    return renderToStaticMarkup(
      <RuntimeAPIContext.Provider value={runtimeAPIs}>
        <I18nProvider>
          <PiTimelineEntryList
            cwd="C:\\workspace"
            entries={entries}
            liveAssistant={assistant}
            onOpenThread={onOpenThread}
            sessionId="session"
            toolExecutions={{}}
          />
        </I18nProvider>
      </RuntimeAPIContext.Provider>,
    );
  } finally {
    serverState.activityRenderMode = previous.activityRenderMode;
    serverState.chatRenderMode = previous.chatRenderMode;
    piServerState.currentSessionId = previousSessionId;
  }
};

afterEach(() => {
  useUIStore.setState({ chatRenderMode: 'live' });
});

describe('Pi timeline chat render mode', () => {
  test('sorted mode streams activity while withholding unfinished answer text', () => {
    useUIStore.setState({ chatRenderMode: 'sorted', activityRenderMode: 'summary' });

    const markup = renderTimeline();

    expect(markup).toContain('data-pi-sorted-activity="true"');
    expect(markup).toContain('data-pi-activity-kind="thinking"');
    expect(markup).not.toContain('This unfinished answer must not appear yet.');
  });

  test('live mode preserves the natural streaming order without an activity group', () => {
    useUIStore.setState({ chatRenderMode: 'live' });

    const markup = renderTimeline();

    expect(markup).not.toContain('data-pi-sorted-activity="true"');
    expect(markup).toContain('group/thinking');
  });

  test('live mode folds consecutive known read-only tools but keeps writes separate', () => {
    useUIStore.setState({ chatRenderMode: 'live' });
    const assistant: PiAssistantMessage = {
      ...liveAssistant,
      content: [
        { type: 'toolCall', id: 'grep-1', name: 'grep', arguments: { pattern: 'TODO', path: 'src' } },
        { type: 'toolCall', id: 'read-1', name: 'read', arguments: { path: 'src/a.ts' } },
        { type: 'toolCall', id: 'write-1', name: 'write', arguments: { path: 'src/a.ts' } },
      ],
    };

    const markup = renderTimeline(assistant);
    expect(markup).toContain('Searched TODO in src · +1');
    expect(markup).toContain('Edited src/a.ts');
    expect(markup).toContain('group/tools my-1');
  });

  test('persisted messages and tool results expose the scoped knowledge review action', () => {
    useUIStore.setState({ chatRenderMode: 'live' });
    const entries = [{
      id: 'user-entry', parentId: null, timestamp: '2026-09-04T00:00:00.000Z', type: 'message',
      message: { role: 'user', content: 'Remember the user preference', timestamp: 1 },
    }, {
      id: 'assistant-entry', parentId: 'user-entry', timestamp: '2026-09-04T00:00:01.000Z', type: 'message',
      message: { ...liveAssistant, stopReason: 'stop', content: [{ type: 'text', text: 'Remember the answer' }] },
    }, {
      id: 'tool-entry', parentId: 'assistant-entry', timestamp: '2026-09-04T00:00:02.000Z', type: 'message',
      message: { role: 'toolResult', toolCallId: 'tool-1', toolName: 'read', content: [{ type: 'text', text: 'Remember the result' }], isError: false, timestamp: 3 },
    }] as PiSessionEntry[];
    const markup = renderTimeline(liveAssistant, entries, () => undefined);
    expect(markup.match(/aria-label="Add to knowledge review"/g)?.length).toBe(3);
    expect(markup.match(/aria-label="Open a discussion thread from this message"/g)?.length).toBe(2);
  });
});
