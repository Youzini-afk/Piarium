import type { SurfaceContribution } from '@piarium/extension-surface';

export interface WorkbenchShellRenderStagingHandle {
  dispose(): Promise<void>;
}

export interface WorkbenchShellStagingRequest {
  contribution: SurfaceContribution;
  id: number;
  props: Readonly<Record<string, unknown>>;
  reject(error: unknown): void;
  resolve(): void;
  settled: boolean;
}

let requestSequence = 0;
let activeRequest: WorkbenchShellStagingRequest | null = null;
let stagingHostCount = 0;
const listeners = new Set<() => void>();

const publish = (): void => {
  for (const listener of listeners) listener();
};

export const subscribeWorkbenchShellStaging = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const getWorkbenchShellStagingRequest = (): WorkbenchShellStagingRequest | null => activeRequest;

export const settleWorkbenchShellStagingReady = (request: WorkbenchShellStagingRequest): void => {
  if (activeRequest !== request || request.settled) return;
  request.settled = true;
  request.resolve();
};

export const settleWorkbenchShellStagingFailure = (
  request: WorkbenchShellStagingRequest,
  error: unknown,
): void => {
  if (activeRequest !== request || request.settled) return;
  request.settled = true;
  request.reject(error);
};

export const stageWorkbenchShellRender = (
  contribution: SurfaceContribution,
  props: Readonly<Record<string, unknown>>,
): Promise<WorkbenchShellRenderStagingHandle> => {
  if (stagingHostCount === 0) {
    return Promise.reject(new Error('Workbench shell staging host is unavailable'));
  }
  if (activeRequest && !activeRequest.settled) {
    settleWorkbenchShellStagingFailure(activeRequest, new Error('Workbench shell staging was superseded'));
  }
  const id = ++requestSequence;
  return new Promise<void>((resolve, reject) => {
    activeRequest = {
      contribution,
      id,
      props,
      reject,
      resolve,
      settled: false,
    };
    publish();
  }).then(() => ({
    dispose: async () => {
      if (activeRequest?.id !== id) return;
      activeRequest = null;
      publish();
    },
  }));
};

export const mountWorkbenchShellStagingHost = (): (() => void) => {
  stagingHostCount += 1;
  return () => {
    stagingHostCount -= 1;
    if (stagingHostCount === 0 && activeRequest) {
      if (!activeRequest.settled) {
        settleWorkbenchShellStagingFailure(activeRequest, new Error('Workbench shell staging host was removed'));
      }
      activeRequest = null;
      publish();
    }
  };
};
