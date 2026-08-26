import type {
  ImageAttachment,
  ModelDescriptor,
  PiAgentEvent,
  PiAssistantMessage,
  PiSessionEntry,
  PiSessionFeatureMutation,
  PiSessionFeatureState,
  RecoveryMode,
  RecoveryOperationResult,
  RecoveryRepairAction,
  RecoveryStatus,
  RuntimeEventEnvelope,
  RuntimeMethod,
  RuntimeMethodParams,
  RuntimeMethodResult,
  SessionEntriesResult,
  SessionSnapshot,
  SessionStats,
  SessionSummary,
  SessionWorkspaceBinding,
  ThinkingLevel,
  JsonValue,
  PiUserMessage,
} from '@piarium/protocol';
import type { PiRuntimeClient } from '@piarium/runtime-client';
import { create, type StoreApi, type UseBoundStore } from 'zustand';
import { notifyPiRuntimeCatalogChanged } from '@/lib/pi-runtime/catalog-events';
import { getPiRuntimeConnection } from '@/lib/pi-runtime/client';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';

export interface PiToolExecutionState {
  args: JsonValue;
  isError?: boolean;
  name: string;
  partialResult?: JsonValue;
  result?: JsonValue;
  status: 'running' | 'success' | 'error';
  toolCallId: string;
}

export interface PiSessionViewState {
  activityStartedAt?: number;
  allEntries?: SessionEntriesResult;
  branchEntries?: SessionEntriesResult;
  extensionStates: Record<string, JsonValue>;
  lastAgentEvent?: PiAgentEvent;
  liveAssistant?: PiAssistantMessage;
  liveUser?: PiUserMessage;
  open: boolean;
  recoveryStatus?: RecoveryStatus;
  sessionId: string;
  settledActivityDurationMs?: number;
  snapshot?: SessionSnapshot;
  stats?: SessionStats;
  toolExecutions: Record<string, PiToolExecutionState>;
}

export type PiSessionAttentionKind = 'complete' | 'error';

export interface PiSessionAttentionState {
  kind: PiSessionAttentionKind;
  updatedAt: number;
}

export type PiSessionRuntimeClient = Pick<PiRuntimeClient, 'request' | 'subscribe'>;

export interface PiSessionRuntimeConnection {
  client: PiSessionRuntimeClient;
  runtimeKey: string;
}

export interface PiSessionStoreRuntime {
  connect(): Promise<PiSessionRuntimeConnection>;
  currentKey(): string;
  subscribeChanged(listener: () => void): () => void;
}

export interface PiSessionStoreState {
  attentionBySession: Record<string, PiSessionAttentionState>;
  catalogCwd: string | null;
  catalogLoaded: boolean;
  catalogLoading: boolean;
  currentSessionId: string | null;
  lastError: string | null;
  openingSessionId: string | null;
  records: Record<string, PiSessionViewState>;
  runtimeKey: string;
  summaries: SessionSummary[];

  abort(sessionId: string): Promise<boolean>;
  archiveSession(sessionId: string): Promise<SessionSummary>;
  closeSession(sessionId: string): Promise<boolean>;
  clearSessionAttention(sessionId: string): void;
  createRecoveryCheckpoint(sessionId: string, name: string): Promise<RecoveryOperationResult>;
  createSession(
    cwd: string,
    name?: string,
    parentSession?: string,
    workspace?: SessionWorkspaceBinding,
  ): Promise<SessionSnapshot>;
  deleteSession(sessionId: string): Promise<boolean>;
  executeCommand(sessionId: string, command: string): Promise<JsonValue>;
  followUp(
    sessionId: string,
    text: string,
    images?: ImageAttachment[],
    instructions?: string,
    expectedRuntimeKey?: string,
  ): Promise<boolean>;
  forkSession(
    sessionId: string,
    entryId: string,
    position?: 'before' | 'at',
  ): Promise<RuntimeMethodResult<'session.fork'>>;
  loadCatalog(cwd?: string): Promise<SessionSummary[]>;
  mutateFeatures(
    sessionId: string,
    mutation: PiSessionFeatureMutation,
    expectedRuntimeKey?: string,
  ): Promise<PiSessionFeatureState>;
  navigateSession(
    sessionId: string,
    targetId: string,
    summarize?: boolean,
  ): Promise<RuntimeMethodResult<'session.navigate'>>;
  openSession(params: RuntimeMethodParams<'session.open'>): Promise<SessionSnapshot>;
  prompt(
    sessionId: string,
    text: string,
    images?: ImageAttachment[],
    instructions?: string,
    expectedRuntimeKey?: string,
  ): Promise<boolean>;
  recoverTo(
    sessionId: string,
    targetId: string,
    mode: RecoveryMode,
    summarize?: boolean,
  ): Promise<RecoveryOperationResult>;
  redoRecovery(sessionId: string, mode: RecoveryMode): Promise<RecoveryOperationResult>;
  repairRecovery(
    sessionId: string,
    action: RecoveryRepairAction,
  ): Promise<RecoveryOperationResult>;
  refreshEntries(
    sessionId: string,
    scope?: 'branch' | 'all',
  ): Promise<SessionEntriesResult>;
  refreshRecoveryStatus(sessionId: string): Promise<RecoveryStatus>;
  refreshStats(sessionId: string): Promise<SessionStats>;
  renameSession(sessionId: string, name: string): Promise<void>;
  reset(): void;
  selectModel(sessionId: string, model: Pick<ModelDescriptor, 'id' | 'provider'>): Promise<SessionSnapshot>;
  selectThinking(sessionId: string, level: ThinkingLevel): Promise<SessionSnapshot>;
  setCurrentSession(sessionId: string | null): void;
  steer(
    sessionId: string,
    text: string,
    images?: ImageAttachment[],
    instructions?: string,
    expectedRuntimeKey?: string,
  ): Promise<boolean>;
  undoRecovery(sessionId: string, mode: RecoveryMode): Promise<RecoveryOperationResult>;
  unarchiveSession(sessionId: string): Promise<SessionSummary>;
}

export type PiSessionStore = UseBoundStore<StoreApi<PiSessionStoreState>>;

const DEFAULT_RUNTIME: PiSessionStoreRuntime = {
  connect: getPiRuntimeConnection,
  currentKey: getRuntimeKey,
  subscribeChanged: subscribeRuntimeEndpointChanged,
};

const errorMessage = (error: unknown): string => (
  error instanceof Error ? error.message : String(error)
);

const sortSummaries = (summaries: SessionSummary[]): SessionSummary[] => (
  [...summaries].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
);

type PiSessionCatalogPartitions = {
  active: readonly SessionSummary[];
  archived: readonly SessionSummary[];
};

// Zustand 5 requires selector outputs to keep the same identity while their
// source snapshot is unchanged. The readonly contract protects that cache.
const catalogPartitionsBySummaries = new WeakMap<SessionSummary[], PiSessionCatalogPartitions>();

const partitionPiSessionCatalog = (summaries: SessionSummary[]): PiSessionCatalogPartitions => {
  const cached = catalogPartitionsBySummaries.get(summaries);
  if (cached) return cached;

  const partitions = {
    active: [] as SessionSummary[],
    archived: [] as SessionSummary[],
  };
  for (const summary of summaries) {
    if (summary.archivedAt === undefined) partitions.active.push(summary);
    else partitions.archived.push(summary);
  }
  catalogPartitionsBySummaries.set(summaries, partitions);
  return partitions;
};

export const selectActivePiSessions = (state: PiSessionStoreState): readonly SessionSummary[] => (
  partitionPiSessionCatalog(state.summaries).active
);

export const selectArchivedPiSessions = (state: PiSessionStoreState): readonly SessionSummary[] => (
  partitionPiSessionCatalog(state.summaries).archived
);

export const selectCurrentPiSession = (
  state: PiSessionStoreState,
): PiSessionViewState | undefined => (
  state.currentSessionId === null ? undefined : state.records[state.currentSessionId]
);

const piAgentEventAttentionKind = (
  event: PiAgentEvent,
): PiSessionAttentionKind | null => {
  if (event.type === 'auto_retry_end' && !event.success && event.finalError) return 'error';
  if (event.type !== 'agent_end' || event.willRetry) return null;
  const lastAssistant = [...event.messages]
    .reverse()
    .find((message): message is PiAssistantMessage => message.role === 'assistant');
  if (!lastAssistant || lastAssistant.stopReason === 'aborted') return null;
  return lastAssistant.stopReason === 'error' ? 'error' : 'complete';
};

const clearAttention = (
  attentionBySession: Record<string, PiSessionAttentionState>,
  sessionId: string,
): Record<string, PiSessionAttentionState> => {
  if (!(sessionId in attentionBySession)) return attentionBySession;
  const next = { ...attentionBySession };
  delete next[sessionId];
  return next;
};

const isPiSessionActivelyVisible = (
  sessionId: string,
  currentSessionId: string | null,
): boolean => (
  currentSessionId === sessionId
  && (typeof document === 'undefined' || (
    document.visibilityState === 'visible'
    && (typeof document.hasFocus !== 'function' || document.hasFocus())
  ))
);

const emptySession = (sessionId: string): PiSessionViewState => ({
  extensionStates: {},
  open: false,
  sessionId,
  toolExecutions: {},
});

const updateSnapshot = (
  snapshot: SessionSnapshot | undefined,
  patch: Partial<SessionSnapshot>,
): SessionSnapshot | undefined => (
  snapshot === undefined ? undefined : { ...snapshot, ...patch }
);

const preserveSnapshotWorkspace = (
  incoming: SessionSnapshot,
  current: SessionSnapshot | undefined,
): SessionSnapshot => (
  incoming.workspace !== undefined || current?.workspace === undefined
    ? incoming
    : {
        ...incoming,
        workspace: current.workspace,
        ...(current.workspacePersistence === undefined
          ? {}
          : { workspacePersistence: current.workspacePersistence }),
      }
);

const settleInterruptedSession = (
  current: PiSessionViewState,
  now = Date.now(),
): PiSessionViewState => {
  const next: PiSessionViewState = {
    ...current,
    liveAssistant: current.liveAssistant?.stopReason === 'pending'
      ? { ...current.liveAssistant, errorMessage: 'Pi session worker exited', stopReason: 'error' }
      : current.liveAssistant,
    open: false,
    snapshot: updateSnapshot(current.snapshot, {
      busy: false,
      isCompacting: false,
      isStreaming: false,
      retryAttempt: 0,
    }),
    toolExecutions: Object.fromEntries(Object.entries(current.toolExecutions).map(([id, execution]) => [
      id,
      execution.status === 'running'
        ? { ...execution, isError: true, status: 'error' as const }
        : execution,
    ])),
  };
  delete next.liveUser;
  if (current.activityStartedAt !== undefined) {
    next.settledActivityDurationMs = Math.max(0, now - current.activityStartedAt);
    delete next.activityStartedAt;
  } else if (current.snapshot?.busy) {
    delete next.settledActivityDurationMs;
  }
  return next;
};

const appendEntry = (
  result: SessionEntriesResult | undefined,
  entry: PiSessionEntry,
  fallback?: Pick<SessionEntriesResult, 'scope' | 'sessionId'>,
): SessionEntriesResult | undefined => {
  if (result === undefined) {
    if (fallback === undefined) return undefined;
    return {
      entries: [entry],
      leafId: entry.id,
      scope: fallback.scope,
      sessionId: fallback.sessionId,
    };
  }
  const index = result.entries.findIndex((candidate) => candidate.id === entry.id);
  const entries = index === -1
    ? [...result.entries, entry]
    : result.entries.map((candidate, candidateIndex) => (
        candidateIndex === index ? entry : candidate
      ));
  return { ...result, entries, leafId: entry.id };
};

const mergeEntriesArrivingDuringRequest = (
  incoming: SessionEntriesResult,
  current: SessionEntriesResult | undefined,
  entryIdsAtRequestStart: ReadonlySet<string>,
): SessionEntriesResult => {
  if (current === undefined) return incoming;
  const incomingIds = new Set(incoming.entries.map((entry) => entry.id));
  const laterEntries = current.entries.filter((entry) => (
    !entryIdsAtRequestStart.has(entry.id) && !incomingIds.has(entry.id)
  ));
  if (laterEntries.length === 0) return incoming;
  return {
    ...incoming,
    entries: [...incoming.entries, ...laterEntries],
    leafId: current.leafId ?? incoming.leafId,
  };
};

export const reducePiAgentEvent = (
  current: PiSessionViewState,
  event: PiAgentEvent,
  now = Date.now(),
): PiSessionViewState => {
  const next: PiSessionViewState = { ...current, lastAgentEvent: event };

  switch (event.type) {
    case 'agent_start':
      next.activityStartedAt = current.activityStartedAt ?? now;
      delete next.settledActivityDurationMs;
      next.snapshot = updateSnapshot(current.snapshot, { busy: true });
      return next;
    case 'agent_settled':
      if (current.activityStartedAt !== undefined) {
        next.settledActivityDurationMs = Math.max(0, now - current.activityStartedAt);
        delete next.activityStartedAt;
      } else if (current.snapshot?.busy) {
        delete next.settledActivityDurationMs;
      }
      next.snapshot = updateSnapshot(current.snapshot, {
        busy: false,
        isCompacting: false,
        isStreaming: false,
        retryAttempt: 0,
      });
      delete next.liveUser;
      return next;
    case 'message_start':
    case 'message_update':
    case 'message_end': {
      const message = event.message;
      if (message.role === 'user') {
        next.liveUser = message;
        return next;
      }
      if (
        message.role === 'assistant'
        && ![current.branchEntries, current.allEntries].some((result) => (
          result?.entries.some((entry) => (
            entry.type === 'message'
            && entry.message.role === 'assistant'
            && entry.message.timestamp === message.timestamp
            && entry.message.provider === message.provider
            && entry.message.model === message.model
          ))
        ))
      ) next.liveAssistant = message;
      return next;
    }
    case 'entry_appended':
      next.branchEntries = appendEntry(current.branchEntries, event.entry);
      next.allEntries = appendEntry(current.allEntries, event.entry);
      if (
        event.entry.type === 'message'
        && event.entry.message.role === 'assistant'
        && current.liveAssistant?.timestamp === event.entry.message.timestamp
        && current.liveAssistant.provider === event.entry.message.provider
        && current.liveAssistant.model === event.entry.message.model
      ) {
        delete next.liveAssistant;
      }
      if (
        event.entry.type === 'message'
        && event.entry.message.role === 'user'
        && current.liveUser?.timestamp === event.entry.message.timestamp
      ) {
        delete next.liveUser;
      }
      return next;
    case 'tool_execution_start':
      next.toolExecutions = {
        ...current.toolExecutions,
        [event.toolCallId]: {
          args: event.args,
          name: event.toolName,
          status: 'running',
          toolCallId: event.toolCallId,
        },
      };
      return next;
    case 'tool_execution_update':
      next.toolExecutions = {
        ...current.toolExecutions,
        [event.toolCallId]: {
          ...(current.toolExecutions[event.toolCallId] ?? {
            args: event.args,
            name: event.toolName,
            status: 'running' as const,
            toolCallId: event.toolCallId,
          }),
          args: event.args,
          name: event.toolName,
          partialResult: event.partialResult,
          status: 'running',
        },
      };
      return next;
    case 'tool_execution_end':
      next.toolExecutions = {
        ...current.toolExecutions,
        [event.toolCallId]: {
          ...(current.toolExecutions[event.toolCallId] ?? {
            args: null,
            name: event.toolName,
            toolCallId: event.toolCallId,
          }),
          isError: event.isError,
          name: event.toolName,
          result: event.result,
          status: event.isError ? 'error' : 'success',
        },
      };
      return next;
    case 'queue_update':
      next.snapshot = updateSnapshot(current.snapshot, {
        followUp: [...event.followUp],
        steering: [...event.steering],
      });
      return next;
    case 'thinking_level_changed':
      next.snapshot = updateSnapshot(current.snapshot, { thinkingLevel: event.level });
      return next;
    case 'session_info_changed':
      next.snapshot = updateSnapshot(current.snapshot, { name: event.name });
      return next;
    case 'compaction_start':
      next.snapshot = updateSnapshot(current.snapshot, { isCompacting: true });
      return next;
    case 'compaction_end':
      next.snapshot = updateSnapshot(current.snapshot, { isCompacting: false });
      return next;
    case 'auto_retry_start':
      next.snapshot = updateSnapshot(current.snapshot, { retryAttempt: event.attempt });
      return next;
    case 'auto_retry_end':
      next.snapshot = updateSnapshot(current.snapshot, {
        retryAttempt: event.success ? 0 : event.attempt,
      });
      return next;
    default:
      return next;
  }
};

const upsertRecord = (
  records: Record<string, PiSessionViewState>,
  sessionId: string,
  update: (current: PiSessionViewState) => PiSessionViewState,
): Record<string, PiSessionViewState> => ({
  ...records,
  [sessionId]: update(records[sessionId] ?? emptySession(sessionId)),
});

const upsertSummary = (
  summaries: SessionSummary[],
  summary: SessionSummary,
): SessionSummary[] => sortSummaries([
  summary,
  ...summaries.filter((candidate) => candidate.id !== summary.id),
]);

const initialFields = (runtimeKey: string): Pick<
  PiSessionStoreState,
  | 'attentionBySession'
  | 'catalogCwd'
  | 'catalogLoaded'
  | 'catalogLoading'
  | 'currentSessionId'
  | 'lastError'
  | 'openingSessionId'
  | 'records'
  | 'runtimeKey'
  | 'summaries'
> => ({
  attentionBySession: {},
  catalogCwd: null,
  catalogLoaded: false,
  catalogLoading: false,
  currentSessionId: null,
  lastError: null,
  openingSessionId: null,
  records: {},
  runtimeKey,
  summaries: [],
});

export const createPiSessionStore = (
  runtime: PiSessionStoreRuntime = DEFAULT_RUNTIME,
): PiSessionStore => {
  let activeClient: PiSessionRuntimeClient | null = null;
  let unsubscribeEvents: (() => void) | null = null;
  let catalogGeneration = 0;
  let selectionGeneration = 0;
  const entriesGeneration = new Map<string, number>();
  const recoveryGeneration = new Map<string, number>();
  const statsGeneration = new Map<string, number>();

  const store = create<PiSessionStoreState>((set, get) => {
    const contextIsCurrent = (runtimeKey: string): boolean => (
      runtime.currentKey() === runtimeKey && get().runtimeKey === runtimeKey
    );

    const commitError = (runtimeKey: string, error: unknown): void => {
      if (contextIsCurrent(runtimeKey)) set({ lastError: errorMessage(error) });
    };

    const beginSelectionIntent = (): number => {
      selectionGeneration += 1;
      set({ openingSessionId: null });
      return selectionGeneration;
    };

    const selectionIntentIsCurrent = (generation: number, runtimeKey: string): boolean => (
      generation === selectionGeneration && contextIsCurrent(runtimeKey)
    );

    const entriesRequestKey = (sessionId: string, scope: 'branch' | 'all'): string => (
      `${sessionId}\u0000${scope}`
    );

    const handleRuntimeEvent = (runtimeKey: string, envelope: RuntimeEventEnvelope): void => {
      if (!contextIsCurrent(runtimeKey)) return;
      // Catalog workers open short-lived workspace contexts for provider/model
      // operations. Their snapshots are not user sessions and must never enter
      // the session catalog or current-session state.
      if (envelope.source.role !== 'session') return;

      switch (envelope.event) {
        case 'session.snapshot': {
          const snapshot = envelope.data;
          set((state) => ({
            records: upsertRecord(state.records, snapshot.sessionId, (current) => ({
              ...current,
              open: true,
              snapshot: preserveSnapshotWorkspace(snapshot, current.snapshot),
            })),
          }));
          return;
        }
        case 'session.closed': {
          const { sessionId } = envelope.data;
          if (get().currentSessionId === sessionId) beginSelectionIntent();
          set((state) => ({
            attentionBySession: clearAttention(state.attentionBySession, sessionId),
            currentSessionId: state.currentSessionId === sessionId ? null : state.currentSessionId,
            records: upsertRecord(state.records, sessionId, (current) => ({
              ...current,
              open: false,
            })),
          }));
          return;
        }
        case 'session.worker.exited': {
          const { expected, sessionId } = envelope.data;
          set((state) => ({
            attentionBySession: expected || isPiSessionActivelyVisible(sessionId, state.currentSessionId)
              ? state.attentionBySession
              : {
                  ...state.attentionBySession,
                  [sessionId]: { kind: 'error', updatedAt: Date.now() },
                },
            lastError: expected ? state.lastError : 'Pi session worker exited unexpectedly',
            records: upsertRecord(state.records, sessionId, settleInterruptedSession),
          }));
          return;
        }
        case 'agent.event': {
          const { sessionId, event } = envelope.data;
          const attentionKind = piAgentEventAttentionKind(event);
          set((state) => {
            const records = upsertRecord(state.records, sessionId, (current) => {
              const reduced = reducePiAgentEvent(current, event);
              if (event.type !== 'entry_appended') return reduced;
              const branchKey = entriesRequestKey(sessionId, 'branch');
              const allKey = entriesRequestKey(sessionId, 'all');
              return {
                ...reduced,
                branchEntries: appendEntry(
                  reduced.branchEntries,
                  event.entry,
                  entriesGeneration.has(branchKey)
                    ? { scope: 'branch', sessionId }
                    : undefined,
                ),
                allEntries: appendEntry(
                  reduced.allEntries,
                  event.entry,
                  entriesGeneration.has(allKey)
                    ? { scope: 'all', sessionId }
                    : undefined,
                ),
              };
            });
            if (attentionKind === null) return { records };
            const attentionBySession = isPiSessionActivelyVisible(sessionId, state.currentSessionId)
              ? clearAttention(state.attentionBySession, sessionId)
              : {
                  ...state.attentionBySession,
                  [sessionId]: { kind: attentionKind, updatedAt: Date.now() },
                };
            return { attentionBySession, records };
          });
          if (event.type === 'agent_settled') {
            void get().refreshEntries(sessionId).catch(() => undefined);
            void get().loadCatalog(get().catalogCwd ?? undefined).catch(() => undefined);
          }
          return;
        }
        case 'recovery.status': {
          const { sessionId, ...recoveryStatus } = envelope.data;
          recoveryGeneration.set(sessionId, (recoveryGeneration.get(sessionId) ?? 0) + 1);
          set((state) => ({
            records: upsertRecord(state.records, sessionId, (current) => ({
              ...current,
              recoveryStatus,
            })),
          }));
          return;
        }
        case 'recovery.changed': {
          const { sessionId } = envelope.data;
          void get().refreshEntries(sessionId).catch(() => undefined);
          void get().refreshRecoveryStatus(sessionId).catch(() => undefined);
          return;
        }
        case 'extension.state': {
          const { channel, sessionId, value } = envelope.data;
          set((state) => ({
            records: upsertRecord(state.records, sessionId, (current) => {
              const extensionStates = { ...current.extensionStates };
              if (value === null) delete extensionStates[channel];
              else extensionStates[channel] = value;
              return { ...current, extensionStates };
            }),
          }));
          return;
        }
        case 'host.error': {
          const sessionId = envelope.source.sessionId;
          set((state) => ({
            attentionBySession: sessionId && !isPiSessionActivelyVisible(sessionId, state.currentSessionId)
              ? {
                  ...state.attentionBySession,
                  [sessionId]: { kind: 'error', updatedAt: Date.now() },
                }
              : state.attentionBySession,
            lastError: envelope.data.message,
          }));
          return;
        }
        default:
          return;
      }
    };

    const connect = async (): Promise<PiSessionRuntimeConnection> => {
      const expectedRuntimeKey = runtime.currentKey();
      const connection = await runtime.connect();
      if (
        connection.runtimeKey !== expectedRuntimeKey
        || !contextIsCurrent(expectedRuntimeKey)
      ) {
        throw new Error('Pi runtime changed while connecting');
      }
      if (activeClient !== connection.client) {
        unsubscribeEvents?.();
        activeClient = connection.client;
        unsubscribeEvents = connection.client.subscribe((envelope) => {
          handleRuntimeEvent(connection.runtimeKey, envelope);
        });
      }
      return connection;
    };

    const request = async <M extends RuntimeMethod>(
      method: M,
      params: RuntimeMethodParams<M>,
      requestedRuntimeKey?: string,
      reportError = true,
    ): Promise<{ result: RuntimeMethodResult<M>; runtimeKey: string }> => {
      const expectedRuntimeKey = requestedRuntimeKey ?? runtime.currentKey();
      try {
        if (!contextIsCurrent(expectedRuntimeKey)) {
          throw new Error(`Pi runtime changed before ${method}`);
        }
        const connection = await connect();
        if (
          connection.runtimeKey !== expectedRuntimeKey
          || !contextIsCurrent(expectedRuntimeKey)
        ) {
          throw new Error(`Pi runtime changed before ${method}`);
        }
        const result = await connection.client.request(method, params);
        if (!contextIsCurrent(connection.runtimeKey)) {
          throw new Error(`Pi runtime changed during ${method}`);
        }
        return { result, runtimeKey: connection.runtimeKey };
      } catch (error) {
        if (reportError) commitError(expectedRuntimeKey, error);
        throw error;
      }
    };

    const refreshCatalogAfterMutation = async (): Promise<void> => {
      const cwd = get().catalogCwd ?? undefined;
      await get().loadCatalog(cwd).catch(() => undefined);
    };

    const applyRecoveryResult = async (
      sessionId: string,
      result: RecoveryOperationResult,
    ): Promise<RecoveryOperationResult> => {
      set((state) => ({
        lastError: null,
        records: upsertRecord(state.records, sessionId, (current) => ({
          ...current,
          open: true,
          snapshot: preserveSnapshotWorkspace(result.snapshot, current.snapshot),
        })),
      }));
      await Promise.all([
        get().refreshEntries(sessionId),
        get().refreshRecoveryStatus(sessionId).catch(() => undefined),
      ]);
      return result;
    };

    return {
      ...initialFields(runtime.currentKey()),

      abort: async (sessionId) => {
        const { result } = await request('agent.abort', { sessionId });
        return result.aborted;
      },

      archiveSession: async (sessionId) => {
        const clearsCurrentSelection = get().currentSessionId === sessionId;
        if (clearsCurrentSelection) beginSelectionIntent();
        try {
          const wasOpen = get().records[sessionId]?.open === true;
          const { result, runtimeKey } = await request('session.archive', { sessionId });
          set((state) => ({
            attentionBySession: clearAttention(state.attentionBySession, sessionId),
            currentSessionId: state.currentSessionId === sessionId ? null : state.currentSessionId,
            lastError: null,
            records: upsertRecord(state.records, sessionId, (current) => ({
              ...current,
              open: false,
            })),
            summaries: upsertSummary(state.summaries, result),
          }));
          if (wasOpen && contextIsCurrent(runtimeKey)) {
            await request('session.close', { sessionId }).catch((error: unknown) => {
              commitError(runtimeKey, error);
              return undefined;
            });
          }
          return result;
        } catch (error) {
          commitError(runtime.currentKey(), error);
          throw error;
        }
      },

      closeSession: async (sessionId) => {
        const clearsCurrentSelection = get().currentSessionId === sessionId;
        if (clearsCurrentSelection) beginSelectionIntent();
        try {
          const { result } = await request('session.close', { sessionId });
          set((state) => ({
            currentSessionId: state.currentSessionId === sessionId ? null : state.currentSessionId,
            lastError: null,
            records: upsertRecord(state.records, sessionId, (current) => ({
              ...current,
              open: false,
            })),
          }));
          return result.closed;
        } catch (error) {
          commitError(runtime.currentKey(), error);
          throw error;
        }
      },

      clearSessionAttention: (sessionId) => {
        set((state) => ({
          attentionBySession: clearAttention(state.attentionBySession, sessionId),
        }));
      },

      createSession: async (cwd, name, parentSession, workspace) => {
        const selectionIntent = beginSelectionIntent();
        try {
          const { result, runtimeKey } = await request('session.create', {
            cwd,
            ...(name === undefined ? {} : { name }),
            ...(parentSession === undefined ? {} : { parentSession }),
            ...(workspace === undefined ? {} : { workspace }),
          });
          set((state) => ({
            attentionBySession: clearAttention(state.attentionBySession, result.sessionId),
            currentSessionId: selectionIntentIsCurrent(selectionIntent, runtimeKey)
              ? result.sessionId
              : state.currentSessionId,
            lastError: null,
            records: upsertRecord(state.records, result.sessionId, (current) => ({
              ...current,
              open: true,
              snapshot: preserveSnapshotWorkspace(result, current.snapshot),
            })),
          }));
          await Promise.allSettled([
            get().refreshEntries(result.sessionId),
            get().refreshRecoveryStatus(result.sessionId),
          ]);
          await refreshCatalogAfterMutation();
          return result;
        } catch (error) {
          commitError(runtime.currentKey(), error);
          throw error;
        }
      },

      deleteSession: async (sessionId) => {
        const clearsCurrentSelection = get().currentSessionId === sessionId;
        if (clearsCurrentSelection) beginSelectionIntent();
        try {
          const { result } = await request('session.delete', { sessionId });
          if (!result.deleted) return false;
          set((state) => {
            const records = { ...state.records };
            delete records[sessionId];
            return {
              attentionBySession: clearAttention(state.attentionBySession, sessionId),
              currentSessionId: state.currentSessionId === sessionId ? null : state.currentSessionId,
              lastError: null,
              records,
              summaries: state.summaries.filter((summary) => summary.id !== sessionId),
            };
          });
          return true;
        } catch (error) {
          commitError(runtime.currentKey(), error);
          throw error;
        }
      },

      executeCommand: async (sessionId, command) => {
        const { result } = await request('command.execute', { command, sessionId });
        if (command.trim() === '/reload') {
          notifyPiRuntimeCatalogChanged('reload');
        }
        return result;
      },

      followUp: async (sessionId, text, images, instructions, expectedRuntimeKey) => {
        const { result } = await request('agent.followUp', {
          ...(images === undefined ? {} : { images }),
          ...(instructions === undefined ? {} : { instructions }),
          sessionId,
          text,
        }, expectedRuntimeKey);
        return result.accepted;
      },

      forkSession: async (sessionId, entryId, position) => {
        const selectionIntent = beginSelectionIntent();
        try {
          const { result, runtimeKey } = await request('session.fork', {
            entryId,
            ...(position === undefined ? {} : { position }),
            sessionId,
          });
          if (result.cancelled) return result;
          const previousId = sessionId;
          const nextId = result.snapshot.sessionId;
          set((state) => ({
            attentionBySession: selectionIntentIsCurrent(selectionIntent, runtimeKey)
              ? clearAttention(state.attentionBySession, nextId)
              : state.attentionBySession,
            currentSessionId: selectionIntentIsCurrent(selectionIntent, runtimeKey)
              ? nextId
              : state.currentSessionId,
            lastError: null,
            records: {
              ...upsertRecord(state.records, previousId, (current) => ({
                ...current,
                open: previousId === nextId,
              })),
              [nextId]: {
                ...(state.records[nextId] ?? emptySession(nextId)),
                open: true,
                snapshot: preserveSnapshotWorkspace(
                  result.snapshot,
                  state.records[nextId]?.snapshot ?? state.records[previousId]?.snapshot,
                ),
              },
            },
          }));
          await get().refreshEntries(nextId);
          await refreshCatalogAfterMutation();
          return result;
        } catch (error) {
          commitError(runtime.currentKey(), error);
          throw error;
        }
      },

      loadCatalog: async (cwd) => {
        const generation = ++catalogGeneration;
        const requestedCwd = cwd ?? null;
        set({ catalogCwd: requestedCwd, catalogLoading: true, lastError: null });
        try {
          const { result, runtimeKey } = await request('session.list', {
            ...(cwd === undefined ? {} : { cwd }),
          });
          if (generation !== catalogGeneration || !contextIsCurrent(runtimeKey)) return result;
          const summaries = sortSummaries(result);
          set({
            catalogCwd: requestedCwd,
            catalogLoaded: true,
            catalogLoading: false,
            summaries,
          });
          return summaries;
        } catch (error) {
          if (generation === catalogGeneration) {
            set({ catalogLoading: false });
            commitError(runtime.currentKey(), error);
          }
          throw error;
        }
      },

      mutateFeatures: async (sessionId, mutation, expectedRuntimeKey) => {
        const { result } = await request(
          'session.features.mutate',
          { mutation, sessionId },
          expectedRuntimeKey,
        );
        set((state) => ({
          lastError: null,
          records: upsertRecord(state.records, sessionId, (current) => ({
            ...current,
            snapshot: updateSnapshot(current.snapshot, { features: result }),
          })),
        }));
        return result;
      },

      navigateSession: async (sessionId, targetId, summarize) => {
        const selectionIntent = beginSelectionIntent();
        try {
          const { result, runtimeKey } = await request('session.navigate', {
            sessionId,
            targetId,
            ...(summarize === undefined ? {} : { summarize }),
          });
          if (!result.cancelled) {
            set((state) => ({
              attentionBySession: selectionIntentIsCurrent(selectionIntent, runtimeKey)
                ? clearAttention(state.attentionBySession, result.snapshot.sessionId)
                : state.attentionBySession,
              currentSessionId: selectionIntentIsCurrent(selectionIntent, runtimeKey)
                ? result.snapshot.sessionId
                : state.currentSessionId,
              lastError: null,
              records: upsertRecord(state.records, result.snapshot.sessionId, (current) => ({
                ...current,
                open: true,
                snapshot: preserveSnapshotWorkspace(result.snapshot, current.snapshot),
              })),
            }));
            await get().refreshEntries(result.snapshot.sessionId);
          }
          return result;
        } catch (error) {
          commitError(runtime.currentKey(), error);
          throw error;
        }
      },

      openSession: async (params) => {
        const previousSessionId = get().currentSessionId;
        const selectionIntent = beginSelectionIntent();
        const openingSessionId = params.sessionId ?? null;
        set((state) => ({
          currentSessionId: openingSessionId ?? state.currentSessionId,
          openingSessionId,
          lastError: null,
        }));
        if (openingSessionId && !get().records[openingSessionId]?.branchEntries) {
          const requestKey = entriesRequestKey(openingSessionId, 'branch');
          const generation = (entriesGeneration.get(requestKey) ?? 0) + 1;
          entriesGeneration.set(requestKey, generation);
          const entryIdsAtRequestStart = new Set(
            get().records[openingSessionId]?.branchEntries?.entries.map((entry) => entry.id) ?? [],
          );
          void request('session.entries.preview', {
            ...(params.cwd === undefined ? {} : { cwd: params.cwd }),
            scope: 'branch',
            sessionId: openingSessionId,
          }, undefined, false).then(({ result, runtimeKey }) => {
            if (
              entriesGeneration.get(requestKey) !== generation
              || !contextIsCurrent(runtimeKey)
            ) return;
            set((state) => ({
              records: upsertRecord(state.records, openingSessionId, (current) => ({
                ...current,
                branchEntries: mergeEntriesArrivingDuringRequest(
                  result,
                  current.branchEntries,
                  entryIdsAtRequestStart,
                ),
              })),
            }));
          }).catch(() => undefined);
        }
        try {
          const { result, runtimeKey } = await request('session.open', params);
          set((state) => ({
            attentionBySession: selectionIntentIsCurrent(selectionIntent, runtimeKey)
              ? clearAttention(state.attentionBySession, result.sessionId)
              : state.attentionBySession,
            currentSessionId: selectionIntentIsCurrent(selectionIntent, runtimeKey)
              ? result.sessionId
              : state.currentSessionId,
            records: upsertRecord(state.records, result.sessionId, (current) => ({
              ...current,
              open: true,
              snapshot: preserveSnapshotWorkspace(result, current.snapshot),
            })),
          }));
          void get().refreshEntries(result.sessionId)
            .catch(() => undefined)
            .finally(() => {
              if (!selectionIntentIsCurrent(selectionIntent, runtimeKey)) return;
              set((state) => ({
                openingSessionId: state.openingSessionId === result.sessionId
                  ? null
                  : state.openingSessionId,
              }));
            });
          void get().refreshRecoveryStatus(result.sessionId).catch(() => undefined);
          return result;
        } catch (error) {
          if (selectionIntent === selectionGeneration) {
            set((state) => ({
              currentSessionId: state.currentSessionId === openingSessionId
                ? previousSessionId
                : state.currentSessionId,
              openingSessionId: null,
            }));
          }
          commitError(runtime.currentKey(), error);
          throw error;
        }
      },

      prompt: async (sessionId, text, images, instructions, expectedRuntimeKey) => {
        const { result } = await request('agent.prompt', {
          ...(images === undefined ? {} : { images }),
          ...(instructions === undefined ? {} : { instructions }),
          sessionId,
          text,
        }, expectedRuntimeKey);
        return result.accepted;
      },

      createRecoveryCheckpoint: async (sessionId, name) => {
        const { result } = await request('recovery.checkpoint.create', { name, sessionId });
        return applyRecoveryResult(sessionId, result);
      },

      recoverTo: async (sessionId, targetId, mode, summarize) => {
        const { result } = await request('recovery.navigate', {
          mode,
          sessionId,
          targetId,
          ...(summarize === undefined ? {} : { summarize }),
        });
        return applyRecoveryResult(sessionId, result);
      },

      redoRecovery: async (sessionId, mode) => {
        const { result } = await request('recovery.redo', { mode, sessionId });
        return applyRecoveryResult(sessionId, result);
      },

      repairRecovery: async (sessionId, action) => {
        const { result } = await request('recovery.repair', { action, sessionId });
        return applyRecoveryResult(sessionId, result);
      },

      refreshEntries: async (sessionId, scope = 'branch') => {
        const requestKey = entriesRequestKey(sessionId, scope);
        const generation = (entriesGeneration.get(requestKey) ?? 0) + 1;
        entriesGeneration.set(requestKey, generation);
        const entryIdsAtRequestStart = new Set(
          (scope === 'all'
            ? get().records[sessionId]?.allEntries
            : get().records[sessionId]?.branchEntries
          )?.entries.map((entry) => entry.id) ?? [],
        );
        try {
          const { result, runtimeKey } = await request('session.entries', { scope, sessionId });
          if (
            entriesGeneration.get(requestKey) !== generation
            || !contextIsCurrent(runtimeKey)
          ) {
            return result;
          }
          set((state) => ({
            lastError: null,
            records: upsertRecord(state.records, sessionId, (current) => {
              const currentEntries = scope === 'all'
                ? current.allEntries
                : current.branchEntries;
              const merged = mergeEntriesArrivingDuringRequest(
                result,
                currentEntries,
                entryIdsAtRequestStart,
              );
              return {
                ...current,
                ...(scope === 'all'
                  ? { allEntries: merged }
                  : { branchEntries: merged }),
              };
            }),
          }));
          return result;
        } catch (error) {
          commitError(runtime.currentKey(), error);
          throw error;
        }
      },

      refreshRecoveryStatus: async (sessionId) => {
        const generation = (recoveryGeneration.get(sessionId) ?? 0) + 1;
        recoveryGeneration.set(sessionId, generation);
        try {
          const { result, runtimeKey } = await request('recovery.status', { sessionId });
          if (
            recoveryGeneration.get(sessionId) !== generation
            || !contextIsCurrent(runtimeKey)
          ) {
            return result;
          }
          set((state) => ({
            lastError: null,
            records: upsertRecord(state.records, sessionId, (current) => ({
              ...current,
              recoveryStatus: result,
            })),
          }));
          return result;
        } catch (error) {
          commitError(runtime.currentKey(), error);
          throw error;
        }
      },

      refreshStats: async (sessionId) => {
        const generation = (statsGeneration.get(sessionId) ?? 0) + 1;
        statsGeneration.set(sessionId, generation);
        try {
          const { result, runtimeKey } = await request('session.stats', { sessionId });
          if (
            statsGeneration.get(sessionId) !== generation
            || !contextIsCurrent(runtimeKey)
          ) {
            return result;
          }
          set((state) => ({
            lastError: null,
            records: upsertRecord(state.records, sessionId, (current) => ({
              ...current,
              stats: result,
            })),
          }));
          return result;
        } catch (error) {
          commitError(runtime.currentKey(), error);
          throw error;
        }
      },

      renameSession: async (sessionId, name) => {
        try {
          const { result } = await request('session.rename', { name, sessionId });
          set((state) => ({
            lastError: null,
            records: upsertRecord(state.records, sessionId, (current) => ({
              ...current,
              snapshot: updateSnapshot(current.snapshot, { name: result.name }),
            })),
            summaries: state.summaries.map((summary) => {
              if (summary.id !== sessionId) return summary;
              const updated = { ...summary };
              if (result.name === undefined) delete updated.name;
              else updated.name = result.name;
              return updated;
            }),
          }));
          await refreshCatalogAfterMutation();
        } catch (error) {
          commitError(runtime.currentKey(), error);
          throw error;
        }
      },

      reset: () => {
        catalogGeneration += 1;
        selectionGeneration += 1;
        entriesGeneration.clear();
        recoveryGeneration.clear();
        statsGeneration.clear();
        unsubscribeEvents?.();
        unsubscribeEvents = null;
        activeClient = null;
        set(initialFields(runtime.currentKey()));
      },

      selectModel: async (sessionId, model) => {
        const { result } = await request('model.select', {
          modelId: model.id,
          provider: model.provider,
          sessionId,
        });
        set((state) => ({
          records: upsertRecord(state.records, sessionId, (current) => ({
            ...current,
            open: true,
            snapshot: preserveSnapshotWorkspace(result, current.snapshot),
          })),
        }));
        return result;
      },

      selectThinking: async (sessionId, level) => {
        const { result } = await request('thinking.select', { level, sessionId });
        set((state) => ({
          records: upsertRecord(state.records, sessionId, (current) => ({
            ...current,
            open: true,
            snapshot: preserveSnapshotWorkspace(result, current.snapshot),
          })),
        }));
        return result;
      },

      setCurrentSession: (sessionId) => {
        beginSelectionIntent();
        set((state) => ({
          attentionBySession: sessionId === null
            ? state.attentionBySession
            : clearAttention(state.attentionBySession, sessionId),
          currentSessionId: sessionId,
        }));
      },

      steer: async (sessionId, text, images, instructions, expectedRuntimeKey) => {
        const { result } = await request('agent.steer', {
          ...(images === undefined ? {} : { images }),
          ...(instructions === undefined ? {} : { instructions }),
          sessionId,
          text,
        }, expectedRuntimeKey);
        return result.accepted;
      },

      undoRecovery: async (sessionId, mode) => {
        const { result } = await request('recovery.undo', { mode, sessionId });
        return applyRecoveryResult(sessionId, result);
      },

      unarchiveSession: async (sessionId) => {
        try {
          const { result } = await request('session.unarchive', { sessionId });
          set((state) => ({
            lastError: null,
            summaries: upsertSummary(state.summaries, result),
          }));
          return result;
        } catch (error) {
          commitError(runtime.currentKey(), error);
          throw error;
        }
      },
    };
  });

  runtime.subscribeChanged(() => {
    store.getState().reset();
  });

  return store;
};

export const usePiSessionStore = createPiSessionStore();
