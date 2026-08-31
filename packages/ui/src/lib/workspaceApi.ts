import { getRegisteredRuntimeAPIs } from '@/lib/runtime-api/registry';
import type { WorkspaceAPI } from '@piarium/application-client';

export const getWorkspaceAPI = (): WorkspaceAPI => {
  const workspace = getRegisteredRuntimeAPIs()?.workspace;
  if (!workspace) {
    throw new Error('Workspace API is unavailable before Runtime APIs are registered');
  }
  return workspace;
};
