import { afterEach, describe, expect, it } from 'vitest';
import { SurfaceExtensionRuntime } from '@piarium/extension-surface';
import type { SurfaceContextWriter } from '@piarium/extension-surface';
import { startWorkbenchMountSession } from '@/lib/extensions/workbench-mount';
import type { WorkbenchMountImplementation } from '@/lib/extensions/workbench-mount';
import {
  batchWorkbenchContextKeyUpdates,
  clearWorkbenchContextKeys,
  createOwnerScopedContextWriter,
  getWorkbenchContextKey,
  getWorkbenchContextKeyStore,
  subscribeWorkbenchContextKey,
} from './context-keys';

const owner = (entrypointId: string, generation: number) => ({
  entrypointId,
  extensionId: 'dev.example.context',
  generation,
  realmId: 'window-1',
});

afterEach(() => clearWorkbenchContextKeys());

describe('owner-scoped context layers', () => {
  it('keeps candidate values private and fences the prior generation after commit', () => {
    const first = createOwnerScopedContextWriter(owner('main', 1));
    expect(first.writer.set('mode', 'v1')).toBe(true);
    expect(getWorkbenchContextKey('dev.example.context.mode')).toBeUndefined();
    first.commit();
    expect(getWorkbenchContextKey('dev.example.context.mode')).toBe('v1');

    const second = createOwnerScopedContextWriter(owner('main', 2));
    expect(second.writer.set('mode', 'v2')).toBe(true);
    expect(getWorkbenchContextKey('dev.example.context.mode')).toBe('v1');
    second.commit();
    expect(getWorkbenchContextKey('dev.example.context.mode')).toBe('v2');
    expect(first.writer.set('mode', 'stale')).toBe(false);

    first.dispose();
    expect(getWorkbenchContextKey('dev.example.context.mode')).toBe('v2');
    second.dispose();
    expect(getWorkbenchContextKey('dev.example.context.mode')).toBeUndefined();
  });

  it('discarding a failed candidate preserves the active owner layer', () => {
    const active = createOwnerScopedContextWriter(owner('main', 1));
    active.writer.set('ready', true);
    active.commit();

    const failed = createOwnerScopedContextWriter(owner('main', 2));
    failed.writer.set('ready', false);
    failed.dispose();
    expect(getWorkbenchContextKey('dev.example.context.ready')).toBe(true);
    active.dispose();
  });

  it('keeps sibling entrypoint layers independent and restores the remaining value', () => {
    const main = createOwnerScopedContextWriter(owner('main', 1));
    const secondary = createOwnerScopedContextWriter(owner('secondary', 1));
    main.writer.set('shared', 'main');
    secondary.writer.set('shared', 'secondary');
    main.writer.set('mainOnly', true);
    secondary.writer.set('secondaryOnly', true);
    main.commit();
    secondary.commit();

    main.dispose();
    expect(getWorkbenchContextKey('dev.example.context.shared')).toBe('secondary');
    expect(getWorkbenchContextKey('dev.example.context.mainOnly')).toBeUndefined();
    expect(getWorkbenchContextKey('dev.example.context.secondaryOnly')).toBe(true);
    secondary.dispose();
  });

  it('publishes when-driven contributions only for the committed active owner', async () => {
    const runtime = new SurfaceExtensionRuntime({
      surface: 'web',
      contextProvider: {
        batch: batchWorkbenchContextKeyUpdates,
        createWriter: createOwnerScopedContextWriter,
        getContext: getWorkbenchContextKeyStore,
        subscribe: (watchedKeys, listener) => {
          const disposers = watchedKeys.map((key) => subscribeWorkbenchContextKey(key, listener));
          return () => { for (const dispose of disposers) dispose(); };
        },
      },
    });
    const runtimeOwner = {
      ...owner('main', 1),
      desiredRevision: 1,
      extensionVersion: '1.0.0',
      hostId: '2d7b1dc1-7ccd-4be7-9fd1-23f31dc8cf1a',
    };
    await runtime.activate({ owner: runtimeOwner }, (context) => {
      context.context.set('ready', true);
      context.contribute({
        contractVersion: 1,
        data: {},
        id: 'dev.example.context.view',
        kind: 'view',
        supports: ['web'],
        when: { key: 'dev.example.context.ready', op: 'equals', value: true },
      }, 'visible');
    });
    expect(runtime.getSnapshot().visibleContributions.map((item) => item.implementation)).toEqual(['visible']);
    await runtime.deactivate({ ...runtimeOwner, desiredRevision: 2, generation: 2 });
    expect(runtime.getSnapshot().visibleContributions).toEqual([]);
    expect(getWorkbenchContextKey('dev.example.context.ready')).toBeUndefined();
  });

  it('mounts and disposes a real contribution session across false, true, false visibility', async () => {
    const runtime = new SurfaceExtensionRuntime({
      surface: 'web',
      contextProvider: {
        batch: batchWorkbenchContextKeyUpdates,
        createWriter: createOwnerScopedContextWriter,
        getContext: getWorkbenchContextKeyStore,
        subscribe: (watchedKeys, listener) => {
          const disposers = watchedKeys.map((key) => subscribeWorkbenchContextKey(key, listener));
          return () => { for (const dispose of disposers) dispose(); };
        },
      },
    });
    const runtimeOwner = {
      ...owner('main', 1),
      desiredRevision: 1,
      extensionVersion: '1.0.0',
      hostId: '2d7b1dc1-7ccd-4be7-9fd1-23f31dc8cf1a',
    };
    let writer: SurfaceContextWriter | undefined;
    let mounts = 0;
    let disposals = 0;
    let session: ReturnType<typeof startWorkbenchMountSession> | null = null;
    let reconciliation = Promise.resolve();
    const reconcile = (): void => {
      reconciliation = reconciliation.then(async () => {
        const contribution = runtime.getSnapshot().visibleContributions[0];
        if (contribution && !session) {
          session = startWorkbenchMountSession({
            container: {} as HTMLElement,
            contributionId: contribution.descriptor.id,
            implementation: contribution.implementation as WorkbenchMountImplementation<Record<string, never>>,
            onError: (error) => { throw error; },
            owner: contribution.owner,
            props: {},
          });
          await session.mounted;
        } else if (!contribution && session) {
          const retiring = session;
          session = null;
          await retiring.dispose('condition became false');
        }
      });
    };
    const unsubscribe = runtime.subscribe(reconcile);
    await runtime.activate({ owner: runtimeOwner }, (context) => {
      writer = context.context;
      context.contribute({
        contractVersion: 1,
        data: {},
        id: 'dev.example.context.conditional-mount',
        kind: 'view',
        supports: ['web'],
        when: { key: 'dev.example.context.ready', op: 'equals', value: true },
      }, {
        mount: () => {
          mounts += 1;
          return () => { disposals += 1; };
        },
      });
    });
    await reconciliation;
    expect(mounts).toBe(0);
    expect(writer?.set('ready', true)).toBe(true);
    await reconciliation;
    expect(mounts).toBe(1);
    expect(writer?.delete('ready')).toBe(true);
    await reconciliation;
    expect(disposals).toBe(1);
    unsubscribe();
    await runtime.deactivate({ ...runtimeOwner, desiredRevision: 2, generation: 2 });
  });
});
