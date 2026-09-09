import type { HarnessEmbeddingSettings, HarnessRerankSettings } from '@piarium/protocol';

export type InferenceDraftResult<T> =
  | { status: 'delete' }
  | { status: 'incomplete' }
  | { status: 'ready'; value: T };

export function embeddingFromDraft(
  current: HarnessEmbeddingSettings | undefined,
  providerId: string,
  modelId: string,
): InferenceDraftResult<HarnessEmbeddingSettings> {
  const provider = providerId.trim();
  const model = modelId.trim();
  if (!provider) return { status: 'delete' };
  if (!model) return { status: 'incomplete' };
  return {
    status: 'ready',
    value: { ...current, protocol: 'openai-compatible', providerId: provider, modelId: model },
  };
}

export function rerankFromDraft(
  current: HarnessRerankSettings | undefined,
  providerId: string,
  modelId: string,
  endpoint: string,
): InferenceDraftResult<HarnessRerankSettings> {
  const provider = providerId.trim();
  const model = modelId.trim();
  if (!provider) return { status: 'delete' };
  if (!model) return { status: 'incomplete' };
  const value: HarnessRerankSettings = {
    ...current,
    protocol: 'http-rerank',
    providerId: provider,
    modelId: model,
  };
  if (endpoint.trim()) value.endpoint = endpoint.trim();
  else delete value.endpoint;
  return { status: 'ready', value };
}
