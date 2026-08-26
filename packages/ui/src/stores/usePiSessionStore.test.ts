import { describe, expect, test } from 'bun:test';
import { subscribePiRuntimeCatalogChanged } from '@/lib/pi-runtime/catalog-events';
import {
  PIARIUM_PROTOCOL_VERSION,
  type PiAgentEvent,
  type PiAssistantMessage,
  type PiSessionEntry,
  type RecoveryStatus,
  type RuntimeEventEnvelope,
  type RuntimeMethod,
  type RuntimeMethodParams,
  type SessionEntriesResult,
  type SessionSnapshot,
  type SessionStats,
  type SessionSummary,
} from '@piarium/protocol';
import {
  createPiSessionStore,
  reducePiAgentEvent,
  selectActivePiSessions,
  selectArchivedPiSessions,
  type PiSessionRuntimeClient,
  type PiSessionStoreRuntime,
} from './usePiSessionStore';

const snapshot = (sessionId: string, cwd = 'D:/work'): SessionSnapshot => ({
  activeTools: [],
  busy: false,
  cwd,
  features: { pinnedContext: [], revision: 0, schemaVersion: 1 },
  followUp: [],
  followUpMode: 'all',
  isCompacting: false,
  isStreaming: false,
  leafId: null,
  pendingMessageCount: 0,
  retryAttempt: 0,
  sessionId,
  steering: [],
  steeringMode: 'all',
  thinkingLevel: 'medium',
});

const summary = (
  id: string,
  updatedAt: string,
  archivedAt?: string,
): SessionSummary => ({
  allMessagesText: '',
  ...(archivedAt === undefined ? {} : { archivedAt }),
  createdAt: '2026-08-02T00:00:00.000Z',
  cwd: 'D:/work',
  firstMessage: '',
  id,
  messageCount: 0,
  persisted: true,
  sessionFile: `D:/agent/sessions/${id}.jsonl`,
  updatedAt,
});

const assistant = (
  text: string,
  stopReason: PiAssistantMessage['stopReason'] = 'pending',
): PiAssistantMessage => ({
  api: 'messages',
  content: [{ text, type: 'text' }],
  model: 'model',
  provider: 'provider',
  role: 'assistant',
  stopReason,
  timestamp: 1,
  usage: {
    cacheRead: 0,
    cacheWrite: 0,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
    input: 0,
    output: 0,
    totalTokens: 0,
  },
});

const branch = (sessionId: string, entries: PiSessionEntry[] = []): SessionEntriesResult => ({
  entries,
  leafId: entries.at(-1)?.id ?? null,
  scope: 'branch',
  sessionId,
});

const allEntries = (sessionId: string, entries: PiSessionEntry[] = []): SessionEntriesResult => ({
  entries,
  leafId: entries.at(-1)?.id ?? null,
  scope: 'all',
  sessionId,
});

const recoveryStatus: RecoveryStatus = {
  actions: ['navigate', 'undo'],
  available: true,
  issues: [],
  modes: ['conversation'],
  providers: [],
};

const stats = (sessionId: string, tokens = 1200): SessionStats => ({
  assistantMessages: 1,
  contextUsage: { contextWindow: 200000, percent: 0.6, tokens },
  cost: 0.01,
  sessionId,
  tokens: {
    cacheRead: 0,
    cacheWrite: 0,
    input: tokens,
    output: 0,
    total: tokens,
  },
  toolCalls: 0,
  toolResults: 0,
  totalMessages: 2,
  userMessages: 1,
});

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
};

const flushAsync = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

class FakeRuntime implements PiSessionStoreRuntime {
  key = 'runtime-a';
  readonly calls: Array<{ method: RuntimeMethod; params: unknown }> = [];
  readonly #changedListeners = new Set<() => void>();
  readonly #eventListeners = new Set<(event: RuntimeEventEnvelope) => void>();
  handler: (method: RuntimeMethod, params: unknown) => unknown | Promise<unknown> = () => {
    throw new Error('Unhandled fake runtime request');
  };

  readonly client: PiSessionRuntimeClient = {
    request: (async <M extends RuntimeMethod>(method: M, params: RuntimeMethodParams<M>) => {
      this.calls.push({ method, params });
      return this.handler(method, params) as never;
    }) as PiSessionRuntimeClient['request'],
    subscribe: (listener) => {
      this.#eventListeners.add(listener);
      return () => this.#eventListeners.delete(listener);
    },
  };

  async connect() {
    return { client: this.client, runtimeKey: this.key };
  }

  currentKey() {
    return this.key;
  }

  emit<E extends RuntimeEventEnvelope>(event: E) {
    for (const listener of this.#eventListeners) listener(event);
  }

  event(event: RuntimeEventEnvelope['event'], data: RuntimeEventEnvelope['data'], sessionId?: string) {
    this.emit({
      data,
      event,
      kind: 'event',
      seq: 1,
      source: {
        role: sessionId === undefined ? 'catalog' : 'session',
        ...(sessionId === undefined ? {} : { sessionId }),
        workerId: sessionId ?? 'catalog',
      },
      v: PIARIUM_PROTOCOL_VERSION,
    } as RuntimeEventEnvelope);
  }

  subscribeChanged(listener: () => void) {
    this.#changedListeners.add(listener);
    return () => this.#changedListeners.delete(listener);
  }

  switchTo(key: string) {
    this.key = key;
    for (const listener of this.#changedListeners) listener();
  }
}

describe('Pi session event state', () => {
  test('keeps Pi entries and streaming tool state without OpenCode message IDs', () => {
    const sessionId = 'session-a';
    const initial = {
      branchEntries: branch(sessionId),
      extensionStates: {},
      open: true,
      sessionId,
      snapshot: snapshot(sessionId),
      toolExecutions: {},
    };
    const streaming = reducePiAgentEvent(initial, {
      message: assistant('streaming'),
      type: 'message_update',
      update: { contentIndex: 0, delta: 'streaming', type: 'text_delta' },
    });
    expect(streaming.liveAssistant?.content[0]).toEqual({ text: 'streaming', type: 'text' });

    const running = reducePiAgentEvent(streaming, {
      args: { path: 'README.md' },
      toolCallId: 'tool-1',
      toolName: 'read',
      type: 'tool_execution_start',
    });
    const updated = reducePiAgentEvent(running, {
      args: { path: 'README.md' },
      partialResult: { text: 'partial' },
      toolCallId: 'tool-1',
      toolName: 'read',
      type: 'tool_execution_update',
    });
    expect(updated.toolExecutions['tool-1']?.partialResult).toEqual({ text: 'partial' });

    const entry: PiSessionEntry = {
      id: 'entry-a',
      message: assistant('done'),
      parentId: null,
      timestamp: '2026-08-02T00:00:00.000Z',
      type: 'message',
    };
    const persisted = reducePiAgentEvent(updated, { entry, type: 'entry_appended' });
    expect(persisted.branchEntries?.entries.map((candidate) => candidate.id)).toEqual(['entry-a']);
    expect(persisted.liveAssistant).toBeUndefined();
  });

  test('does not restore a persisted assistant when message_end arrives after entry_appended', () => {
    const sessionId = 'session-a';
    const message = assistant('done', 'stop');
    const entry: PiSessionEntry = {
      id: 'entry-a',
      message,
      parentId: null,
      timestamp: '2026-08-02T00:00:00.000Z',
      type: 'message',
    };
    const initial = {
      branchEntries: branch(sessionId),
      extensionStates: {},
      open: true,
      sessionId,
      snapshot: snapshot(sessionId),
      toolExecutions: {},
    };
    const persisted = reducePiAgentEvent(initial, { entry, type: 'entry_appended' });
    const ended = reducePiAgentEvent(persisted, { message: { ...message }, type: 'message_end' });

    expect(ended.branchEntries?.entries).toHaveLength(1);
    expect(ended.liveAssistant).toBeUndefined();
  });

  test('projects an accepted user message until its session entry is appended', () => {
    const sessionId = 'session-a';
    const initial = {
      branchEntries: branch(sessionId),
      extensionStates: {},
      open: true,
      sessionId,
      snapshot: snapshot(sessionId),
      toolExecutions: {},
    };
    const message = { content: 'hello', role: 'user' as const, timestamp: 7 };
    const started = reducePiAgentEvent(initial, { message, type: 'message_start' });
    expect(started.liveUser).toEqual(message);

    const entry: PiSessionEntry = {
      id: 'user-entry',
      message,
      parentId: null,
      timestamp: '2026-08-02T00:00:00.000Z',
      type: 'message',
    };
    const persisted = reducePiAgentEvent(started, { entry, type: 'entry_appended' });
    expect(persisted.liveUser).toBeUndefined();
    expect(persisted.branchEntries?.entries).toEqual([entry]);
  });

  test('projects queue and lifecycle events into the native snapshot', () => {
    const initial = {
      extensionStates: {},
      open: true,
      sessionId: 'session-a',
      snapshot: snapshot('session-a'),
      toolExecutions: {},
    };
    const busy = reducePiAgentEvent(initial, { type: 'agent_start' }, 1_000);
    const repeatedStart = reducePiAgentEvent(busy, { type: 'agent_start' }, 2_000);
    const queued = reducePiAgentEvent(busy, {
      followUp: ['later'],
      steering: ['now'],
      type: 'queue_update',
    });
    const settled = reducePiAgentEvent(queued, { type: 'agent_settled' }, 5_500);
    expect(repeatedStart.activityStartedAt).toBe(1_000);
    expect(queued.snapshot?.followUp).toEqual(['later']);
    expect(queued.snapshot?.steering).toEqual(['now']);
    expect(settled.snapshot?.busy).toBe(false);
    expect(settled.activityStartedAt).toBeUndefined();
    expect(settled.settledActivityDurationMs).toBe(4_500);
  });

  test('reconciles an optimistic submission only when Pi projects its user message', () => {
    const sessionId = 'session-a';
    const existingEntry: PiSessionEntry = {
      id: 'existing-user',
      message: { content: 'older', role: 'user', timestamp: 1 },
      parentId: null,
      timestamp: '2026-08-02T00:00:00.000Z',
      type: 'message',
    };
    const initial = {
      branchEntries: branch(sessionId, [existingEntry]),
      extensionStates: {},
      open: true,
      sessionId,
      submission: {
        entryIdsAtSubmit: new Set([existingEntry.id]),
        id: 'submission-a',
        message: { content: 'new', role: 'user' as const, timestamp: 2 },
        mode: 'prompt' as const,
        status: 'dispatching' as const,
      },
      toolExecutions: {},
    };

    const repeated = reducePiAgentEvent(initial, { entry: existingEntry, type: 'entry_appended' });
    expect(repeated.submission?.id).toBe('submission-a');

    const appended: PiSessionEntry = {
      id: 'new-user',
      message: { content: 'new', role: 'user', timestamp: 3 },
      parentId: existingEntry.id,
      timestamp: '2026-08-02T00:00:01.000Z',
      type: 'message',
    };
    const reconciled = reducePiAgentEvent(repeated, { entry: appended, type: 'entry_appended' });
    expect(reconciled.submission).toBeUndefined();
  });
});

describe('Pi session store', () => {
  test('owns recoverable submission state per Pi session', () => {
    const store = createPiSessionStore(new FakeRuntime());
    store.setState({
      records: {
        'session-a': {
          branchEntries: branch('session-a'),
          extensionStates: {},
          open: true,
          sessionId: 'session-a',
          toolExecutions: {},
        },
      },
    });

    const id = store.getState().beginSubmission(
      'session-a',
      { content: 'hello', role: 'user', timestamp: 1 },
      'prompt',
    );
    expect(store.getState().records['session-a']?.submission?.id).toBe(id);
    expect(store.getState().records['session-a']?.submission?.mode).toBe('prompt');
    expect(store.getState().records['session-a']?.submission?.status).toBe('preparing');

    store.getState().updateSubmission('session-a', id, {
      dispatchedText: 'hello',
      status: 'uncertain',
    });
    expect(store.getState().records['session-a']?.submission?.dispatchedText).toBe('hello');
    expect(store.getState().records['session-a']?.submission?.status).toBe('uncertain');

    const followUpId = store.getState().beginSubmission(
      'session-a',
      { content: 'later', role: 'user', timestamp: 2 },
      'followUp',
    );
    store.getState().updateSubmission('session-a', followUpId, { status: 'accepted' });
    expect(store.getState().records['session-a']?.submission).toBeUndefined();
  });

  test('ignores a stale submission completion after the runtime record is reset', () => {
    const store = createPiSessionStore(new FakeRuntime());
    const id = store.getState().beginSubmission(
      'session-a',
      { content: 'hello', role: 'user', timestamp: 1 },
      'prompt',
    );

    store.getState().reset();
    store.getState().updateSubmission('session-a', id, { status: 'failed' });
    store.getState().clearSubmission('session-a', id);

    expect(store.getState().records).toEqual({});
  });

  test('clears the Pi-owned queue through the runtime and snapshot', async () => {
    const runtime = new FakeRuntime();
    runtime.handler = (method) => {
      if (method === 'agent.queue.clear') {
        return { cleared: true, followUp: ['later'], steering: ['now'] };
      }
      throw new Error(`Unexpected ${method}`);
    };
    const store = createPiSessionStore(runtime);
    store.setState({
      records: {
        'session-a': {
          extensionStates: {},
          open: true,
          sessionId: 'session-a',
          snapshot: {
            ...snapshot('session-a'),
            followUp: ['later'],
            pendingMessageCount: 2,
            steering: ['now'],
          },
          toolExecutions: {},
        },
      },
    });

    expect(await store.getState().clearQueue('session-a')).toBe(true);
    expect(runtime.calls).toEqual([{
      method: 'agent.queue.clear',
      params: { sessionId: 'session-a' },
    }]);
    expect(store.getState().records['session-a']?.snapshot?.followUp).toEqual([]);
    expect(store.getState().records['session-a']?.snapshot?.pendingMessageCount).toBe(0);
    expect(store.getState().records['session-a']?.snapshot?.steering).toEqual([]);
  });

  test('loads, sorts, and splits the native catalog', async () => {
    const runtime = new FakeRuntime();
    runtime.handler = (method) => {
      if (method === 'session.list') {
        return [
          summary('older', '2026-08-01T00:00:00.000Z'),
          summary('archived', '2026-08-03T00:00:00.000Z', '2026-08-03T01:00:00.000Z'),
          summary('newer', '2026-08-02T00:00:00.000Z'),
        ];
      }
      throw new Error(`Unexpected ${method}`);
    };
    const store = createPiSessionStore(runtime);

    await store.getState().loadCatalog();

    expect(store.getState().summaries.map((candidate) => candidate.id)).toEqual([
      'archived',
      'newer',
      'older',
    ]);
    expect(selectActivePiSessions(store.getState()).map((candidate) => candidate.id)).toEqual([
      'newer',
      'older',
    ]);
    expect(selectArchivedPiSessions(store.getState()).map((candidate) => candidate.id)).toEqual([
      'archived',
    ]);
  });

  test('forwards the Piarium workspace binding without changing the required cwd', async () => {
    const runtime = new FakeRuntime();
    runtime.handler = (method) => {
      if (method === 'session.create') return {
        ...snapshot('session-a', 'D:/worktree/feature'),
        workspace: { id: 'workspace-a', kind: 'workspace' },
        workspacePersistence: 'pending',
      } satisfies SessionSnapshot;
      if (method === 'session.entries') return branch('session-a');
      if (method === 'recovery.status') return recoveryStatus;
      if (method === 'session.list') return [];
      throw new Error(`Unexpected ${method}`);
    };
    const store = createPiSessionStore(runtime);

    await store.getState().createSession(
      'D:/worktree/feature',
      undefined,
      undefined,
      { id: 'workspace-a', kind: 'workspace' },
    );

    expect(runtime.calls.find((call) => call.method === 'session.create')?.params).toEqual({
      cwd: 'D:/worktree/feature',
      workspace: { id: 'workspace-a', kind: 'workspace' },
    });
    runtime.event('session.snapshot', snapshot('session-a', 'D:/worktree/feature'), 'session-a');
    expect(store.getState().records['session-a']?.snapshot?.workspace).toEqual({
      id: 'workspace-a',
      kind: 'workspace',
    });
    expect(store.getState().records['session-a']?.snapshot?.workspacePersistence).toBe('pending');
  });

  test('keeps derived catalog selector references stable until summaries change', async () => {
    const runtime = new FakeRuntime();
    runtime.handler = (method) => {
      if (method === 'session.list') {
        return [
          summary('active', '2026-08-02T00:00:00.000Z'),
          summary('archived', '2026-08-01T00:00:00.000Z', '2026-08-03T00:00:00.000Z'),
        ];
      }
      throw new Error(`Unexpected ${method}`);
    };
    const store = createPiSessionStore(runtime);
    await store.getState().loadCatalog();

    const active = selectActivePiSessions(store.getState());
    const archived = selectArchivedPiSessions(store.getState());
    expect(selectActivePiSessions(store.getState())).toBe(active);
    expect(selectArchivedPiSessions(store.getState())).toBe(archived);

    store.setState({ catalogLoading: true });
    expect(selectActivePiSessions(store.getState())).toBe(active);
    expect(selectArchivedPiSessions(store.getState())).toBe(archived);

    store.setState({ summaries: [...store.getState().summaries] });
    expect(selectActivePiSessions(store.getState())).not.toBe(active);
    expect(selectArchivedPiSessions(store.getState())).not.toBe(archived);
  });

  test('opens a Pi session, reads the complete branch, and consumes routed events', async () => {
    const runtime = new FakeRuntime();
    runtime.handler = (method, params) => {
      const sessionId = (params as { sessionId?: string }).sessionId ?? 'session-a';
      if (method === 'session.open') return snapshot(sessionId);
      if (method === 'session.entries') return branch(sessionId);
      if (method === 'recovery.status') return recoveryStatus;
      throw new Error(`Unexpected ${method}`);
    };
    const store = createPiSessionStore(runtime);

    await store.getState().openSession({ cwd: 'D:/work', sessionId: 'session-a' });
    await flushAsync();
    runtime.event('agent.event', {
      event: { type: 'agent_start' } satisfies PiAgentEvent,
      sessionId: 'session-a',
    }, 'session-a');
    runtime.event('extension.state', {
      channel: 'pi-mcp-adapter/status/v1',
      sessionId: 'session-a',
      value: { connectedCount: 1, version: 1 },
    }, 'session-a');

    expect(store.getState().currentSessionId).toBe('session-a');
    expect(store.getState().records['session-a']?.branchEntries?.entries).toEqual([]);
    expect(store.getState().records['session-a']?.recoveryStatus?.available).toBe(true);
    expect(store.getState().records['session-a']?.snapshot?.busy).toBe(true);
    expect(store.getState().records['session-a']?.extensionStates['pi-mcp-adapter/status/v1'])
      .toEqual({ connectedCount: 1, version: 1 });

    runtime.event('extension.state', {
      channel: 'pi-mcp-adapter/status/v1',
      sessionId: 'session-a',
      value: null,
    }, 'session-a');
    expect(store.getState().records['session-a']?.extensionStates).toEqual({});
  });

  test('settles live state when the owning session worker exits', async () => {
    const runtime = new FakeRuntime();
    runtime.handler = (method) => {
      if (method === 'session.list') return [];
      throw new Error(`Unexpected ${method}`);
    };
    const store = createPiSessionStore(runtime);
    await store.getState().loadCatalog();
    store.setState({
      records: {
        'session-crashed': {
          activityStartedAt: 0,
          extensionStates: {},
          liveAssistant: assistant('partial'),
          open: true,
          sessionId: 'session-crashed',
          snapshot: { ...snapshot('session-crashed'), busy: true, isStreaming: true },
          toolExecutions: {
            running: {
              args: null,
              name: 'bash',
              status: 'running',
              toolCallId: 'running',
            },
          },
        },
      },
    });

    runtime.event('session.worker.exited', {
      code: 1,
      expected: false,
      sessionId: 'session-crashed',
      signal: null,
    }, 'session-crashed');

    const record = store.getState().records['session-crashed'];
    expect(record?.open).toBe(false);
    expect(record?.snapshot?.busy).toBe(false);
    expect(record?.snapshot?.isStreaming).toBe(false);
    expect(record?.liveAssistant?.stopReason).toBe('error');
    expect(record?.toolExecutions.running?.status).toBe('error');
    expect(record?.activityStartedAt).toBeUndefined();
    expect(record?.settledActivityDurationMs).toBeGreaterThan(0);
    expect(store.getState().attentionBySession['session-crashed']?.kind).toBe('error');
  });

  test('tracks background completion and errors as Pi-native session attention', async () => {
    const runtime = new FakeRuntime();
    runtime.handler = (method) => {
      if (method === 'session.list') return [];
      throw new Error(`Unexpected ${method}`);
    };
    const store = createPiSessionStore(runtime);
    await store.getState().loadCatalog();
    store.getState().setCurrentSession('session-visible');

    runtime.event('agent.event', {
      event: {
        messages: [assistant('done', 'stop')],
        type: 'agent_end',
        willRetry: false,
      } satisfies PiAgentEvent,
      sessionId: 'session-background',
    }, 'session-background');
    runtime.event('agent.event', {
      event: {
        messages: [{ ...assistant('failed', 'error'), errorMessage: 'failed' }],
        type: 'agent_end',
        willRetry: false,
      } satisfies PiAgentEvent,
      sessionId: 'session-error',
    }, 'session-error');
    runtime.event('agent.event', {
      event: {
        messages: [assistant('visible', 'stop')],
        type: 'agent_end',
        willRetry: false,
      } satisfies PiAgentEvent,
      sessionId: 'session-visible',
    }, 'session-visible');

    expect(store.getState().attentionBySession['session-background']?.kind).toBe('complete');
    expect(store.getState().attentionBySession['session-error']?.kind).toBe('error');
    expect(store.getState().attentionBySession['session-visible']).toBeUndefined();

    store.getState().setCurrentSession('session-background');
    expect(store.getState().attentionBySession['session-background']).toBeUndefined();
  });

  test('does not mark retrying or aborted work as attention', async () => {
    const runtime = new FakeRuntime();
    runtime.handler = (method) => {
      if (method === 'session.list') return [];
      throw new Error(`Unexpected ${method}`);
    };
    const store = createPiSessionStore(runtime);
    await store.getState().loadCatalog();

    runtime.event('agent.event', {
      event: {
        messages: [assistant('retrying', 'error')],
        type: 'agent_end',
        willRetry: true,
      } satisfies PiAgentEvent,
      sessionId: 'session-retry',
    }, 'session-retry');
    runtime.event('agent.event', {
      event: {
        messages: [assistant('aborted', 'aborted')],
        type: 'agent_end',
        willRetry: false,
      } satisfies PiAgentEvent,
      sessionId: 'session-aborted',
    }, 'session-aborted');

    expect(store.getState().attentionBySession).toEqual({});
  });

  test('executes extension commands through the active Pi session', async () => {
    const runtime = new FakeRuntime();
    runtime.handler = (method) => {
      if (method === 'command.execute') return { executed: true };
      throw new Error(`Unexpected ${method}`);
    };
    const store = createPiSessionStore(runtime);

    const result = await store.getState().executeCommand('session-a', '/mcp reconnect docs');
    expect(result).toEqual({ executed: true });
    expect(runtime.calls).toEqual([{
      method: 'command.execute',
      params: { command: '/mcp reconnect docs', sessionId: 'session-a' },
    }]);
  });

  test('invalidates command metadata after a successful Pi reload', async () => {
    const runtime = new FakeRuntime();
    runtime.handler = (method) => {
      if (method === 'command.execute') return { executed: true };
      throw new Error(`Unexpected ${method}`);
    };
    const store = createPiSessionStore(runtime);
    const reasons: string[] = [];
    const unsubscribe = subscribePiRuntimeCatalogChanged((reason) => reasons.push(reason));

    try {
      await store.getState().executeCommand('session-a', '/reload');
      expect(reasons).toEqual(['reload']);
    } finally {
      unsubscribe();
    }
  });

  test('applies a Pi-native feature mutation to the live session snapshot', async () => {
    const runtime = new FakeRuntime();
    const features = {
      goal: {
        auditFailStreak: 0,
        blockedStreak: 0,
        createdAt: 1,
        id: 'goal-1',
        objective: 'Finish the native migration',
        status: 'active' as const,
        tokenBaseline: 0,
        tokensUsed: 0,
        turnsUsed: 0,
        updatedAt: 1,
      },
      pinnedContext: [],
      revision: 1,
      schemaVersion: 1 as const,
    };
    runtime.handler = (method) => {
      if (method === 'session.features.mutate') return features;
      throw new Error(`Unexpected ${method}`);
    };
    const store = createPiSessionStore(runtime);
    store.setState({
      currentSessionId: 'session-a',
      records: {
        'session-a': {
          extensionStates: {},
          open: true,
          sessionId: 'session-a',
          snapshot: snapshot('session-a'),
          toolExecutions: {},
        },
      },
    });

    await store.getState().mutateFeatures('session-a', {
      objective: 'Finish the native migration',
      type: 'goal.start',
    });

    expect(runtime.calls.at(-1)).toEqual({
      method: 'session.features.mutate',
      params: {
        mutation: { objective: 'Finish the native migration', type: 'goal.start' },
        sessionId: 'session-a',
      },
    });
    expect(store.getState().records['session-a']?.snapshot?.features).toEqual(features);
  });

  test('ignores ephemeral catalog-worker session events', async () => {
    const runtime = new FakeRuntime();
    runtime.handler = (method) => {
      if (method === 'session.list') return [];
      throw new Error(`Unexpected ${method}`);
    };
    const store = createPiSessionStore(runtime);
    await store.getState().loadCatalog();

    runtime.event('session.snapshot', snapshot('catalog-context'));
    runtime.event('recovery.status', {
      ...recoveryStatus,
      sessionId: 'catalog-context',
    });

    expect(store.getState().records['catalog-context']).toBeUndefined();
  });

  test('does not let an older open completion replace a newer selection', async () => {
    const runtime = new FakeRuntime();
    const first = deferred<SessionSnapshot>();
    const second = deferred<SessionSnapshot>();
    runtime.handler = (method, params) => {
      const sessionId = (params as { sessionId?: string }).sessionId ?? '';
      if (method === 'session.open') return sessionId === 'session-a' ? first.promise : second.promise;
      if (method === 'session.entries') return branch(sessionId);
      if (method === 'recovery.status') return recoveryStatus;
      throw new Error(`Unexpected ${method}`);
    };
    const store = createPiSessionStore(runtime);
    const openA = store.getState().openSession({ sessionId: 'session-a' });
    const openB = store.getState().openSession({ sessionId: 'session-b' });

    expect(store.getState().currentSessionId).toBe('session-b');
    expect(store.getState().openingSessionId).toBe('session-b');

    second.resolve(snapshot('session-b'));
    await openB;
    first.resolve(snapshot('session-a'));
    await openA;

    expect(store.getState().currentSessionId).toBe('session-b');
  });

  test('returns from session open without waiting for history hydration', async () => {
    const runtime = new FakeRuntime();
    const entries = deferred<SessionEntriesResult>();
    runtime.handler = (method, params) => {
      const sessionId = (params as { sessionId?: string }).sessionId ?? 'session-a';
      if (method === 'session.open') return snapshot(sessionId);
      if (method === 'session.entries') return entries.promise;
      if (method === 'recovery.status') return recoveryStatus;
      throw new Error(`Unexpected ${method}`);
    };
    const store = createPiSessionStore(runtime);

    const opened = await store.getState().openSession({ sessionId: 'session-a' });
    expect(opened.sessionId).toBe('session-a');
    expect(store.getState().currentSessionId).toBe('session-a');
    expect(store.getState().openingSessionId).toBe('session-a');
    expect(store.getState().records['session-a']?.branchEntries).toBeUndefined();

    entries.resolve(branch('session-a'));
    await flushAsync();
    expect(store.getState().openingSessionId).toBeNull();
    expect(store.getState().records['session-a']?.branchEntries?.entries).toEqual([]);
  });

  test('hydrates a read-only history preview while the session worker is still opening', async () => {
    const runtime = new FakeRuntime();
    const opened = deferred<SessionSnapshot>();
    const previewEntry: PiSessionEntry = {
      id: 'preview-user',
      message: { content: 'preview', role: 'user', timestamp: 1 },
      parentId: null,
      timestamp: '2026-08-02T00:00:00.000Z',
      type: 'message',
    };
    runtime.handler = (method, params) => {
      const sessionId = (params as { sessionId?: string }).sessionId ?? 'session-a';
      if (method === 'session.open') return opened.promise;
      if (method === 'session.entries.preview') return branch(sessionId, [previewEntry]);
      if (method === 'session.entries') return branch(sessionId, [previewEntry]);
      if (method === 'recovery.status') return recoveryStatus;
      throw new Error(`Unexpected ${method}`);
    };
    const store = createPiSessionStore(runtime);

    const opening = store.getState().openSession({ cwd: 'D:/work', sessionId: 'session-a' });
    expect(store.getState().currentSessionId).toBe('session-a');
    await flushAsync();
    expect(store.getState().records['session-a']?.branchEntries?.entries).toEqual([previewEntry]);
    expect(store.getState().openingSessionId).toBe('session-a');

    opened.resolve(snapshot('session-a'));
    await opening;
    await flushAsync();
    expect(store.getState().openingSessionId).toBeNull();
  });

  test('restores the previous selection when the latest open fails', async () => {
    const runtime = new FakeRuntime();
    runtime.handler = (method) => {
      if (method === 'session.open') throw new Error('open failed');
      throw new Error(`Unexpected ${method}`);
    };
    const store = createPiSessionStore(runtime);
    store.setState({ currentSessionId: 'session-a' });

    const opening = store.getState().openSession({ sessionId: 'session-b' });
    expect(store.getState().currentSessionId).toBe('session-b');
    await expect(opening).rejects.toThrow('open failed');
    expect(store.getState().currentSessionId).toBe('session-a');
    expect(store.getState().openingSessionId).toBeNull();
  });

  test('does not let an older navigation completion reclaim the current session', async () => {
    const runtime = new FakeRuntime();
    const navigation = deferred<{ cancelled: false; snapshot: SessionSnapshot }>();
    runtime.handler = (method, params) => {
      const sessionId = (params as { sessionId?: string }).sessionId ?? '';
      if (method === 'session.navigate') return navigation.promise;
      if (method === 'session.open') return snapshot(sessionId);
      if (method === 'session.entries') return branch(sessionId);
      if (method === 'recovery.status') return recoveryStatus;
      throw new Error(`Unexpected ${method}`);
    };
    const store = createPiSessionStore(runtime);
    const navigateA = store.getState().navigateSession('session-a', 'entry-a');

    await store.getState().openSession({ sessionId: 'session-b' });
    navigation.resolve({ cancelled: false, snapshot: snapshot('session-a') });
    await navigateA;

    expect(store.getState().currentSessionId).toBe('session-b');
    expect(store.getState().records['session-a']?.snapshot?.sessionId).toBe('session-a');
  });

  test('loads branch and all entries independently when requests overlap', async () => {
    const runtime = new FakeRuntime();
    const branchRequest = deferred<SessionEntriesResult>();
    const allRequest = deferred<SessionEntriesResult>();
    runtime.handler = (method, params) => {
      if (method !== 'session.entries') throw new Error(`Unexpected ${method}`);
      return (params as { scope?: string }).scope === 'all'
        ? allRequest.promise
        : branchRequest.promise;
    };
    const store = createPiSessionStore(runtime);
    const loadAll = store.getState().refreshEntries('session-a', 'all');
    const loadBranch = store.getState().refreshEntries('session-a', 'branch');

    branchRequest.resolve(branch('session-a'));
    await loadBranch;
    allRequest.resolve(allEntries('session-a'));
    await loadAll;

    expect(store.getState().records['session-a']?.branchEntries?.scope).toBe('branch');
    expect(store.getState().records['session-a']?.allEntries?.scope).toBe('all');
  });

  test('loads Pi session stats into the session record', async () => {
    const runtime = new FakeRuntime();
    runtime.handler = (method, params) => {
      const sessionId = (params as { sessionId?: string }).sessionId ?? '';
      if (method === 'session.stats') return stats(sessionId);
      throw new Error(`Unexpected ${method}`);
    };
    const store = createPiSessionStore(runtime);

    const result = await store.getState().refreshStats('session-a');

    expect(result.contextUsage).toEqual({ contextWindow: 200000, percent: 0.6, tokens: 1200 });
    expect(store.getState().records['session-a']?.stats).toEqual(result);
    expect(runtime.calls).toEqual([{
      method: 'session.stats',
      params: { sessionId: 'session-a' },
    }]);
  });

  test('preserves live output and appended entries across an overlapping branch refresh', async () => {
    const runtime = new FakeRuntime();
    const request = deferred<SessionEntriesResult>();
    runtime.handler = (method) => {
      if (method === 'session.entries') return request.promise;
      throw new Error(`Unexpected ${method}`);
    };
    const store = createPiSessionStore(runtime);
    const refresh = store.getState().refreshEntries('session-a');
    await Promise.resolve();

    runtime.event('agent.event', {
      event: {
        message: assistant('streaming'),
        type: 'message_update',
        update: { contentIndex: 0, delta: 'streaming', type: 'text_delta' },
      } satisfies PiAgentEvent,
      sessionId: 'session-a',
    }, 'session-a');
    request.resolve(branch('session-a'));
    await refresh;

    expect(store.getState().records['session-a']?.liveAssistant?.content[0]).toEqual({
      text: 'streaming',
      type: 'text',
    });

    const nextRequest = deferred<SessionEntriesResult>();
    runtime.handler = (method) => {
      if (method === 'session.entries') return nextRequest.promise;
      throw new Error(`Unexpected ${method}`);
    };
    const nextRefresh = store.getState().refreshEntries('session-a');
    await Promise.resolve();
    const appended: PiSessionEntry = {
      id: 'entry-after-request',
      message: assistant('done'),
      parentId: null,
      timestamp: '2026-08-02T00:00:00.000Z',
      type: 'message',
    };
    runtime.event('agent.event', {
      event: { entry: appended, type: 'entry_appended' },
      sessionId: 'session-a',
    }, 'session-a');
    nextRequest.resolve(branch('session-a'));
    await nextRefresh;

    expect(store.getState().records['session-a']?.branchEntries?.entries).toEqual([appended]);
  });

  test('does not overwrite a newer recovery event with an older status response', async () => {
    const runtime = new FakeRuntime();
    const statusRequest = deferred<RecoveryStatus>();
    runtime.handler = (method) => {
      if (method === 'recovery.status') return statusRequest.promise;
      throw new Error(`Unexpected ${method}`);
    };
    const store = createPiSessionStore(runtime);
    const refresh = store.getState().refreshRecoveryStatus('session-a');
    await Promise.resolve();
    runtime.event('recovery.status', {
      ...recoveryStatus,
      actions: ['navigate'],
      sessionId: 'session-a',
    }, 'session-a');
    statusRequest.resolve(recoveryStatus);
    await refresh;

    expect(store.getState().records['session-a']?.recoveryStatus?.actions).toEqual(['navigate']);
  });

  test('applies plugin recovery to its session without stealing a newer selection', async () => {
    const runtime = new FakeRuntime();
    runtime.handler = (method, params) => {
      const sessionId = (params as { sessionId?: string }).sessionId ?? '';
      if (method === 'recovery.navigate') {
        return {
          action: 'navigate',
          editorText: 'restore this prompt',
          handledBy: 'pi-workspace-history',
          mode: 'both',
          outcome: 'applied',
          snapshot: snapshot(sessionId),
        };
      }
      if (method === 'session.entries') return branch(sessionId);
      if (method === 'recovery.status') return recoveryStatus;
      throw new Error(`Unexpected ${method}`);
    };
    const store = createPiSessionStore(runtime);
    store.getState().setCurrentSession('session-b');

    const result = await store.getState().recoverTo('session-a', 'entry-a', 'both');

    expect(result.editorText).toBe('restore this prompt');
    expect(store.getState().currentSessionId).toBe('session-b');
    expect(store.getState().records['session-a']?.snapshot?.sessionId).toBe('session-a');
    expect(store.getState().records['session-a']?.branchEntries?.entries).toEqual([]);
  });

  test('executes sidebar recovery controls through the session store', async () => {
    const runtime = new FakeRuntime();
    runtime.handler = (method, params) => {
      const sessionId = (params as { sessionId?: string }).sessionId ?? '';
      if (method === 'session.entries') return branch(sessionId);
      if (method === 'recovery.status') return recoveryStatus;
      if (method === 'recovery.checkpoint.create') {
        return {
          action: 'checkpoint',
          handledBy: 'pi-workspace-history',
          outcome: 'unknown',
          snapshot: snapshot(sessionId),
        };
      }
      if (method === 'recovery.undo' || method === 'recovery.redo') {
        return {
          action: method === 'recovery.undo' ? 'undo' : 'redo',
          handledBy: method === 'recovery.undo' ? 'pi-native' : 'pi-workspace-history',
          mode: (params as { mode: 'conversation' | 'both' }).mode,
          outcome: 'applied',
          snapshot: snapshot(sessionId),
        };
      }
      if (method === 'recovery.repair') {
        return {
          action: 'repair-typo',
          handledBy: 'pi-wtf',
          outcome: 'unknown',
          snapshot: snapshot(sessionId),
        };
      }
      throw new Error(`Unexpected ${method}`);
    };
    const store = createPiSessionStore(runtime);

    await store.getState().createRecoveryCheckpoint('session-a', 'Known good');
    await store.getState().undoRecovery('session-a', 'conversation');
    await store.getState().redoRecovery('session-a', 'both');
    await store.getState().repairRecovery('session-a', 'recover-typo');

    expect(runtime.calls.filter((call) => call.method.startsWith('recovery.') && call.method !== 'recovery.status'))
      .toEqual([
        {
          method: 'recovery.checkpoint.create',
          params: { name: 'Known good', sessionId: 'session-a' },
        },
        {
          method: 'recovery.undo',
          params: { mode: 'conversation', sessionId: 'session-a' },
        },
        {
          method: 'recovery.redo',
          params: { mode: 'both', sessionId: 'session-a' },
        },
        {
          method: 'recovery.repair',
          params: { action: 'recover-typo', sessionId: 'session-a' },
        },
      ]);
    expect(store.getState().records['session-a']?.snapshot?.sessionId).toBe('session-a');
  });

  test('resets catalog, current session, and event ownership on runtime change', async () => {
    const runtime = new FakeRuntime();
    runtime.handler = (method) => {
      if (method === 'session.list') return [summary('session-a', '2026-08-02T00:00:00.000Z')];
      throw new Error(`Unexpected ${method}`);
    };
    const store = createPiSessionStore(runtime);
    await store.getState().loadCatalog();
    store.getState().setCurrentSession('session-a');

    runtime.switchTo('runtime-b');

    expect(store.getState().runtimeKey).toBe('runtime-b');
    expect(store.getState().summaries).toEqual([]);
    expect(store.getState().currentSessionId).toBeNull();
  });

  test('does not dispatch a captured prompt after the runtime changes', async () => {
    const runtime = new FakeRuntime();
    runtime.handler = (method) => {
      if (method === 'agent.prompt') return { accepted: true };
      throw new Error(`Unexpected ${method}`);
    };
    const store = createPiSessionStore(runtime);

    runtime.switchTo('runtime-b');

    await expect(
      store.getState().prompt('session-a', 'stay on runtime A', undefined, undefined, 'runtime-a'),
    ).rejects.toThrow('runtime changed');
    expect(runtime.calls).toEqual([]);
  });
});
