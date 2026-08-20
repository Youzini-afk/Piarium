import type {
  PiariumTestDiscoverResult,
  PiariumTestEvent,
  PiariumTestRunStatus,
  WorkspaceTestAPI,
} from '@piarium/ui/lib/api/types';
import { postRunJson, subscribeRunSse } from './run-transport';

export const createWebWorkspaceTestAPI = (): WorkspaceTestAPI => ({
  discover: (request) => postRunJson('/api/tests/discover', request) as Promise<PiariumTestDiscoverResult>,
  run: (request) => postRunJson('/api/tests/run', request) as Promise<PiariumTestRunStatus>,
  cancel: (request) => postRunJson('/api/tests/cancel', request) as Promise<PiariumTestRunStatus>,
  getStatus: (workspaceId) => postRunJson('/api/tests/status', { workspaceId }) as Promise<PiariumTestRunStatus>,
  subscribe(workspaceId, listener, options) {
    return subscribeRunSse<PiariumTestEvent>('/api/tests/events', workspaceId, listener, options);
  },
  async disposeWorkspace(workspaceId) {
    await postRunJson('/api/tests/dispose-workspace', { workspaceId });
  },
});
