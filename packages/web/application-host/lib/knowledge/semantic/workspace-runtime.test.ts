import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PiRuntimeBrokerEvent } from '@piarium/runtime-broker';
import type { HarnessInferenceBindingSnapshot, HarnessRerankSettings, PiSettingsSnapshot } from '@piarium/protocol';
import { createDocumentAuthorityHarness } from '../../documents/contract-fixtures.js';
import { ThreadExecutionViewRegistry } from '../../harness/working-state/execution-view.js';
import { createStructureSource } from '../../structure/source.js';
import { createHashEmbedder } from './embedder.js';
import { createWorkspaceSemanticRuntime, type WorkspaceSemanticRuntimeOptions } from './workspace-runtime.js';

const disposes: Array<() => Promise<void>> = [];
afterEach(async () => { for (const dispose of disposes.splice(0).reverse()) await dispose(); });
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};
const rerank: HarnessRerankSettings = { protocol: 'http-rerank', providerId: 'remote', modelId: 'ranking' };
const settings = (revision: string): PiSettingsSnapshot => ({
  global: { harness: { rerank: { ...rerank } } }, globalRevision: revision,
  project: {}, projectRevision: 'project', projectTrusted: false,
});
const binding = (configurationId: string): HarnessInferenceBindingSnapshot => ({
  embedding: { status: 'unconfigured' },
  rerank: { status: 'ready', binding: { ...rerank, configurationId } },
});

async function setup(hooks: {
  settings?: () => Promise<PiSettingsSnapshot>;
  describe?: () => Promise<HarnessInferenceBindingSnapshot>;
  watch?: (id: string) => Promise<void>;
} = {}) {
  const documents = await createDocumentAuthorityHarness();
  disposes.push(() => documents.cleanup());
  const local = createHashEmbedder();
  const embedded = vi.spyOn(local, 'embed');
  const reranked: string[] = [];
  const removedWatches: string[] = [];
  const executionViews = new ThreadExecutionViewRegistry();
  let watchId = 0;
  const broker = {
    requestForWorkspace: async (_cwd: string, method: string, params: Record<string, unknown>) => {
      if (method === 'settings.get') return hooks.settings?.() ?? settings('initial');
      if (method === 'harness.inference.describe') return hooks.describe?.() ?? binding('initial');
      if (method === 'harness.rerank') {
        reranked.push(params.configurationId as string);
        const document = (params.documents as Array<{ id: string }>)[0]!;
        return { batchId: params.batchId, providerId: 'remote', modelId: 'ranking', scores: [{ index: 0, id: document.id, score: 1 }] };
      }
      throw new Error(`Unexpected method ${method}`);
    },
    watchConfig: async () => {
      const id = `watch-${++watchId}`;
      await hooks.watch?.(id);
      return { watchId: id };
    },
    unwatchConfig: async (id: string) => { removedWatches.push(id); return { unwatched: true }; },
  } as unknown as NonNullable<ReturnType<WorkspaceSemanticRuntimeOptions['getBroker']>>;
  const runtime = createWorkspaceSemanticRuntime({
    dataDir: documents.dataDir, hostId: 'workspace-test', documents: documents.authority,
    structureSource: createStructureSource([]), embedder: local,
    getBroker: () => broker,
    executionViews, workingBranches: { pinQuery: async () => null },
  });
  disposes.push(() => runtime.dispose());
  return { runtime, workspaceId: documents.identity.workspaceId, embedded, removedWatches, reranked, executionViews };
}

describe('production workspace semantic assembly lifecycle', () => {
  it('does not search a disk corpus when the active virtual branch cannot be pinned', async () => {
    const harness = await setup();
    harness.executionViews.bind({
      sessionId: 'child', workspaceId: harness.workspaceId, threadId: 'thread', runId: 'run',
      branchId: 'branch', revision: 0, writeRevision: 1, mode: 'virtual', draftBasePaths: [],
    });
    await expect(harness.runtime.semanticRecall(harness.workspaceId, 'needle', 5, { sessionId: 'child' }))
      .rejects.toThrow('Working-branch query view is unavailable');
    expect(harness.embedded).not.toHaveBeenCalled();
  });

  it('does not publish settings that arrive from a retired workspace worker', async () => {
    const entered = deferred<void>();
    const old = deferred<HarnessInferenceBindingSnapshot>();
    let calls = 0;
    const harness = await setup({ describe: () => {
      if (++calls > 1) return Promise.resolve(binding('replacement'));
      entered.resolve();
      return old.promise;
    } });
    const loading = harness.runtime.harnessSettings(harness.workspaceId);
    await entered.promise;
    harness.runtime.processEvent({ kind: 'worker.exit', role: 'workspace' } as PiRuntimeBrokerEvent);
    old.resolve(binding('retired'));
    expect(await loading).toBeNull();
    await harness.runtime.rerankExploreViews({
      workspaceId: harness.workspaceId, query: 'q', documents: [{ id: 'one', text: 'body' }], settings: rerank,
    });
    expect(harness.reranked).toEqual(['replacement']);
  });

  it('waits for the config refresh before choosing the next rerank binding', async () => {
    const updated = deferred<HarnessInferenceBindingSnapshot>();
    const entered = deferred<void>();
    let calls = 0;
    const harness = await setup({ describe: () => {
      if (++calls === 1) return Promise.resolve(binding('initial'));
      entered.resolve();
      return updated.promise;
    } });
    await harness.runtime.harnessSettings(harness.workspaceId);
    harness.runtime.processEvent({
      kind: 'host', envelope: { event: 'config.changed', data: { watchId: 'watch-1' } },
    } as PiRuntimeBrokerEvent);
    await entered.promise;
    const ranking = harness.runtime.rerankExploreViews({
      workspaceId: harness.workspaceId, query: 'q', documents: [{ id: 'one', text: 'body' }], settings: rerank,
    });
    expect(harness.reranked).toEqual([]);
    updated.resolve(binding('updated'));
    await ranking;
    expect(harness.reranked).toEqual(['updated']);
  });

  it('refreshes bindings after recovering a failed config subscription', async () => {
    let current = 'initial';
    const harness = await setup({
      describe: async () => binding(current),
      watch: async (id) => {
        if (id === 'watch-1') throw new Error('watch unavailable');
        if (id === 'watch-3') current = 'changed-while-unobserved';
      },
    });
    await harness.runtime.harnessSettings(harness.workspaceId);
    await harness.runtime.rerankExploreViews({
      workspaceId: harness.workspaceId, query: 'q', documents: [{ id: 'one', text: 'body' }], settings: rerank,
    });
    expect(harness.reranked).toEqual(['changed-while-unobserved']);
  });

  it('cancels a query during settings resolution without starting a local embedding', async () => {
    const entered = deferred<void>();
    const described = deferred<HarnessInferenceBindingSnapshot>();
    const harness = await setup({ describe: () => { entered.resolve(); return described.promise; } });
    const controller = new AbortController();
    const result = harness.runtime.semanticRecall(harness.workspaceId, 'needle', 5, { signal: controller.signal });
    await entered.promise;
    controller.abort();
    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
    expect(harness.embedded).not.toHaveBeenCalled();
    described.resolve(binding('late'));
  });

  it('releases watches which finish registering after disposal has begun', async () => {
    const entered = deferred<void>();
    const watches = deferred<void>();
    const harness = await setup({ watch: async () => { entered.resolve(); await watches.promise; } });
    const loading = harness.runtime.harnessSettings(harness.workspaceId);
    const rejected = expect(loading).rejects.toThrow('closed');
    await entered.promise;
    const disposing = harness.runtime.dispose();
    watches.resolve();
    await Promise.all([disposing, rejected]);
    expect(harness.removedWatches.sort()).toEqual(['watch-1', 'watch-2']);
    await expect(harness.runtime.harnessSettings(harness.workspaceId)).rejects.toThrow('closed');
  });
});
