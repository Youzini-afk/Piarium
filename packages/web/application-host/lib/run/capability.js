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

const workspaceIdOf = (params) => {
  if (typeof params === 'string') return params;
  if (params && typeof params === 'object' && typeof params.workspaceId === 'string') return params.workspaceId;
  return '';
};

const dispatch = (owner, methods, serviceId) => async (method, params, context) => {
  if (!methods.has(method)) {
    throw new Error(`${serviceId} does not implement ${method}`);
  }
  if (WORKSPACE_ID_METHODS.has(method)) {
    const workspaceId = workspaceIdOf(params);
    if (method === 'disposeWorkspace') {
      await owner.disposeWorkspace(workspaceId);
      return { status: 'disposed' };
    }
    return owner[method](workspaceId);
  }
  if (method === 'registerAdapter') return owner.registerAdapter(params, context?.owner);
  if (method === 'unregisterAdapter') return owner.unregisterAdapter(params?.adapterId, context?.owner);
  if (method === 'registerProvider') return owner.registerProvider(params, context?.owner);
  if (method === 'unregisterProvider') return owner.unregisterProvider(params?.providerId, context?.owner);
  return owner[method](params);
};

export const createWorkspaceTasksCapabilityHandler = (tasks) => (
  dispatch(tasks, TASK_METHODS, 'workspace.tasks')
);

export const createWorkspaceDebugCapabilityHandler = (debug) => (
  dispatch(debug, DEBUG_METHODS, 'workspace.debug')
);

export const createWorkspaceTestCapabilityHandler = (tests) => (
  dispatch(tests, TEST_METHODS, 'workspace.test')
);
