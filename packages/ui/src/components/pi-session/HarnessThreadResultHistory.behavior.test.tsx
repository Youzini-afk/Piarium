import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runtimeFetch } from '@piarium/application-client';
import { HarnessThreadResultHistory } from './HarnessThreadResultHistory';

const mocks = vi.hoisted(() => ({
  translate: (key: string) => key,
  error: vi.fn(),
}));

vi.mock('@piarium/application-client', () => ({ runtimeFetch: vi.fn() }));
vi.mock('@/components/icon/Icon', () => ({ Icon: () => null }));
vi.mock('@/components/ui', () => ({ toast: { error: mocks.error } }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: mocks.translate }) }));
vi.mock('@/components/ui/checkbox', () => ({
  Checkbox: ({ checked, onChange, disabled, ariaLabel }: { checked: boolean; onChange: (checked: boolean) => void; disabled?: boolean; ariaLabel?: string }) => (
    <input type="checkbox" role="checkbox" checked={checked} disabled={disabled} aria-label={ariaLabel} onChange={(event) => onChange(event.currentTarget.checked)} />
  ),
}));
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) => open ? <div role="dialog">{children}</div> : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}));

type Request = { url: string; init?: RequestInit; resolve: (response: Response) => void };
let root: Root;
let container: HTMLElement;
let requests: Request[];

const history = {
  workspaceId: 'workspace-1',
  threadId: 'thread-1',
  branchId: 'branch-a',
  results: [
    {
      resultRevision: 1,
      createdAt: '2026-09-10T00:00:00.000Z',
      changedPaths: ['protected.ts'],
      retainedBytes: 12,
      protectedReasons: ['current-result'],
    },
    {
      resultRevision: 2,
      createdAt: '2026-09-10T00:01:00.000Z',
      changedPaths: ['old.ts'],
      retainedBytes: 20,
      protectedReasons: [],
    },
  ],
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

const render = async (parentSessionId = 'parent-1') => {
  await act(async () => root.render(
    <HarnessThreadResultHistory parentSessionId={parentSessionId} threadId="thread-1" />,
  ));
};

const button = (text: string) => [...container.querySelectorAll('button')].find((entry) => entry.textContent === text)!;

const selectResultTwo = async () => {
  const selectable = container.querySelectorAll<HTMLInputElement>('[role="checkbox"][aria-label="harness.threads.history.select"]')[1]!;
  await act(async () => {
    selectable.checked = true;
    selectable.dispatchEvent(new window.Event('input', { bubbles: true }));
    selectable.dispatchEvent(new window.Event('change', { bubbles: true }));
    selectable.dispatchEvent(new window.Event('click', { bubbles: true }));
  });
};

describe('thread result history behavior', () => {
  it('loads on demand, disables protected results, and freezes branch and revisions at confirmation', async () => {
    await render();
    expect(requests).toHaveLength(0);

    await act(async () => button('harness.threads.history.open').click());
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe('/api/harness/sessions/parent-1/threads/thread-1/history');
    await act(async () => requests[0]!.resolve(new Response(JSON.stringify(history))));

    const protectedCheckbox = container.querySelector<HTMLElement>('[role="checkbox"][aria-label="harness.threads.history.select"]');
    expect((protectedCheckbox as HTMLInputElement | null)?.disabled).toBe(true);
    await selectResultTwo();
    await act(async () => button('harness.threads.history.release').click());
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();

    await act(async () => button('harness.threads.history.confirm').click());
    expect(requests).toHaveLength(2);
    expect(requests[1]!.url).toBe('/api/harness/sessions/parent-1/threads/thread-1/history/release');
    expect(JSON.parse(String(requests[1]!.init?.body))).toEqual({ branchId: 'branch-a', resultRevisions: [2] });
  });

  it('keeps cleanup failure visible after references are released and allows retrying the frozen request', async () => {
    await render();
    await act(async () => button('harness.threads.history.open').click());
    await act(async () => requests[0]!.resolve(new Response(JSON.stringify(history))));
    await selectResultTwo();
    await act(async () => button('harness.threads.history.release').click());
    await act(async () => button('harness.threads.history.confirm').click());
    await act(async () => requests[1]!.resolve(new Response(JSON.stringify({
      releasedRevisions: [2], missingRevisions: [], cleanup: { status: 'failed', message: 'disk busy' },
    }))));
    expect(container.textContent).toContain('harness.threads.history.cleanupFailed');
    expect(container.textContent).not.toContain('harness.threads.history.cleanupComplete');
    expect(container.textContent).not.toContain('old.ts');
    expect(button('harness.threads.history.retryCleanup')).toBeTruthy();

    await act(async () => button('harness.threads.history.open').click());
    await act(async () => button('harness.threads.history.open').click());
    expect(requests).toHaveLength(3);
    await act(async () => requests[2]!.resolve(new Response(JSON.stringify({ ...history, results: [history.results[0]] }))));
    expect(container.textContent).toContain('harness.threads.history.cleanupFailed');
    expect(container.textContent).not.toContain('old.ts');

    await act(async () => button('harness.threads.history.retryCleanup').click());
    await act(async () => button('harness.threads.history.confirm').click());
    expect(requests).toHaveLength(4);
    expect(JSON.parse(String(requests[3]!.init?.body))).toEqual({ branchId: 'branch-a', resultRevisions: [2] });
    await act(async () => requests[3]!.resolve(new Response(JSON.stringify({
      releasedRevisions: [], missingRevisions: [2], cleanup: { status: 'complete', objectsDeleted: 0, byteLengthReclaimed: 0 },
    }))));
    expect(container.textContent).toContain('harness.threads.history.cleanupComplete');
  });

  it('surfaces a whole-batch branch conflict without claiming any release', async () => {
    await render();
    await act(async () => button('harness.threads.history.open').click());
    await act(async () => requests[0]!.resolve(new Response(JSON.stringify(history))));
    await selectResultTwo();
    await act(async () => button('harness.threads.history.release').click());
    await act(async () => button('harness.threads.history.confirm').click());
    await act(async () => requests[1]!.resolve(new Response(JSON.stringify({ error: 'branch changed' }), { status: 409 })));
    expect(mocks.error).toHaveBeenCalledWith('branch changed');
    expect(container.textContent).toContain('branch changed');
    expect(container.textContent).not.toContain('harness.threads.history.released');
  });

  it('aborts and ignores a history response when the target changes', async () => {
    await render('parent-a');
    await act(async () => button('harness.threads.history.open').click());
    const stale = requests[0]!;
    await render('parent-b');
    expect(stale.init?.signal?.aborted).toBe(true);
    await act(async () => stale.resolve(new Response(JSON.stringify({ ...history, threadId: 'thread-1', branchId: 'stale-branch' }))));
    expect(container.textContent).not.toContain('stale-branch');
    expect(requests).toHaveLength(1);
  });

  it('ignores a late release response after switching to another target', async () => {
    await render('parent-a');
    await act(async () => button('harness.threads.history.open').click());
    await act(async () => requests[0]!.resolve(new Response(JSON.stringify(history))));
    await selectResultTwo();
    await act(async () => button('harness.threads.history.release').click());
    await act(async () => button('harness.threads.history.confirm').click());
    expect(requests).toHaveLength(2);

    await render('parent-b');
    await act(async () => requests[1]!.resolve(new Response(JSON.stringify({
      releasedRevisions: [2], missingRevisions: [], cleanup: { status: 'failed', message: 'late stale cleanup' },
    }))));
    expect(container.textContent).not.toContain('harness.threads.history.cleanupFailed');

    await act(async () => button('harness.threads.history.open').click());
    await act(async () => requests[2]!.resolve(new Response(JSON.stringify({
      ...history, branchId: 'branch-b', results: [{ ...history.results[0], changedPaths: ['current-b.ts'] }],
    }))));
    expect(container.textContent).toContain('current-b.ts');
    expect(container.textContent).not.toContain('late stale cleanup');
  });
});
