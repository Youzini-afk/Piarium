import {
  createWorkspaceRecoveryAPI,
  type WorkspaceRecoveryAPI,
  type WorkspaceRecoveryFailedResult,
  type WorkspaceRecoveryFailure,
} from '@piarium/extension-contract';
import { getRegisteredRuntimeAPIs } from '@/lib/runtime-api/registry';

export class WorkspaceRecoveryServiceError extends Error {
  readonly failure: WorkspaceRecoveryFailure;

  constructor(failure: WorkspaceRecoveryFailure) {
    super(failure.message);
    this.name = 'WorkspaceRecoveryServiceError';
    this.failure = failure;
  }
}

export const getWorkspaceRecoveryAPI = (): WorkspaceRecoveryAPI => {
  const extensions = getRegisteredRuntimeAPIs()?.extensions;
  if (!extensions) throw new Error('Workspace recovery service is unavailable');
  return createWorkspaceRecoveryAPI((request) => extensions.invokeService(request));
};

export const requireWorkspaceRecoveryResult = <T extends { status: string }>(
  result: T | WorkspaceRecoveryFailedResult,
): Exclude<T, WorkspaceRecoveryFailedResult> => {
  if (result.status === 'failed') {
    throw new WorkspaceRecoveryServiceError((result as WorkspaceRecoveryFailedResult).failure);
  }
  return result as Exclude<T, WorkspaceRecoveryFailedResult>;
};
