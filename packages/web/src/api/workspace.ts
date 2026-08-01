import { createWorkspaceHttpAPI } from '@openchamber/ui/lib/workspaceApiHttp';
import type { WorkspaceAPI } from '@openchamber/ui/lib/api/types';

export const createWebWorkspaceAPI = (): WorkspaceAPI => createWorkspaceHttpAPI();
