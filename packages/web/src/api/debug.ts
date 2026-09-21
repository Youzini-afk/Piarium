import type {
  VarinDebugBreakpointListResult,
  VarinDebugBreakpointsResult,
  VarinDebugEvent,
  VarinDebugFeatureResult,
  VarinDebugScope,
  VarinDebugSessionStatus,
  VarinDebugStackFrame,
  VarinDebugThread,
  VarinDebugVariable,
  WorkspaceDebugAPI,
} from '@varin/application-client';
import { postRunJson, subscribeRunSse } from './run-transport';

const control = <T>(method: string, request: unknown): Promise<T> => (
  postRunJson('/api/debug/control', { method, request }) as Promise<T>
);

export const createWebWorkspaceDebugAPI = (): WorkspaceDebugAPI => ({
  getStatus: (workspaceId) => postRunJson('/api/debug/status', { workspaceId }) as Promise<VarinDebugSessionStatus>,
  listBreakpoints: (workspaceId) => postRunJson('/api/debug/breakpoints', { workspaceId }) as Promise<VarinDebugBreakpointListResult>,
  setBreakpoints: (request) => postRunJson('/api/debug/breakpoints', request) as Promise<VarinDebugBreakpointsResult>,
  start: (request) => postRunJson('/api/debug/start', request) as Promise<VarinDebugSessionStatus>,
  stop: (request) => postRunJson('/api/debug/stop', request) as Promise<VarinDebugSessionStatus>,
  continue: (request) => control('continue', request),
  pause: (request) => control('pause', request),
  stepOver: (request) => control('stepOver', request),
  stepIn: (request) => control('stepIn', request),
  stepOut: (request) => control('stepOut', request),
  getThreads: (request) => control<VarinDebugFeatureResult<VarinDebugThread[]>>('getThreads', request),
  getStack: (request) => control<VarinDebugFeatureResult<VarinDebugStackFrame[]>>('getStack', request),
  getScopes: (request) => control<VarinDebugFeatureResult<VarinDebugScope[]>>('getScopes', request),
  getVariables: (request) => control<VarinDebugFeatureResult<VarinDebugVariable[]>>('getVariables', request),
  evaluate: (request) => control<VarinDebugFeatureResult<string>>('evaluate', request),
  listWatch: (workspaceId) => control('listWatch', { workspaceId }),
  addWatch: (request) => control('addWatch', request),
  removeWatch: (request) => control('removeWatch', request),
  subscribe(workspaceId, listener, options) {
    return subscribeRunSse<VarinDebugEvent>('/api/debug/events', workspaceId, listener, options);
  },
  async disposeWorkspace(workspaceId) {
    await postRunJson('/api/debug/dispose-workspace', { workspaceId });
  },
});
