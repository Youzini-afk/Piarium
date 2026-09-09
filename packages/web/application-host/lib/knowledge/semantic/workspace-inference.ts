import type {
  HarnessEmbedParams,
  HarnessEmbedResult,
  HarnessRerankParams,
  HarnessRerankResult,
  HarnessInferenceBindingSnapshot,
  PiSettingsSnapshot,
} from '@piarium/protocol';
import { embeddingSettingsFromSnapshot } from './backend.js';
import { rerankSettingsFromSnapshot } from '../../harness/explore-rerank.js';

export function resolveInferenceBinding(
  settings: PromiseSettledResult<PiSettingsSnapshot>,
  described: PromiseSettledResult<HarnessInferenceBindingSnapshot>,
): HarnessInferenceBindingSnapshot {
  if (described.status === 'fulfilled') return described.value;
  if (settings.status !== 'fulfilled') return {
    embedding: { status: 'unavailable', message: 'Inference settings are unavailable' },
    rerank: { status: 'unavailable', message: 'Inference settings are unavailable' },
  };
  const unresolved = (read: () => unknown): { status: 'unconfigured' | 'invalid' | 'unavailable' } => {
    try { return { status: read() === undefined ? 'unconfigured' : 'unavailable' }; }
    catch { return { status: 'invalid' }; }
  };
  return {
    embedding: unresolved(() => embeddingSettingsFromSnapshot(settings.value)),
    rerank: unresolved(() => rerankSettingsFromSnapshot(settings.value)),
  };
}

export interface WorkspaceInferenceBroker {
  requestForWorkspace(cwd: string, method: 'harness.embed', params: HarnessEmbedParams): Promise<HarnessEmbedResult>;
  requestForWorkspace(cwd: string, method: 'harness.rerank', params: HarnessRerankParams): Promise<HarnessRerankResult>;
  requestForWorkspace(
    cwd: string,
    method: 'harness.inference.cancel',
    params: { batchId: string },
  ): Promise<{ cancelled: boolean }>;
}

const abortReason = (signal: AbortSignal): unknown => {
  try { signal.throwIfAborted(); } catch (error) { return error; }
  return new DOMException('The operation was aborted', 'AbortError');
};

export function requestWorkspaceInference(
  broker: WorkspaceInferenceBroker,
  cwd: string,
  method: 'harness.embed',
  params: HarnessEmbedParams,
  signal?: AbortSignal,
): Promise<HarnessEmbedResult>;
export function requestWorkspaceInference(
  broker: WorkspaceInferenceBroker,
  cwd: string,
  method: 'harness.rerank',
  params: HarnessRerankParams,
  signal?: AbortSignal,
): Promise<HarnessRerankResult>;
export function requestWorkspaceInference(
  broker: WorkspaceInferenceBroker,
  cwd: string,
  method: 'harness.embed' | 'harness.rerank',
  params: HarnessEmbedParams | HarnessRerankParams,
  signal?: AbortSignal,
): Promise<HarnessEmbedResult | HarnessRerankResult> {
  signal?.throwIfAborted();
  const request = method === 'harness.embed'
    ? broker.requestForWorkspace(cwd, method, params as HarnessEmbedParams)
    : broker.requestForWorkspace(cwd, method, params as HarnessRerankParams);
  if (!signal) return request;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (operation: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      operation();
    };
    const onAbort = (): void => {
      finish(() => reject(abortReason(signal)));
      void broker.requestForWorkspace(cwd, 'harness.inference.cancel', { batchId: params.batchId })
        .catch(() => undefined);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    void request.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
    if (signal.aborted) onAbort();
  });
}
