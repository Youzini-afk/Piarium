import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Thread, ThreadIntegrationPreview } from '@piarium/protocol';
import { HarnessThreadIntegrationPanel } from './HarnessThreadIntegrationPanel';

vi.mock('@piarium/application-client', () => ({ runtimeFetch: vi.fn() }));
vi.mock('@/components/icon/Icon', () => ({ Icon: () => null }));
vi.mock('@/components/ui', () => ({ toast: { error: vi.fn() } }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/documents/session', () => ({
  getDocumentRegistry: () => ({ surfaceOwner: () => ({ ownerId: 'surface-1', generation: 1 }) }),
}));

import { runtimeFetch } from '@piarium/application-client';

const makeThread = (): Thread => ({
  id: 'thread-1', parent: { kind: 'session', id: 'parent-1' }, workspaceId: 'workspace-1',
  forkPoint: null, brief: 'Implement this change', role: null, model: null,
  manifest: { carryBlocks: true, concurrency: 12, draftBaselineId: null, scope: [], systemPromptFragment: null, tools: ['read'], worktree: 'shared' },
  createdBy: 'agent', kind: 'implementation', worktree: null, lifecycle: 'settled', attention: 'none',
  waitingFor: null, integration: 'dirty', diffStats: null, report: null, activeRunId: null,
  createdAt: '2026-09-10T00:00:00.000Z', updatedAt: '2026-09-10T00:00:00.000Z', eventSeq: 1, hidden: false,
  resultRevision: 1,
});

const makePreview = (revision: number, unavailablePaths: string[] = []): ThreadIntegrationPreview => ({
  operationId: `operation-${revision}`, threadId: 'thread-1', resultRevision: revision,
  bindingFingerprint: `binding-${revision}`, binding: {}, paths: [], surfaceTargetPaths: [], unavailablePaths,
  conflictPaths: [], appliedPaths: [],
  valid: true, mergeReady: unavailablePaths.length === 0,
});

type Request = { url: string; init?: RequestInit; resolve: (response: Response) => void };
let root: Root;
let container: HTMLElement;
let requests: Request[];
let updateThread: React.Dispatch<React.SetStateAction<Thread>>;

const Parent = () => {
  const [thread, setThread] = React.useState(makeThread);
  updateThread = setThread;
  // The production parent passes an inline callback too. Use real React state,
  // effects and reconciliation so response-driven rerenders exercise this edge.
  return <HarnessThreadIntegrationPanel workspaceId="workspace-1" parentSessionId="parent-1"
    entry={{ thread, activeRun: null }} onThread={(next) => setThread(next)} />;
};

const answer = async (index: number, thread: Thread, preview = makePreview(thread.resultRevision!)) => {
  await act(async () => {
    requests[index]!.resolve(new Response(JSON.stringify({ thread, preview }), { status: 200 }));
  });
};

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
  requests = [];
  vi.mocked(runtimeFetch).mockImplementation((url, init) => new Promise<Response>((resolve) => {
    requests.push({ url: String(url), ...(init ? { init } : {}), resolve });
  }));
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('thread integration mounted behavior', () => {
  it('does not reload because its preview response or an unrelated Thread event rerenders the parent', async () => {
    await act(async () => root.render(<Parent />));
    expect(requests).toHaveLength(1);
    await answer(0, { ...makeThread(), eventSeq: 2 });
    expect(requests).toHaveLength(1);
    await act(async () => updateThread((thread) => ({ ...thread, eventSeq: 3, brief: 'Updated report' })));
    expect(requests).toHaveLength(1);
    await act(async () => updateThread((thread) => ({ ...thread, eventSeq: 4, resultRevision: 2 })));
    expect(requests).toHaveLength(2);
    expect(JSON.parse(String(requests[1]!.init?.body))).toMatchObject({ resultRevision: 2 });
  });

  it('ignores a late response from the prior result after the current preview has arrived', async () => {
    await act(async () => root.render(<Parent />));
    await act(async () => updateThread((thread) => ({ ...thread, eventSeq: 2, resultRevision: 2 })));
    expect(requests).toHaveLength(2);
    expect(requests[0]!.init?.signal?.aborted).toBe(true);
    const current = { ...makeThread(), eventSeq: 2, resultRevision: 2 };
    await answer(1, current, makePreview(2, ['current-result.ts']));
    await answer(0, makeThread(), makePreview(1, ['stale-result.ts']));
    expect(container.textContent).toContain('current-result.ts');
    expect(container.textContent).not.toContain('stale-result.ts');
  });

  it('submits the reviewed binding with a chosen conflict resolution', async () => {
    await act(async () => root.render(<Parent />));
    const preview = makePreview(1);
    preview.mergeReady = false;
    preview.conflictPaths = ['a.ts'];
    preview.binding = { 'a.ts': { target: 'disk', revision: 'parent-reviewed' } };
    preview.paths = [{ path: 'a.ts', target: 'disk', decision: 'conflict', phase: 'pending', isText: false }];
    await answer(0, makeThread(), preview);
    const button = (key: string) => [...container.querySelectorAll('button')].find((entry) => entry.textContent === key)!;
    expect(button('harness.threads.merge').disabled).toBe(true);
    await act(async () => button('harness.threads.chooseChild').click());
    await act(async () => button('harness.threads.merge').click());
    expect(requests).toHaveLength(2);
    expect(requests[1]!.url).toMatch(/\/merge$/);
    expect(JSON.parse(String(requests[1]!.init?.body))).toEqual({
      resultRevision: 1,
      expectedBindingFingerprint: 'binding-1',
      sourceOwner: { ownerId: 'surface-1', generation: 1 },
      resolutions: [{ path: 'a.ts', choice: 'child', expectedParentRevision: 'parent-reviewed' }],
    });
  });
});
