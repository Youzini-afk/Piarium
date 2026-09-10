import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runtimeFetch } from '@piarium/application-client';
import { toast } from '@/components/ui';
import { HarnessThreadsPanel } from './HarnessThreadsPanel';
import { HarnessThreadStateContext, type HarnessThreadStateValue } from './HarnessThreadStateContext';
import type { HarnessThreadSnapshot } from './harnessThreadPresentation';

const mocks = vi.hoisted(() => ({ openSession: vi.fn(), translate: (key: string) => key }));
vi.mock('@piarium/application-client', () => ({ runtimeFetch: vi.fn() }));
vi.mock('@/components/icon/Icon', () => ({ Icon: () => null }));
vi.mock('@/components/ui', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: mocks.translate }) }));
vi.mock('@/lib/piariumEvents', () => ({ subscribePiariumEvents: () => () => {} }));
vi.mock('@/stores/usePiSessionStore', () => ({
  usePiSessionStore: (select: (state: { openSession: typeof mocks.openSession }) => unknown) => select(mocks),
}));
vi.mock('@/stores/useWebSourcesStore', () => ({
  useWebSources: () => [],
  useWebSourcesStore: () => () => {},
}));
vi.mock('./HarnessKnowledgeReviewSection', () => ({ HarnessKnowledgeReviewSection: () => null }));
vi.mock('./HarnessSessionStateTrigger', () => ({ HarnessSessionStateTrigger: () => null }));
vi.mock('./HarnessThreadIntegrationPanel', () => ({ HarnessThreadIntegrationPanel: () => null }));
vi.mock('@/components/ui/MobileOverlayPanel', () => ({ MobileOverlayPanel: () => null }));

const snapshot = (): HarnessThreadSnapshot => ({
  thread: {
    id: 'thread-1', parent: { kind: 'session', id: 'parent-1' }, workspaceId: 'workspace-1',
    forkPoint: null, brief: 'Continue the implementation', role: null, model: null,
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
let restoreRequests: { url: string; resolve: (response: Response) => void }[];

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
  restoreRequests = [];
  mocks.openSession.mockResolvedValue(undefined);
  vi.mocked(runtimeFetch).mockImplementation((url, init) => {
    if (init?.method === 'POST' && String(url).endsWith('/restore')) {
      return new Promise<Response>((resolve) => restoreRequests.push({ url: String(url), resolve }));
    }
    return Promise.resolve(new Response(null, { status: 404 }));
  });
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
  const button = container.querySelector<HTMLButtonElement>('button[title="harness.threads.open"]')!;
  await act(async () => button.click());
  return button;
};

describe('thread panel open after reclamation', () => {
  it('waits for Host restoration and opens the returned Run and directory instead of stale card metadata', async () => {
    const button = await clickOpen();
    expect(restoreRequests.map(({ url }) => url)).toEqual(['/api/harness/sessions/parent-1/threads/thread-1/restore']);
    expect(mocks.openSession).not.toHaveBeenCalled();
    expect(button.disabled).toBe(true);
    const restored = snapshot();
    restored.thread.lifecycle = 'active';
    restored.thread.activeRunId = 'run-2';
    restored.thread.worktree = { path: '/restored-cwd', base: 'base', materialized: true, preparationStage: 'ready' };
    restored.activeRun = { ...restored.activeRun!, id: 'run-2', sessionId: 'restored-session', attempt: 2, workerState: 'running', outcome: null, endedAt: null };
    await act(async () => restoreRequests[0]!.resolve(new Response(JSON.stringify({
      ...restored, workspaceId: 'workspace-1', parent: state.parent, restoreStatus: 'restored',
    }))));
    expect(mocks.openSession).toHaveBeenCalledExactlyOnceWith({
      sessionId: 'restored-session', cwd: '/restored-cwd', scope: ['src'], tools: ['read'],
    });
    expect(state.merge).toHaveBeenCalledWith(expect.objectContaining(restored));
    expect(state.reload).toHaveBeenCalledOnce();
  });

  it('keeps the projected failure visible and never opens a session when the original path is occupied', async () => {
    await clickOpen();
    const unchanged = snapshot();
    await act(async () => restoreRequests[0]!.resolve(new Response(JSON.stringify({
      ...unchanged, workspaceId: 'workspace-1', parent: state.parent,
      restoreStatus: 'path-occupied', message: 'The original path now contains user files.',
    }))));
    expect(mocks.openSession).not.toHaveBeenCalled();
    expect(state.merge).toHaveBeenCalledWith(expect.objectContaining(unchanged));
    expect(toast.error).toHaveBeenCalledExactlyOnceWith('The original path now contains user files.');
  });
});
