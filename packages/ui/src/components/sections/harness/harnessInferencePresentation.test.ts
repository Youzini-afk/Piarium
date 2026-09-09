import { describe, expect, it } from 'vitest';
import { embeddingFromDraft, rerankFromDraft } from './harnessInferencePresentation';

describe('harness inference settings presentation', () => {
  it('round-trips hidden embedding protocol fields and separates deletion from incomplete input', () => {
    expect(embeddingFromDraft({
      protocol: 'openai-compatible', providerId: 'old', modelId: 'old', dimensions: 1024, maxTokens: 8192,
    }, 'new', 'embed-2')).toEqual({
      status: 'ready',
      value: {
        protocol: 'openai-compatible', providerId: 'new', modelId: 'embed-2', dimensions: 1024, maxTokens: 8192,
      },
    });
    expect(embeddingFromDraft(undefined, '', 'leftover')).toEqual({ status: 'delete' });
    expect(embeddingFromDraft(undefined, 'provider', '')).toEqual({ status: 'incomplete' });
  });

  it('round-trips rerank limits while editing or explicitly clearing its endpoint', () => {
    const current = {
      protocol: 'http-rerank' as const,
      providerId: 'old', modelId: 'old', endpoint: '/rank', maxDocumentTokens: 2048,
    };
    expect(rerankFromDraft(current, 'new', 'rerank-2', '')).toEqual({
      status: 'ready',
      value: { protocol: 'http-rerank', providerId: 'new', modelId: 'rerank-2', maxDocumentTokens: 2048 },
    });
    expect(rerankFromDraft(current, 'new', '', '/rank')).toEqual({ status: 'incomplete' });
  });
});
