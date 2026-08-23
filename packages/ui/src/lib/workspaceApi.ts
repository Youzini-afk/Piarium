import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import type { WorkspaceAPI } from './api/types';

export const getWorkspaceAPI = (): WorkspaceAPI => {
  const workspace = getRegisteredRuntimeAPIs()?.workspace;
  if (!workspace) {
    throw new Error('Workspace API is unavailable before Runtime APIs are registered');
  }
  return workspace;
};
