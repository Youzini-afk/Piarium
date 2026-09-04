import React from 'react';
import { afterEach, describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PiAssistantMessage } from '@piarium/protocol';
import type { RuntimeAPIs } from '@piarium/application-client';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import { I18nProvider } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';
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

const renderTimeline = (assistant: PiAssistantMessage = liveAssistant): string => {
  // Zustand deliberately exposes the creation snapshot during SSR. Mirror the
  // selected fields into that snapshot so this server render exercises them.
  const serverState = useUIStore.getInitialState();
  const currentState = useUIStore.getState();
  const previous = {
    activityRenderMode: serverState.activityRenderMode,
    chatRenderMode: serverState.chatRenderMode,
  };
  serverState.activityRenderMode = currentState.activityRenderMode;
  serverState.chatRenderMode = currentState.chatRenderMode;
  try {
    return renderToStaticMarkup(
      <RuntimeAPIContext.Provider value={runtimeAPIs}>
        <I18nProvider>
          <PiTimelineEntryList
            cwd="C:\\workspace"
            entries={[]}
            liveAssistant={assistant}
            sessionId="session"
            toolExecutions={{}}
          />
        </I18nProvider>
      </RuntimeAPIContext.Provider>,
    );
  } finally {
    serverState.activityRenderMode = previous.activityRenderMode;
    serverState.chatRenderMode = previous.chatRenderMode;
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
});
