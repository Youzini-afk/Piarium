import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

mock.module('@piarium/application-client', () => ({
  getRuntimeUrlResolver: () => ({ sse: (path: string) => `http://runtime.test${path}` }),
  subscribeRuntimeEndpointChanged: () => () => undefined,
}));

class MockEventSource {
  static CLOSED = 2;
  static instances: MockEventSource[] = [];

  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(public readonly url: string) {
    MockEventSource.instances.push(this);
  }

  close() {
    this.readyState = MockEventSource.CLOSED;
  }
}

describe('Piarium events', () => {
  beforeEach(() => {
    MockEventSource.instances = [];
    globalThis.window = {
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    } as unknown as Window & typeof globalThis;
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
  });

  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
    delete (globalThis as { EventSource?: unknown }).EventSource;
  });

  test('dispatches externally created session events', async () => {
    const { subscribePiariumEvents } = await import('./piariumEvents');
    const events: unknown[] = [];
    const listener = (event: unknown) => events.push(event);
    const unsubscribe = subscribePiariumEvents(listener);
    const source = MockEventSource.instances[0];

    source.onmessage?.({
      data: JSON.stringify({
        type: 'piarium:session-created',
        properties: {
          sessionId: 'ses_123',
          directory: '/repo/worktrees/research',
          projectId: 'project_1',
          createdAt: 123,
          promptDispatched: true,
          dispatchedAsCommand: false,
        },
      }),
    });
    expect(events).toEqual([
      {
        type: 'session-created',
        sessionId: 'ses_123',
        directory: '/repo/worktrees/research',
        projectId: 'project_1',
        createdAt: 123,
        promptDispatched: true,
        dispatchedAsCommand: false,
      },
    ]);
    unsubscribe();
  });

  test('dispatches stream readiness and typed harness thread changes', async () => {
    const { subscribePiariumEvents } = await import('./piariumEvents');
    const events: unknown[] = [];
    const unsubscribe = subscribePiariumEvents((event) => events.push(event));
    const source = MockEventSource.instances[0];

    source.onmessage?.({
      data: JSON.stringify({ type: 'piarium:event-stream-ready', properties: {} }),
    });
    source.onmessage?.({
      data: JSON.stringify({
        type: 'piarium:harness-thread-changed',
        properties: {
          workspaceId: 'workspace-1',
          parent: { kind: 'session', id: 'parent-1' },
          thread: { id: 'thread-1', workspaceId: 'workspace-1', eventSeq: 3 },
          activeRun: { id: 'run-1', workerState: 'running' },
        },
      }),
    });
    source.onmessage?.({
      data: JSON.stringify({
        type: 'piarium:harness-blocks-changed',
        properties: { workspaceId: 'workspace-1', sessionId: 'parent-1' },
      }),
    });

    expect(events).toEqual([
      { type: 'stream-ready' },
      {
        type: 'harness-thread-changed',
        workspaceId: 'workspace-1',
        parent: { kind: 'session', id: 'parent-1' },
        thread: { id: 'thread-1', workspaceId: 'workspace-1', eventSeq: 3 },
        activeRun: { id: 'run-1', workerState: 'running' },
      },
      { type: 'harness-blocks-changed', workspaceId: 'workspace-1', sessionId: 'parent-1' },
    ]);
    unsubscribe();
  });
});
