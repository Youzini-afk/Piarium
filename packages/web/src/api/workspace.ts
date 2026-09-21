import { createWorkspaceHttpAPI } from '@varin/ui/lib/workspaceApiHttp';
import type { WorkspaceAPI } from '@varin/application-client';

export const createWebWorkspaceAPI = (): WorkspaceAPI => createWorkspaceHttpAPI();
