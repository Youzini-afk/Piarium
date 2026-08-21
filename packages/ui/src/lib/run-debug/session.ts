import type {
  PiariumDebugEvent,
  PiariumDebugStackFrame,
  PiariumTaskEvent,
  PiariumTestEvent,
  PiariumTestItem,
  Subscription,
  WorkspaceDebugAPI,
  WorkspaceTasksAPI,
  WorkspaceTestAPI,
} from '@/lib/api/types';
import { RunServicesError } from '@/lib/api/run-errors';
import { subscribeRuntimeEndpointWillChange } from '@/lib/runtime-switch';
import { setWorkbenchContextKey } from '@/lib/workbench/editors/context-keys';

type Bound = {
  tasks: WorkspaceTasksAPI;
  debug: WorkspaceDebugAPI;
  tests: WorkspaceTestAPI;
};

let bound: Bound | null = null;
const viewCounts = new Map<string, number>();
const subscriptions = new Map<string, Subscription[]>();
let unsubscribeEndpoint: (() => void) | null = null;
const lastTestFailure = new Map<string, PiariumTestItem>();
const lastStackFrame = new Map<string, PiariumDebugStackFrame>();
const activeTaskRuns = new Map<string, Set<string>>();
const debugStatuses = new Map<string, 'starting' | 'running' | 'paused'>();
const listeners = new Set<() => void>();

const emit = (): void => {
  for (const listener of listeners) listener();
};

const collectWorkspaceIds = (): string[] => [...new Set([...viewCounts.keys(), ...subscriptions.keys()])];

const handleDebugEvent = (workspaceId: string, event: PiariumDebugEvent): void => {
  if (event.kind === 'status') {
    const status = event.snapshot.status;
    if (status === 'running' || status === 'paused' || status === 'starting') {
      debugStatuses.set(workspaceId, status);
    } else {
      debugStatuses.delete(workspaceId);
    }
    setWorkbenchContextKey('debugIsActive', debugStatuses.size > 0);
    setWorkbenchContextKey('debugIsPaused', [...debugStatuses.values()].some((value) => value === 'paused'));
    emit();
  }
};

const handleTaskEvent = (event: PiariumTaskEvent): void => {
  if (event.kind === 'status') {
    const workspaceId = event.snapshot.workspaceId;
    const active = activeTaskRuns.get(workspaceId) ?? new Set<string>();
    const runId = event.snapshot.runId;
    if (runId && event.snapshot.status === 'running') active.add(runId);
    else if (runId) active.delete(runId);
    if (active.size > 0) activeTaskRuns.set(workspaceId, active);
    else activeTaskRuns.delete(workspaceId);
    setWorkbenchContextKey('taskIsRunning', activeTaskRuns.size > 0);
    emit();
  }
};

const handleTestEvent = (workspaceId: string, event: PiariumTestEvent): void => {
  if (event.kind === 'test' && event.test.status === 'failed') {
    lastTestFailure.set(workspaceId, event.test);
    setWorkbenchContextKey('testHasFailure', true);
    emit();
  }
};

const closeSubscriptions = (workspaceId: string): void => {
  const current = subscriptions.get(workspaceId);
  if (!current) return;
  for (const subscription of current) subscription.close();
  subscriptions.delete(workspaceId);
  activeTaskRuns.delete(workspaceId);
  debugStatuses.delete(workspaceId);
  setWorkbenchContextKey('taskIsRunning', activeTaskRuns.size > 0);
  setWorkbenchContextKey('debugIsActive', debugStatuses.size > 0);
  setWorkbenchContextKey('debugIsPaused', [...debugStatuses.values()].some((value) => value === 'paused'));
};

const ensureSubscriptions = (workspaceId: string): void => {
  if (!bound || subscriptions.has(workspaceId)) return;
  subscriptions.set(workspaceId, [
    bound.tasks.subscribe(workspaceId, handleTaskEvent),
    bound.debug.subscribe(workspaceId, (event) => handleDebugEvent(workspaceId, event)),
    bound.tests.subscribe(workspaceId, (event) => handleTestEvent(workspaceId, event)),
  ]);
};

const resetLocal = (): void => {
  unsubscribeEndpoint?.();
  unsubscribeEndpoint = null;
  for (const workspaceId of [...subscriptions.keys()]) closeSubscriptions(workspaceId);
  viewCounts.clear();
  lastTestFailure.clear();
  lastStackFrame.clear();
  activeTaskRuns.clear();
  debugStatuses.clear();
  setWorkbenchContextKey('debugIsActive', false);
  setWorkbenchContextKey('debugIsPaused', false);
  setWorkbenchContextKey('testHasFailure', false);
  setWorkbenchContextKey('taskIsRunning', false);
  emit();
};

export const bindRunDebugServices = (apis: Bound): void => {
  if (bound?.tasks === apis.tasks && bound.debug === apis.debug && bound.tests === apis.tests) return;
  const previous = bound;
  const workspaceIds = collectWorkspaceIds();
  resetLocal();
  if (previous) {
    for (const workspaceId of workspaceIds) {
      void previous.tasks.disposeWorkspace(workspaceId).catch((error) => {
        if (error instanceof RunServicesError && error.reason === 'stale-completion') return;
      });
      void previous.debug.disposeWorkspace(workspaceId).catch((error) => {
        if (error instanceof RunServicesError && error.reason === 'stale-completion') return;
      });
      void previous.tests.disposeWorkspace(workspaceId).catch((error) => {
        if (error instanceof RunServicesError && error.reason === 'stale-completion') return;
      });
    }
  }
  bound = apis;
  unsubscribeEndpoint = subscribeRuntimeEndpointWillChange(() => {
    for (const workspaceId of collectWorkspaceIds()) {
      void apis.tasks.disposeWorkspace(workspaceId);
      void apis.debug.disposeWorkspace(workspaceId);
      void apis.tests.disposeWorkspace(workspaceId);
    }
  });
};

export const acquireRunDebugView = (workspaceId: string): void => {
  if (!bound || !workspaceId) return;
  viewCounts.set(workspaceId, (viewCounts.get(workspaceId) ?? 0) + 1);
  ensureSubscriptions(workspaceId);
};

export const releaseRunDebugView = (workspaceId: string): void => {
  const current = viewCounts.get(workspaceId) ?? 0;
  if (current <= 1) {
    viewCounts.delete(workspaceId);
    closeSubscriptions(workspaceId);
    return;
  }
  viewCounts.set(workspaceId, current - 1);
};

export const resetRunDebugServices = (): void => {
  resetLocal();
  bound = null;
};

export const getBoundRunDebugServices = (): Bound | null => bound;

export const peekLastTestFailure = (workspaceId: string): PiariumTestItem | undefined => (
  lastTestFailure.get(workspaceId)
);

export const rememberStackFrame = (workspaceId: string, frame: PiariumDebugStackFrame): void => {
  lastStackFrame.set(workspaceId, frame);
};

export const peekLastStackFrame = (workspaceId: string): PiariumDebugStackFrame | undefined => (
  lastStackFrame.get(workspaceId)
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
