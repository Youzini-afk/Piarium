import type {
  VarinTestDiscoverResult,
  VarinTestEvent,
  VarinTestRunStatus,
  WorkspaceTestAPI,
} from '@varin/application-client';
import { postRunJson, subscribeRunSse } from './run-transport';

export const createWebWorkspaceTestAPI = (): WorkspaceTestAPI => ({
  discover: (request) => postRunJson('/api/tests/discover', request) as Promise<VarinTestDiscoverResult>,
  run: (request) => postRunJson('/api/tests/run', request) as Promise<VarinTestRunStatus>,
  cancel: (request) => postRunJson('/api/tests/cancel', request) as Promise<VarinTestRunStatus>,
  getStatus: (workspaceId) => postRunJson('/api/tests/status', { workspaceId }) as Promise<VarinTestRunStatus>,
  subscribe(workspaceId, listener, options) {
    return subscribeRunSse<VarinTestEvent>('/api/tests/events', workspaceId, listener, options);
  },
  async disposeWorkspace(workspaceId) {
    await postRunJson('/api/tests/dispose-workspace', { workspaceId });
  },
});
