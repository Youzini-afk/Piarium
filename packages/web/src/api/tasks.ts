import type {
  VarinTaskEvent,
  VarinTaskListResult,
  VarinTaskRunStatus,
  WorkspaceTasksAPI,
} from '@varin/application-client';
import { postRunJson, subscribeRunSse } from './run-transport';

export const createWebWorkspaceTasksAPI = (): WorkspaceTasksAPI => ({
  list: (workspaceId) => postRunJson('/api/tasks/list', { workspaceId }) as Promise<VarinTaskListResult>,
  run: (request) => postRunJson('/api/tasks/run', request) as Promise<VarinTaskRunStatus>,
  cancel: (request) => postRunJson('/api/tasks/cancel', request) as Promise<VarinTaskRunStatus>,
  subscribe(workspaceId, listener, options) {
    return subscribeRunSse<VarinTaskEvent>('/api/tasks/events', workspaceId, listener, options);
  },
  async disposeWorkspace(workspaceId) {
    await postRunJson('/api/tasks/dispose-workspace', { workspaceId });
  },
});
