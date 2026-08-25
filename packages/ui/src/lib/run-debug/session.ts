import type {
  PiariumBreakpoint,
  PiariumDebugBreakpointsResult,
  PiariumDebugEvent,
  PiariumDebugSessionStatus,
  PiariumDebugStackFrame,
  PiariumTaskEvent,
  PiariumTestEvent,
  PiariumTestItem,
  PiariumTestRunStatus,
  Subscription,
  WorkspaceDebugAPI,
  WorkspaceTasksAPI,
  WorkspaceTestAPI,
} from '@/lib/api/types';
import { RunServicesError } from '@/lib/api/run-errors';
import type { DocumentIdentity } from '@/lib/documents/types';
import {
  subscribeRuntimeEndpointChanged,
  subscribeRuntimeEndpointWillChange,
} from '@/lib/runtime-switch';
import { setWorkbenchContextKey } from '@/lib/workbench/editors/context-keys';

type Bound = {
  tasks: WorkspaceTasksAPI;
  debug: WorkspaceDebugAPI;
  tests: WorkspaceTestAPI;
};

export type RunDebugSessionOwner = {
  sessionId: string;
  generation: number;
};

export type RunDebugTestOwner = {
  runId: string;
  generation: number;
};

export type RunDebugEditorProjection = {
  workspaceId: string;
  breakpoints: readonly PiariumBreakpoint[];
  debugOwner?: RunDebugSessionOwner;
  currentDebugFrame?: PiariumDebugStackFrame;
  testOwner?: RunDebugTestOwner;
  latestTestFailure?: PiariumTestItem;
};

type WorkspaceLoadState = {
  breakpointRevision: number;
  debugRevision: number;
  debugStatus: 'unknown' | 'active' | 'inactive';
  frameRequest: number;
  latestDebugOwner?: RunDebugSessionOwner;
  mutationRequest: number;
  retiredDebugGeneration?: number;
  testRevision: number;
};

let bound: Bound | null = null;
const viewCounts = new Map<string, number>();
const subscriptions = new Map<string, Subscription[]>();
const projectionListeners = new Map<string, Set<() => void>>();
const projections = new Map<string, RunDebugEditorProjection>();
const loadStates = new Map<string, WorkspaceLoadState>();
const selectedStackFrames = new Map<string, PiariumDebugStackFrame>();
const activeTaskRuns = new Map<string, Set<string>>();
const debugStatuses = new Map<string, 'starting' | 'running' | 'paused'>();
const listeners = new Set<() => void>();
let unsubscribeEndpointWillChange: (() => void) | null = null;
let unsubscribeEndpointChanged: (() => void) | null = null;

const emptyProjection = (workspaceId: string): RunDebugEditorProjection => ({
  workspaceId,
  breakpoints: [],
});

const projectionFor = (workspaceId: string): RunDebugEditorProjection => (
  projections.get(workspaceId) ?? emptyProjection(workspaceId)
);

const refreshContextKeys = (): void => {
  setWorkbenchContextKey('taskIsRunning', activeTaskRuns.size > 0);
  setWorkbenchContextKey('debugIsActive', debugStatuses.size > 0);
  setWorkbenchContextKey(
    'debugIsPaused',
    [...debugStatuses.values()].some((value) => value === 'paused'),
  );
  setWorkbenchContextKey(
    'testHasFailure',
    [...projections.values()].some((projection) => projection.latestTestFailure !== undefined),
  );
};

const emitWorkspace = (workspaceId: string): void => {
  for (const listener of listeners) listener();
  for (const listener of projectionListeners.get(workspaceId) ?? []) listener();
};

const publishProjection = (
  workspaceId: string,
  update: Partial<Omit<RunDebugEditorProjection, 'workspaceId'>>,
): void => {
  projections.set(workspaceId, { ...projectionFor(workspaceId), ...update, workspaceId });
  refreshContextKeys();
  emitWorkspace(workspaceId);
};

const debugOwnerFrom = (snapshot: PiariumDebugSessionStatus): RunDebugSessionOwner | undefined => (
  snapshot.status !== 'absent'
  && typeof snapshot.sessionId === 'string'
  && snapshot.sessionId
  && typeof snapshot.generation === 'number'
    ? { sessionId: snapshot.sessionId, generation: snapshot.generation }
    : undefined
);

const testOwnerFrom = (snapshot: PiariumTestRunStatus): RunDebugTestOwner | undefined => (
  typeof snapshot.runId === 'string'
  && snapshot.runId
  && typeof snapshot.generation === 'number'
    ? { runId: snapshot.runId, generation: snapshot.generation }
    : undefined
);

const sameDebugOwner = (
  left: RunDebugSessionOwner | undefined,
  right: RunDebugSessionOwner | undefined,
): boolean => (
  left?.sessionId === right?.sessionId && left?.generation === right?.generation
);

const sameTestOwner = (
  left: RunDebugTestOwner | undefined,
  right: RunDebugTestOwner | undefined,
): boolean => (
  left?.runId === right?.runId && left?.generation === right?.generation
);

const isOlderDebugOwner = (
  candidate: RunDebugSessionOwner,
  current: RunDebugSessionOwner | undefined,
): boolean => Boolean(
  current
  && (
    candidate.generation < current.generation
    || (candidate.generation === current.generation && candidate.sessionId !== current.sessionId)
  )
);

const isOlderTestOwner = (
  candidate: RunDebugTestOwner,
  current: RunDebugTestOwner | undefined,
): boolean => Boolean(
  current
  && (
    candidate.generation < current.generation
    || (candidate.generation === current.generation && candidate.runId !== current.runId)
  )
);

const isCurrentLoadState = (workspaceId: string, state: WorkspaceLoadState): boolean => (
  loadStates.get(workspaceId) === state && subscriptions.has(workspaceId)
);

const resolveTopFrame = async (
  workspaceId: string,
  owner: RunDebugSessionOwner,
  state: WorkspaceLoadState,
): Promise<void> => {
  if (!bound || !isCurrentLoadState(workspaceId, state)) return;
  const debug = bound.debug;
  const request = ++state.frameRequest;
  try {
    const threads = await debug.getThreads({ workspaceId });
    if (
      !isCurrentLoadState(workspaceId, state)
      || request !== state.frameRequest
      || !sameDebugOwner(projectionFor(workspaceId).debugOwner, owner)
      || threads.status !== 'ready'
      || threads.workspaceId !== workspaceId
      || threads.sessionId !== owner.sessionId
      || threads.generation !== owner.generation
    ) return;
    const thread = threads.value[0];
    if (!thread) {
      selectedStackFrames.delete(workspaceId);
      publishProjection(workspaceId, { currentDebugFrame: undefined });
      return;
    }
    const stack = await debug.getStack({ workspaceId, threadId: thread.id });
    if (
      !isCurrentLoadState(workspaceId, state)
      || request !== state.frameRequest
      || !sameDebugOwner(projectionFor(workspaceId).debugOwner, owner)
      || stack.status !== 'ready'
      || stack.workspaceId !== workspaceId
      || stack.sessionId !== owner.sessionId
      || stack.generation !== owner.generation
    ) return;
    const frame = stack.value[0];
    if (frame) selectedStackFrames.set(workspaceId, frame);
    else selectedStackFrames.delete(workspaceId);
    publishProjection(workspaceId, { currentDebugFrame: frame });
  } catch (error) {
    if (error instanceof RunServicesError && error.reason === 'stale-completion') return;
  }
};

const handleDebugStatus = (
  workspaceId: string,
  snapshot: PiariumDebugSessionStatus,
  state: WorkspaceLoadState,
): void => {
  if (snapshot.workspaceId !== workspaceId || !isCurrentLoadState(workspaceId, state)) return;
  state.debugRevision += 1;
  const current = projectionFor(workspaceId);
  const owner = debugOwnerFrom(snapshot);
  if (
    snapshot.status === 'running'
    || snapshot.status === 'paused'
    || snapshot.status === 'starting'
  ) {
    if (
      owner
      && (
        isOlderDebugOwner(owner, state.latestDebugOwner)
        || (
          state.retiredDebugGeneration !== undefined
          && owner.generation <= state.retiredDebugGeneration
        )
      )
    ) return;
    if (owner) state.latestDebugOwner = owner;
    state.debugStatus = 'active';
    const changedOwner = !sameDebugOwner(current.debugOwner, owner);
    if (changedOwner) selectedStackFrames.delete(workspaceId);
    debugStatuses.set(workspaceId, snapshot.status);
    publishProjection(workspaceId, {
      debugOwner: owner,
      currentDebugFrame: snapshot.status === 'paused' && !changedOwner
        ? current.currentDebugFrame
        : undefined,
    });
    if (snapshot.status === 'paused' && owner) void resolveTopFrame(workspaceId, owner, state);
    return;
  }

  if (owner && isOlderDebugOwner(owner, state.latestDebugOwner)) return;
  if (owner && current.debugOwner && !sameDebugOwner(owner, current.debugOwner)) return;
  const retiredOwner = owner ?? current.debugOwner;
  if (retiredOwner) {
    state.latestDebugOwner = retiredOwner;
    state.retiredDebugGeneration = Math.max(
      state.retiredDebugGeneration ?? 0,
      retiredOwner.generation,
    );
  }
  state.debugStatus = 'inactive';
  state.frameRequest += 1;
  selectedStackFrames.delete(workspaceId);
  debugStatuses.delete(workspaceId);
  publishProjection(workspaceId, {
    debugOwner: undefined,
    currentDebugFrame: undefined,
  });
};

const handleDebugEvent = (
  workspaceId: string,
  event: PiariumDebugEvent,
  state: WorkspaceLoadState,
): void => {
  if (event.kind === 'status') {
    handleDebugStatus(workspaceId, event.snapshot, state);
    return;
  }
  if (event.kind === 'breakpoints' && event.snapshot.workspaceId === workspaceId) {
    state.breakpointRevision += 1;
    publishProjection(workspaceId, { breakpoints: [...event.snapshot.breakpoints] });
  }
};

const handleTaskEvent = (event: PiariumTaskEvent): void => {
  if (event.kind !== 'status') return;
  const workspaceId = event.snapshot.workspaceId;
  const active = activeTaskRuns.get(workspaceId) ?? new Set<string>();
  const runId = event.snapshot.runId;
  if (runId && event.snapshot.status === 'running') active.add(runId);
  else if (runId) active.delete(runId);
  if (active.size > 0) activeTaskRuns.set(workspaceId, active);
  else activeTaskRuns.delete(workspaceId);
  refreshContextKeys();
  emitWorkspace(workspaceId);
};

const handleTestStatus = (
  workspaceId: string,
  snapshot: PiariumTestRunStatus,
  state: WorkspaceLoadState,
): void => {
  if (snapshot.workspaceId !== workspaceId || !isCurrentLoadState(workspaceId, state)) return;
  state.testRevision += 1;
  const current = projectionFor(workspaceId);
  const owner = testOwnerFrom(snapshot);
  if (owner) {
    if (isOlderTestOwner(owner, current.testOwner)) return;
    const changedOwner = !sameTestOwner(current.testOwner, owner);
    publishProjection(workspaceId, {
      testOwner: owner,
      latestTestFailure: changedOwner ? undefined : current.latestTestFailure,
    });
    return;
  }
  if (snapshot.status === 'absent' || snapshot.status === 'idle' || snapshot.status === 'empty') {
    publishProjection(workspaceId, { testOwner: undefined, latestTestFailure: undefined });
  }
};

const handleTestEvent = (
  workspaceId: string,
  event: PiariumTestEvent,
  state: WorkspaceLoadState,
): void => {
  if (event.kind === 'status') {
    handleTestStatus(workspaceId, event.snapshot, state);
    return;
  }
  const owner = projectionFor(workspaceId).testOwner;
  if (
    !isCurrentLoadState(workspaceId, state)
    || !owner
    || event.runId !== owner.runId
    || event.generation !== owner.generation
  ) return;
  if (event.kind === 'test' && event.test.status === 'failed') {
    publishProjection(workspaceId, { latestTestFailure: event.test });
    return;
  }
  if (event.kind === 'finished' && event.results) {
    const failure = [...event.results].reverse().find((test) => test.status === 'failed');
    if (failure) publishProjection(workspaceId, { latestTestFailure: failure });
  }
};

const hasConsumers = (workspaceId: string): boolean => (
  (viewCounts.get(workspaceId) ?? 0) > 0
  || (projectionListeners.get(workspaceId)?.size ?? 0) > 0
);

const bootstrapWorkspace = (
  workspaceId: string,
  apis: Bound,
  state: WorkspaceLoadState,
): void => {
  const breakpointRevision = state.breakpointRevision;
  void apis.debug.listBreakpoints(workspaceId).then((result) => {
    if (
      isCurrentLoadState(workspaceId, state)
      && state.breakpointRevision === breakpointRevision
      && result.workspaceId === workspaceId
    ) publishProjection(workspaceId, { breakpoints: [...result.breakpoints] });
  }).catch(() => undefined);

  const debugRevision = state.debugRevision;
  void apis.debug.getStatus(workspaceId).then((snapshot) => {
    if (isCurrentLoadState(workspaceId, state) && state.debugRevision === debugRevision) {
      handleDebugStatus(workspaceId, snapshot, state);
    }
  }).catch(() => undefined);

  const testRevision = state.testRevision;
  void apis.tests.getStatus(workspaceId).then((snapshot) => {
    if (isCurrentLoadState(workspaceId, state) && state.testRevision === testRevision) {
      handleTestStatus(workspaceId, snapshot, state);
    }
  }).catch(() => undefined);
};

const ensureSubscriptions = (workspaceId: string): void => {
  if (!bound || !hasConsumers(workspaceId) || subscriptions.has(workspaceId)) return;
  const apis = bound;
  const state: WorkspaceLoadState = {
    breakpointRevision: 0,
    debugRevision: 0,
    debugStatus: 'unknown',
    frameRequest: 0,
    mutationRequest: 0,
    testRevision: 0,
  };
  projections.set(workspaceId, emptyProjection(workspaceId));
  loadStates.set(workspaceId, state);
  const current: Subscription[] = [];
  subscriptions.set(workspaceId, current);
  current.push(apis.tasks.subscribe(workspaceId, handleTaskEvent));
  current.push(apis.debug.subscribe(
    workspaceId,
    (event) => handleDebugEvent(workspaceId, event, state),
  ));
  current.push(apis.tests.subscribe(
    workspaceId,
    (event) => handleTestEvent(workspaceId, event, state),
  ));
  bootstrapWorkspace(workspaceId, apis, state);
};

const closeSubscriptions = (workspaceId: string): void => {
  const current = subscriptions.get(workspaceId);
  if (current) {
    for (const subscription of current) subscription.close();
    subscriptions.delete(workspaceId);
  }
  loadStates.delete(workspaceId);
  projections.delete(workspaceId);
  selectedStackFrames.delete(workspaceId);
  activeTaskRuns.delete(workspaceId);
  debugStatuses.delete(workspaceId);
  refreshContextKeys();
  emitWorkspace(workspaceId);
};

const collectWorkspaceIds = (): string[] => [...new Set([
  ...viewCounts.keys(),
  ...projectionListeners.keys(),
  ...subscriptions.keys(),
  ...projections.keys(),
])];

const disposeRemoteWorkspaces = (apis: Bound, workspaceIds: readonly string[]): void => {
  for (const workspaceId of workspaceIds) {
    void apis.tasks.disposeWorkspace(workspaceId).catch((error) => {
      if (error instanceof RunServicesError && error.reason === 'stale-completion') return;
    });
    void apis.debug.disposeWorkspace(workspaceId).catch((error) => {
      if (error instanceof RunServicesError && error.reason === 'stale-completion') return;
    });
    void apis.tests.disposeWorkspace(workspaceId).catch((error) => {
      if (error instanceof RunServicesError && error.reason === 'stale-completion') return;
    });
  }
};

const closeRuntimeState = (): void => {
  for (const workspaceId of collectWorkspaceIds()) closeSubscriptions(workspaceId);
  activeTaskRuns.clear();
  debugStatuses.clear();
  projections.clear();
  loadStates.clear();
  selectedStackFrames.clear();
  refreshContextKeys();
};

const uninstallRuntimeLifecycle = (): void => {
  unsubscribeEndpointWillChange?.();
  unsubscribeEndpointWillChange = null;
  unsubscribeEndpointChanged?.();
  unsubscribeEndpointChanged = null;
};

const installRuntimeLifecycle = (apis: Bound): void => {
  unsubscribeEndpointWillChange = subscribeRuntimeEndpointWillChange(() => {
    const workspaceIds = collectWorkspaceIds();
    disposeRemoteWorkspaces(apis, workspaceIds);
    closeRuntimeState();
  });
  unsubscribeEndpointChanged = subscribeRuntimeEndpointChanged(() => {
    if (bound !== apis) return;
    for (const workspaceId of collectWorkspaceIds()) ensureSubscriptions(workspaceId);
  });
};

export const bindRunDebugServices = (apis: Bound): void => {
  if (bound?.tasks === apis.tasks && bound.debug === apis.debug && bound.tests === apis.tests) return;
  const previous = bound;
  const workspaceIds = collectWorkspaceIds();
  uninstallRuntimeLifecycle();
  closeRuntimeState();
  if (previous) disposeRemoteWorkspaces(previous, workspaceIds);
  bound = apis;
  installRuntimeLifecycle(apis);
  for (const workspaceId of workspaceIds) ensureSubscriptions(workspaceId);
};

export const acquireRunDebugView = (workspaceId: string): void => {
  if (!workspaceId) return;
  viewCounts.set(workspaceId, (viewCounts.get(workspaceId) ?? 0) + 1);
  ensureSubscriptions(workspaceId);
};

export const releaseRunDebugView = (workspaceId: string): void => {
  const current = viewCounts.get(workspaceId) ?? 0;
  if (current <= 1) viewCounts.delete(workspaceId);
  else viewCounts.set(workspaceId, current - 1);
  if (!hasConsumers(workspaceId)) closeSubscriptions(workspaceId);
};

export const resetRunDebugServices = (): void => {
  uninstallRuntimeLifecycle();
  closeRuntimeState();
  viewCounts.clear();
  projectionListeners.clear();
  listeners.clear();
  bound = null;
};

export const getBoundRunDebugServices = (): Bound | null => bound;

export const peekRunDebugEditorProjection = (workspaceId: string): RunDebugEditorProjection => (
  projectionFor(workspaceId)
);

export const subscribeRunDebugEditorProjection = (
  workspaceId: string,
  listener: () => void,
): (() => void) => {
  const workspaceListeners = projectionListeners.get(workspaceId) ?? new Set<() => void>();
  workspaceListeners.add(listener);
  projectionListeners.set(workspaceId, workspaceListeners);
  ensureSubscriptions(workspaceId);
  return () => {
    workspaceListeners.delete(listener);
    if (workspaceListeners.size === 0) projectionListeners.delete(workspaceId);
    if (!hasConsumers(workspaceId)) closeSubscriptions(workspaceId);
  };
};

export const toggleRunDebugBreakpoint = async (
  identity: DocumentIdentity,
  line: number,
): Promise<PiariumDebugBreakpointsResult> => {
  const apis = bound;
  const state = loadStates.get(identity.workspaceId);
  if (!apis || !state || !isCurrentLoadState(identity.workspaceId, state)) {
    throw new Error('Run/debug editor projection is not active');
  }
  if (state.debugStatus === 'unknown') {
    const debugRevision = state.debugRevision;
    const snapshot = await apis.debug.getStatus(identity.workspaceId);
    if (!isCurrentLoadState(identity.workspaceId, state)) {
      throw new Error('Run/debug editor projection changed during breakpoint mutation');
    }
    if (state.debugRevision === debugRevision) {
      handleDebugStatus(identity.workspaceId, snapshot, state);
    }
  }
  const projection = projectionFor(identity.workspaceId);
  if (state.debugStatus === 'active' && !projection.debugOwner) {
    throw new Error('Active debug session owner is unavailable');
  }
  const currentLines = projection.breakpoints
    .filter((breakpoint) => breakpoint.resourceId === identity.resourceId)
    .map((breakpoint) => breakpoint.line);
  const lines = currentLines.includes(line)
    ? currentLines.filter((candidate) => candidate !== line)
    : [...currentLines, line];
  const request = ++state.mutationRequest;
  const mutation: Parameters<WorkspaceDebugAPI['setBreakpoints']>[0] = projection.debugOwner
    ? {
      workspaceId: identity.workspaceId,
      resourceId: identity.resourceId,
      lines,
      expectedSessionId: projection.debugOwner.sessionId,
      expectedGeneration: projection.debugOwner.generation,
    }
    : {
      workspaceId: identity.workspaceId,
      resourceId: identity.resourceId,
      lines,
      expectedSessionId: null,
      expectedGeneration: null,
    };
  const result = await apis.debug.setBreakpoints(mutation);
  if (
    bound === apis
    && isCurrentLoadState(identity.workspaceId, state)
    && request === state.mutationRequest
    && result.workspaceId === identity.workspaceId
  ) {
    state.breakpointRevision += 1;
    publishProjection(identity.workspaceId, { breakpoints: [...result.breakpoints] });
  }
  return result;
};

export const peekLastTestFailure = (workspaceId: string): PiariumTestItem | undefined => (
  projectionFor(workspaceId).latestTestFailure
);

export const rememberStackFrame = (workspaceId: string, frame: PiariumDebugStackFrame): void => {
  selectedStackFrames.set(workspaceId, frame);
  if (projectionFor(workspaceId).debugOwner) {
    publishProjection(workspaceId, { currentDebugFrame: frame });
  }
};

export const peekLastStackFrame = (workspaceId: string): PiariumDebugStackFrame | undefined => (
  selectedStackFrames.get(workspaceId) ?? projectionFor(workspaceId).currentDebugFrame
);

export const subscribeRunDebugUi = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const isRunDebugViewActive = (workspaceId: string): boolean => (
  (viewCounts.get(workspaceId) ?? 0) > 0
);
