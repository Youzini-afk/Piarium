import { createWorkspaceHttpAPI } from '@piarium/ui/lib/workspaceApiHttp';
import type { WorkspaceAPI } from '@piarium/application-client';

export const createWebWorkspaceAPI = (): WorkspaceAPI => createWorkspaceHttpAPI();
