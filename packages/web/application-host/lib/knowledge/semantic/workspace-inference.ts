import {
  FAST_DECISION_PURPOSES,
  parseHarnessFastDecisionSettings,
  resolveFastDecisionPurpose,
  type HarnessEmbedParams,
  type HarnessEmbedResult,
  type HarnessFastDecisionParams,
  type HarnessFastDecisionPurpose,
  type HarnessFastDecisionPurposeStatus,
  type HarnessFastDecisionResult,
  type HarnessRerankParams,
  type HarnessRerankResult,
  type HarnessInferenceBindingSnapshot,
  type PiSettingsSnapshot,
} from '@varin/protocol';
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
    fastDecision: {
      purposes: Object.fromEntries(FAST_DECISION_PURPOSES.map((purpose) => [
        purpose,
        { status: 'unavailable', message: 'Inference settings are unavailable' },
      ])) as Partial<Record<HarnessFastDecisionPurpose, HarnessFastDecisionPurposeStatus>>,
    },
  };
  const unresolved = (read: () => unknown): { status: 'unconfigured' | 'invalid' | 'unavailable' } => {
    try { return { status: read() === undefined ? 'unconfigured' : 'unavailable' }; }
    catch { return { status: 'invalid' }; }
  };
  const purposes: Partial<Record<HarnessFastDecisionPurpose, HarnessFastDecisionPurposeStatus>> = {};
  const harness = settings.value.global?.harness;
  for (const purpose of FAST_DECISION_PURPOSES) {
    try {
      const resolution = resolveFastDecisionPurpose(
        parseHarnessFastDecisionSettings(
          (harness as { fastDecision?: unknown } | undefined)?.fastDecision,
        ),
        purpose,
      );
      purposes[purpose] = resolution.status === 'ready'
        // The snapshot cannot prove provider availability without a describe call.
        ? { status: 'unavailable', message: 'Inference settings are unavailable' }
        : { status: resolution.status };
    } catch {
      purposes[purpose] = { status: 'invalid', message: 'Fast decision settings are malformed' };
    }
  }
  return {
    embedding: unresolved(() => embeddingSettingsFromSnapshot(settings.value)),
    rerank: unresolved(() => rerankSettingsFromSnapshot(settings.value)),
    fastDecision: { purposes },
  };
}

export interface WorkspaceInferenceBroker {
  requestForWorkspace(cwd: string, method: 'harness.embed', params: HarnessEmbedParams): Promise<HarnessEmbedResult>;
  requestForWorkspace(cwd: string, method: 'harness.rerank', params: HarnessRerankParams): Promise<HarnessRerankResult>;
  requestForWorkspace(
    cwd: string,
    method: 'harness.fastDecision',
    params: HarnessFastDecisionParams,
  ): Promise<HarnessFastDecisionResult>;
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
  method: 'harness.fastDecision',
  params: HarnessFastDecisionParams,
  signal?: AbortSignal,
): Promise<HarnessFastDecisionResult>;
export function requestWorkspaceInference(
  broker: WorkspaceInferenceBroker,
  cwd: string,
  method: 'harness.embed' | 'harness.rerank' | 'harness.fastDecision',
  params: HarnessEmbedParams | HarnessRerankParams | HarnessFastDecisionParams,
  signal?: AbortSignal,
): Promise<HarnessEmbedResult | HarnessRerankResult | HarnessFastDecisionResult> {
  signal?.throwIfAborted();
  const request = method === 'harness.embed'
    ? broker.requestForWorkspace(cwd, method, params as HarnessEmbedParams)
    : method === 'harness.fastDecision'
      ? broker.requestForWorkspace(cwd, method, params as HarnessFastDecisionParams)
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
