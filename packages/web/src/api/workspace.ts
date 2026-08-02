import { createWorkspaceHttpAPI } from '@piarium/ui/lib/workspaceApiHttp';
import type { WorkspaceAPI } from '@piarium/ui/lib/api/types';

export const createWebWorkspaceAPI = (): WorkspaceAPI => createWorkspaceHttpAPI();
