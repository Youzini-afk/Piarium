import type { RuntimeAPIs, WorkspaceAPI } from './api/types';
import { createWorkspaceHttpAPI } from './workspaceApiHttp';

let fallbackApi: WorkspaceAPI | null = null;

const getFallbackApi = (): WorkspaceAPI => {
  if (!fallbackApi) {
    fallbackApi = createWorkspaceHttpAPI();
  }
  return fallbackApi;
};

export const getWorkspaceAPI = (): WorkspaceAPI => {
  const apis = typeof window !== 'undefined'
    ? (window as typeof window & { __PIARIUM_RUNTIME_APIS__?: RuntimeAPIs }).__PIARIUM_RUNTIME_APIS__
    : undefined;

  return apis?.workspace ?? getFallbackApi();
};
