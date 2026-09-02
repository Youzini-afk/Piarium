import { toJsonValue, type JsonCapabilityHandler } from '../extensions/json-value.js';

const TASK_METHODS = new Set(['list', 'run', 'cancel', 'disposeWorkspace']);
const DEBUG_METHODS = new Set([
  'getStatus',
  'listBreakpoints',
  'setBreakpoints',
  'start',
  'stop',
  'continue',
  'pause',
  'stepOver',
  'stepIn',
  'stepOut',
  'getThreads',
  'getStack',
  'getScopes',
  'getVariables',
  'evaluate',
  'listWatch',
  'addWatch',
  'removeWatch',
  'disposeWorkspace',
  'registerAdapter',
  'unregisterAdapter',
]);
const TEST_METHODS = new Set([
  'discover',
  'run',
  'cancel',
  'getStatus',
  'disposeWorkspace',
  'registerProvider',
  'unregisterProvider',
]);

const WORKSPACE_ID_METHODS = new Set([
  'list',
  'getStatus',
  'listBreakpoints',
  'listWatch',
  'disposeWorkspace',
]);

const workspaceIdOf = (params: unknown): string => {
  if (typeof params === 'string') return params;
  if (params && typeof params === 'object' && 'workspaceId' in params && typeof params.workspaceId === 'string') return params.workspaceId;
  return '';
};

const invoke = (owner: object, method: string, ...args: unknown[]): unknown => {
  const target = Reflect.get(owner, method);
  if (typeof target !== 'function') throw new Error(`Run service method is unavailable: ${method}`);
  return Reflect.apply(target, owner, args);
};

const dispatch = (owner: object, methods: ReadonlySet<string>, serviceId: string): JsonCapabilityHandler => async (
  method,
  params,
  context,
) => {
  const result = await (async (): Promise<unknown> => {
  if (!methods.has(method)) {
    throw new Error(`${serviceId} does not implement ${method}`);
  }
  if (WORKSPACE_ID_METHODS.has(method)) {
    const workspaceId = workspaceIdOf(params);
    if (method === 'disposeWorkspace') {
      await invoke(owner, 'disposeWorkspace', workspaceId);
      return { status: 'disposed' };
    }
    return invoke(owner, method, workspaceId);
  }
  const record = params && typeof params === 'object' ? params as Record<string, unknown> : {};
  if (method === 'registerAdapter') return invoke(owner, 'registerAdapter', params, context?.owner);
  if (method === 'unregisterAdapter') return invoke(owner, 'unregisterAdapter', record.adapterId, context?.owner);
  if (method === 'registerProvider') return invoke(owner, 'registerProvider', params, context?.owner);
  if (method === 'unregisterProvider') return invoke(owner, 'unregisterProvider', record.providerId, context?.owner);
  return invoke(owner, method, params);
  })();
  return toJsonValue(result);
};

export const createWorkspaceTasksCapabilityHandler = (tasks: object) => (
  dispatch(tasks, TASK_METHODS, 'workspace.tasks')
);

export const createWorkspaceDebugCapabilityHandler = (debug: object) => (
  dispatch(debug, DEBUG_METHODS, 'workspace.debug')
);

export const createWorkspaceTestCapabilityHandler = (tests: object) => (
  dispatch(tests, TEST_METHODS, 'workspace.test')
);
