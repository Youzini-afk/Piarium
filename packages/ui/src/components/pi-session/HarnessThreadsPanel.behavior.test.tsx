import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runtimeFetch } from '@piarium/application-client';
import { toast } from '@/components/ui';
import { HarnessThreadsPanel } from './HarnessThreadsPanel';
import { HarnessThreadStateContext, type HarnessThreadStateValue } from './HarnessThreadStateContext';
import type { SessionEntriesResult } from '@piarium/protocol';
import type { HarnessThreadSnapshot } from './harnessThreadPresentation';

const mocks = vi.hoisted(() => ({ openSession: vi.fn(), prefetchSession: vi.fn(), timeline: vi.fn(), translate: (key: string) => key }));
vi.mock('@piarium/application-client', () => ({ runtimeFetch: vi.fn() }));
vi.mock('@/components/icon/Icon', () => ({ Icon: () => null }));
vi.mock('@/components/ui', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: mocks.translate }) }));
vi.mock('@/lib/piariumEvents', () => ({ subscribePiariumEvents: () => () => {} }));
vi.mock('@/stores/usePiSessionStore', () => ({
  usePiSessionStore: (select: (state: typeof mocks) => unknown) => select(mocks),
}));
vi.mock('@/stores/useWebSourcesStore', () => ({
  useWebSources: () => [],
  useWebSourcesStore: () => () => {},
}));
vi.mock('./HarnessKnowledgeReviewSection', () => ({ HarnessKnowledgeReviewSection: () => null }));
vi.mock('./HarnessSessionStateTrigger', () => ({ HarnessSessionStateTrigger: () => null }));
vi.mock('./HarnessThreadIntegrationPanel', () => ({ HarnessThreadIntegrationPanel: () => null }));
vi.mock('@/components/ui/MobileOverlayPanel', () => ({ MobileOverlayPanel: () => null }));
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) => open ? <div role="dialog">{children}</div> : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
}));
vi.mock('./PiTimeline', () => ({ PiTimeline: (props: { entries: unknown[] }) => {
  mocks.timeline(props); return <div data-testid="transcript">{JSON.stringify(props.entries)}</div>;
} }));


const snapshot = (): HarnessThreadSnapshot => ({
  thread: {
    id: 'thread-1', parent: { kind: 'session', id: 'parent-1' }, workspaceId: 'workspace-1',
    forkPoint: null, brief: 'Continue the implementation', preset: null, model: null,
    manifest: { carryBlocks: true, concurrency: 12, draftBaselineId: null, scope: ['src'], systemPromptFragment: null, tools: ['read'], worktree: 'isolated' },
    createdBy: 'agent', kind: 'implementation', lifecycle: 'settled', attention: 'none',
    worktree: { path: '/old-cwd', base: 'base', materialized: false },
    waitingFor: null, integration: 'none', diffStats: null, report: null, activeRunId: 'run-1',
    createdAt: '2026-09-10T00:00:00.000Z', updatedAt: '2026-09-10T00:00:00.000Z', eventSeq: 1, hidden: false,
  },
  activeRun: {
    id: 'run-1', threadId: 'thread-1', attempt: 1, runtimeId: 'runtime-1', sessionId: 'old-session',
    workerState: 'exited', outcome: 'success', exitReason: null, tokens: { input: 0, output: 0, cacheRead: 0 },
    costUsd: null, steps: 1, lastToolCall: null, startedAt: '2026-09-10T00:00:00.000Z',
    lastActivityAt: '2026-09-10T00:00:00.000Z', endedAt: '2026-09-10T00:00:00.000Z',
  },
});

let root: Root;
let container: HTMLElement;
let state: HarnessThreadStateValue;
let finishPreview: (result: SessionEntriesResult) => void;
let failPreview: (error: Error) => void;

beforeEach(() => {
  const dom = parseHTML('<!doctype html><html><body></body></html>');
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.document);
  vi.stubGlobal('HTMLElement', dom.HTMLElement);
  vi.stubGlobal('Node', dom.Node);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  state = {
    workspaceId: 'workspace-1', parent: { kind: 'session', id: 'parent-1' },
    includeArchived: false, setIncludeArchived: vi.fn(), merge: vi.fn(), reload: vi.fn(async () => {}),
    threads: [snapshot()],
  };
  mocks.openSession.mockResolvedValue(undefined);
  mocks.prefetchSession.mockImplementation(() => new Promise<SessionEntriesResult>((resolve, reject) => {
    finishPreview = resolve; failPreview = reject;
  }));
  vi.mocked(runtimeFetch).mockResolvedValue(new Response(null, { status: 404 }));
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const clickOpen = async () => {
  await act(async () => root.render(
    <HarnessThreadStateContext.Provider value={state}>
      <HarnessThreadsPanel workspaceId="workspace-1" parentSessionId="parent-1" fallbackCwd="/parent" />
    </HarnessThreadStateContext.Provider>,
  ));
  const button = container.querySelector<HTMLButtonElement>('button[title="harness.threads.transcript"]')!;
  await act(async () => button.click());
  return button;
};

describe('thread panel transcript is inspection, not execution', () => {
  for (const lifecycle of ['settled', 'archived'] as const) {
    it(`reads ${lifecycle} history without restoring a directory, opening a worker or starting a Run`, async () => {
      state.threads[0]!.thread.lifecycle = lifecycle;
      const button = await clickOpen();
      expect(mocks.prefetchSession).toHaveBeenCalledExactlyOnceWith('old-session');
      expect(button.disabled).toBe(true);
      const result: SessionEntriesResult = { sessionId: 'old-session', scope: 'branch', leafId: 'old-entry', entries: [{
        id: 'old-entry', parentId: null, timestamp: '2026-09-10T00:00:00.000Z', type: 'message',
        message: { role: 'user', content: 'PERSISTED_TRANSCRIPT_BODY', timestamp: 0 },
      }] };
      await act(async () => { finishPreview(result); });
      expect(container.textContent).toContain('PERSISTED_TRANSCRIPT_BODY');
      expect(container.textContent).toContain('harness.threads.transcriptReadOnly');
      expect(mocks.timeline).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'old-session', entries: result.entries }));
      expect(mocks.openSession).not.toHaveBeenCalled();
      expect(state.merge).not.toHaveBeenCalled();
      expect(state.reload).not.toHaveBeenCalled();
      expect(vi.mocked(runtimeFetch).mock.calls.filter(([, init]) => init?.method === 'POST')).toEqual([]);
      expect(state.threads[0]!.activeRun?.id).toBe('run-1');
    });
  }

  it('reports a missing transcript without converting the read into a restore', async () => {
    await clickOpen();
    await act(async () => { failPreview(new Error('Native transcript is unavailable')); });
    expect(toast.error).toHaveBeenCalledExactlyOnceWith('Native transcript is unavailable');
    expect(mocks.openSession).not.toHaveBeenCalled();
    expect(vi.mocked(runtimeFetch).mock.calls.filter(([, init]) => init?.method === 'POST')).toEqual([]);
  });
});
