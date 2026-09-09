import { describe, expect, it } from 'vitest';
import type { HarnessEmbedParams, HarnessEmbedResult, PiSettingsSnapshot } from '@piarium/protocol';
import { requestWorkspaceInference, resolveInferenceBinding, type WorkspaceInferenceBroker } from './workspace-inference.js';

describe('workspace inference transport', () => {
  it('keeps interleaved workspace text and bindings on the requested workers', async () => {
    const calls: Array<{ cwd: string; text: string }> = [];
    const releases = new Map<string, () => void>();
    const broker = {
      requestForWorkspace: async (cwd: string, method: string, params: HarnessEmbedParams) => {
        if (method !== 'harness.embed') return { cancelled: true };
        calls.push({ cwd, text: params.items[0]!.text });
        await new Promise<void>((resolve) => releases.set(cwd, resolve));
        return {
          batchId: params.batchId,
          space: {
            providerId: params.providerId,
            modelId: params.modelId,
            protocol: params.protocol,
            configurationId: params.configurationId,
            dim: 1,
            maxTokens: params.maxTokens ?? 1,
            spaceId: `space:${cwd}`,
          },
          items: [{ id: params.items[0]!.id, index: 0, vector: [cwd === 'A' ? 1 : 2] }],
        } satisfies HarnessEmbedResult;
      },
    } as unknown as WorkspaceInferenceBroker;
    const request = (cwd: string, text: string): HarnessEmbedParams => ({
      purpose: 'document', providerId: `provider-${cwd}`, modelId: `model-${cwd}`,
      protocol: 'openai-compatible', configurationId: `config-${cwd}`,
      items: [{ id: cwd, text }], batchId: `batch-${cwd}`, maxTokens: 10,
    });
    const a = requestWorkspaceInference(broker, 'A', 'harness.embed', request('A', 'text-a'));
    const b = requestWorkspaceInference(broker, 'B', 'harness.embed', request('B', 'text-b'));
    await Promise.resolve();
    releases.get('B')?.();
    releases.get('A')?.();
    const [aResult, bResult] = await Promise.all([a, b]);
    expect(calls).toEqual(expect.arrayContaining([{ cwd: 'A', text: 'text-a' }, { cwd: 'B', text: 'text-b' }]));
    expect(aResult.space.spaceId).toBe('space:A');
    expect(bResult.space.spaceId).toBe('space:B');
  });

  it('distinguishes missing bindings from malformed settings and unavailable authority', () => {
    const failed = { status: 'rejected' as const, reason: new Error('worker unavailable') };
    const snapshot = (harness: PiSettingsSnapshot['global']['harness']): PromiseFulfilledResult<PiSettingsSnapshot> => ({
      status: 'fulfilled', value: { global: { harness }, globalRevision: '1', project: {}, projectRevision: '1', projectTrusted: false },
    });
    expect(resolveInferenceBinding(failed, failed).embedding.status).toBe('unavailable');
    expect(resolveInferenceBinding(snapshot({}), failed).embedding.status).toBe('unconfigured');
    expect(resolveInferenceBinding(snapshot({ embedding: { protocol: 'openai-compatible', providerId: 'p', modelId: 'm' } }), failed).embedding.status).toBe('unavailable');
    expect(resolveInferenceBinding(snapshot({ embedding: { providerId: 'p' } }), failed).embedding.status).toBe('invalid');
    expect(resolveInferenceBinding(snapshot('broken'), failed).rerank.status).toBe('invalid');
  });

  it('rejects locally on abort, sends explicit remote cancel, and discards a late response', async () => {
    const calls: string[] = [];
    let release!: () => void;
    const broker = {
      requestForWorkspace: async (_cwd: string, method: string, params: HarnessEmbedParams) => {
        calls.push(`${method}:${params.batchId}`);
        if (method === 'harness.inference.cancel') return { cancelled: true };
        await new Promise<void>((resolve) => { release = resolve; });
        return { batchId: params.batchId };
      },
    } as unknown as WorkspaceInferenceBroker;
    const controller = new AbortController();
    const pending = requestWorkspaceInference(broker, 'A', 'harness.embed', {
      purpose: 'query', providerId: 'p', modelId: 'm', protocol: 'openai-compatible',
      configurationId: 'c', items: [{ id: 'q', text: 'body' }], batchId: 'unique', maxTokens: 10,
    }, controller.signal);
    await Promise.resolve();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    release();
    await Promise.resolve();
    expect(calls).toContain('harness.inference.cancel:unique');
  });
});
