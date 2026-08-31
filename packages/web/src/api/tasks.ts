import type {
  PiariumTaskEvent,
  PiariumTaskListResult,
  PiariumTaskRunStatus,
  WorkspaceTasksAPI,
} from '@piarium/application-client';
import { postRunJson, subscribeRunSse } from './run-transport';

export const createWebWorkspaceTasksAPI = (): WorkspaceTasksAPI => ({
  list: (workspaceId) => postRunJson('/api/tasks/list', { workspaceId }) as Promise<PiariumTaskListResult>,
  run: (request) => postRunJson('/api/tasks/run', request) as Promise<PiariumTaskRunStatus>,
  cancel: (request) => postRunJson('/api/tasks/cancel', request) as Promise<PiariumTaskRunStatus>,
  subscribe(workspaceId, listener, options) {
    return subscribeRunSse<PiariumTaskEvent>('/api/tasks/events', workspaceId, listener, options);
  },
  async disposeWorkspace(workspaceId) {
    await postRunJson('/api/tasks/dispose-workspace', { workspaceId });
  },
});
