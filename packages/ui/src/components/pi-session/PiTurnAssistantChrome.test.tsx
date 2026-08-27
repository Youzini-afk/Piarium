import React from 'react';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PiAssistantMessage } from '@piarium/protocol';
import { I18nProvider } from '@/lib/i18n';
import type { PiTimelineTurn } from './piTimelineProjection';
import { PiTurnAssistantChrome } from './PiTurnAssistantChrome';

const assistant = (stopReason: PiAssistantMessage['stopReason']): PiAssistantMessage => ({
  api: 'messages',
  content: [],
  model: 'runtime-model',
  provider: 'runtime-provider',
  role: 'assistant',
  stopReason,
  timestamp: 2,
  usage: {
    cacheRead: 0,
    cacheWrite: 0,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
    input: 0,
    output: 0,
    totalTokens: 0,
  },
});

const turn = (liveAssistant?: PiAssistantMessage): PiTimelineTurn => ({
  entries: [],
  id: 'turn:user',
  ...(liveAssistant ? { liveAssistant } : {}),
  liveUser: true,
  metadata: {},
  resultByCallId: new Map(),
  user: { content: 'hello', role: 'user', timestamp: 1 },
});

const renderChrome = (node: React.ReactNode): string => renderToStaticMarkup(
  <I18nProvider>{node}</I18nProvider>,
);

describe('Pi turn assistant chrome', () => {
  test('renders one accessible waiting header with the snapshot model and busy dots', () => {
    const markup = renderChrome(
      <PiTurnAssistantChrome
        turn={turn()}
        waiting={{ model: { id: 'snapshot-model', provider: 'snapshot-provider' } }}
      />,
    );
    expect(markup.match(/<header/g)).toHaveLength(1);
    expect(markup).toContain('role="status"');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain('snapshot-provider/snapshot-model');
    expect(markup.match(/animate-busy-pulse/g)).toHaveLength(3);
  });

  test('lets the real live assistant model take over without adding a second header', () => {
    const markup = renderChrome(
      <PiTurnAssistantChrome
        turn={turn(assistant('pending'))}
        waiting={{ model: { id: 'snapshot-model', provider: 'snapshot-provider' } }}
      />,
    );
    expect(markup.match(/<header/g)).toHaveLength(1);
    expect(markup).toContain('runtime-provider/runtime-model');
    expect(markup).not.toContain('snapshot-provider/snapshot-model');
    expect(markup.match(/animate-busy-pulse/g)).toHaveLength(3);
  });

  test('removes the working animation from a completed assistant header', () => {
    const markup = renderChrome(<PiTurnAssistantChrome turn={turn(assistant('stop'))} />);
    expect(markup).not.toContain('role="status"');
    expect(markup).not.toContain('animate-busy-pulse');
  });
});
