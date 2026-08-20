import type {
  PiariumDebugFeatureResult,
  PiariumDebugSessionStatus,
  WorkspaceDebugAPI,
  WorkspaceTasksAPI,
  WorkspaceTestAPI,
} from '@piarium/ui/lib/api/types';

const absentDebug = (workspaceId: string): PiariumDebugSessionStatus => ({
  status: 'absent',
  workspaceId,
});

const unsupportedFeature = async <T>(): Promise<PiariumDebugFeatureResult<T>> => (
  { status: 'absent' }
);

export const createVSCodeWorkspaceTasksAPI = (): WorkspaceTasksAPI => ({
  list: async (workspaceId) => ({ status: 'failure', workspaceId, message: 'Tasks are not supported in the VS Code runtime', configurations: [] }),
  run: async (request) => ({ status: 'failed', workspaceId: request.workspaceId, message: 'Tasks are not supported in the VS Code runtime' }),
  cancel: async (request) => ({ status: 'failed', workspaceId: request.workspaceId, message: 'Tasks are not supported in the VS Code runtime' }),
  subscribe() {
    return { close() {} };
  },
  disposeWorkspace: async () => {},
});

export const createVSCodeWorkspaceDebugAPI = (): WorkspaceDebugAPI => ({
  getStatus: async (workspaceId) => absentDebug(workspaceId),
  listBreakpoints: async (workspaceId) => ({ status: 'ready', workspaceId, breakpoints: [] }),
  setBreakpoints: async (request) => ({ status: 'ready', workspaceId: request.workspaceId, breakpoints: [] }),
  start: async (request) => absentDebug(request.workspaceId),
  stop: async (request) => absentDebug(request.workspaceId),
  continue: async (request) => absentDebug(request.workspaceId),
  pause: async (request) => absentDebug(request.workspaceId),
  stepOver: async (request) => absentDebug(request.workspaceId),
  stepIn: async (request) => absentDebug(request.workspaceId),
  stepOut: async (request) => absentDebug(request.workspaceId),
  getThreads: unsupportedFeature,
  getStack: unsupportedFeature,
  getScopes: unsupportedFeature,
  getVariables: unsupportedFeature,
  evaluate: unsupportedFeature,
  listWatch: async (workspaceId) => ({ status: 'ready', workspaceId, expressions: [] }),
  addWatch: async (request) => ({ status: 'failed', workspaceId: request.workspaceId, message: 'Debug is not supported in the VS Code runtime' }),
  removeWatch: async (request) => ({ status: 'ready', workspaceId: request.workspaceId, expressions: [] }),
  subscribe() {
    return { close() {} };
  },
  disposeWorkspace: async () => {},
});

export const createVSCodeWorkspaceTestAPI = (): WorkspaceTestAPI => ({
  discover: async (request) => ({ status: 'absent', workspaceId: request.workspaceId, tests: [] }),
  run: async (request) => ({ status: 'absent', workspaceId: request.workspaceId }),
  cancel: async (request) => ({ status: 'absent', workspaceId: request.workspaceId }),
  getStatus: async (workspaceId) => ({ status: 'absent', workspaceId }),
  subscribe() {
    return { close() {} };
  },
  disposeWorkspace: async () => {},
});
