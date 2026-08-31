import type {
  PiariumDebugBreakpointListResult,
  PiariumDebugBreakpointsResult,
  PiariumDebugEvent,
  PiariumDebugFeatureResult,
  PiariumDebugScope,
  PiariumDebugSessionStatus,
  PiariumDebugStackFrame,
  PiariumDebugThread,
  PiariumDebugVariable,
  WorkspaceDebugAPI,
} from '@piarium/application-client';
import { postRunJson, subscribeRunSse } from './run-transport';

const control = <T>(method: string, request: unknown): Promise<T> => (
  postRunJson('/api/debug/control', { method, request }) as Promise<T>
);

export const createWebWorkspaceDebugAPI = (): WorkspaceDebugAPI => ({
  getStatus: (workspaceId) => postRunJson('/api/debug/status', { workspaceId }) as Promise<PiariumDebugSessionStatus>,
  listBreakpoints: (workspaceId) => postRunJson('/api/debug/breakpoints', { workspaceId }) as Promise<PiariumDebugBreakpointListResult>,
  setBreakpoints: (request) => postRunJson('/api/debug/breakpoints', request) as Promise<PiariumDebugBreakpointsResult>,
  start: (request) => postRunJson('/api/debug/start', request) as Promise<PiariumDebugSessionStatus>,
  stop: (request) => postRunJson('/api/debug/stop', request) as Promise<PiariumDebugSessionStatus>,
  continue: (request) => control('continue', request),
  pause: (request) => control('pause', request),
  stepOver: (request) => control('stepOver', request),
  stepIn: (request) => control('stepIn', request),
  stepOut: (request) => control('stepOut', request),
  getThreads: (request) => control<PiariumDebugFeatureResult<PiariumDebugThread[]>>('getThreads', request),
  getStack: (request) => control<PiariumDebugFeatureResult<PiariumDebugStackFrame[]>>('getStack', request),
  getScopes: (request) => control<PiariumDebugFeatureResult<PiariumDebugScope[]>>('getScopes', request),
  getVariables: (request) => control<PiariumDebugFeatureResult<PiariumDebugVariable[]>>('getVariables', request),
  evaluate: (request) => control<PiariumDebugFeatureResult<string>>('evaluate', request),
  listWatch: (workspaceId) => control('listWatch', { workspaceId }),
  addWatch: (request) => control('addWatch', request),
  removeWatch: (request) => control('removeWatch', request),
  subscribe(workspaceId, listener, options) {
    return subscribeRunSse<PiariumDebugEvent>('/api/debug/events', workspaceId, listener, options);
  },
  async disposeWorkspace(workspaceId) {
    await postRunJson('/api/debug/dispose-workspace', { workspaceId });
  },
});
