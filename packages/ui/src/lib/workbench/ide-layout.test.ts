import { afterEach, describe, expect, test } from 'bun:test';
import {
  DEFAULT_IDE_WORKBENCH_LAYOUT,
  flushPersistedIdeWorkbenchLayout,
  hydrateIdeWorkbenchLayout,
  ideWorkbenchLayoutPersistKey,
  lastGoodIdeWorkbenchLayout,
  rememberLastGoodIdeWorkbenchLayout,
  resetIdeWorkbenchLayoutForRuntimeSwitch,
  setIdeWorkbenchLayoutPersistBackendForTests,
  writePersistedIdeWorkbenchLayout,
} from './ide-layout';

const memoryStore = (): {
  store: Map<string, string>;
  writes: string[];
  backend: {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
  };
} => {
  const store = new Map<string, string>();
  const writes: string[] = [];
  return {
    store,
    writes,
    backend: {
      getItem: (key) => store.get(key) ?? null,
      setItem: (key, value) => {
        writes.push(key);
        store.set(key, value);
      },
      removeItem: (key) => {
        store.delete(key);
      },
    },
  };
};

afterEach(() => {
  resetIdeWorkbenchLayoutForRuntimeSwitch();
  setIdeWorkbenchLayoutPersistBackendForTests(undefined);
});

describe('IDE workbench layout persist', () => {
  test('missing and empty snapshots hydrate to the default without writing', () => {
    const { store, writes, backend } = memoryStore();
    setIdeWorkbenchLayoutPersistBackendForTests(backend);
    expect(hydrateIdeWorkbenchLayout('ws-missing')).toEqual(DEFAULT_IDE_WORKBENCH_LAYOUT);
    store.set(ideWorkbenchLayoutPersistKey('ws-empty'), '');
    expect(hydrateIdeWorkbenchLayout('ws-empty')).toEqual(DEFAULT_IDE_WORKBENCH_LAYOUT);
    expect(writes).toEqual([]);
  });

  test('failure and malformed snapshots keep last-good and do not write empty over the failed snapshot', () => {
    const { store, writes, backend } = memoryStore();
    setIdeWorkbenchLayoutPersistBackendForTests(backend);
    const workspaceId = 'ws-fail';
    writePersistedIdeWorkbenchLayout(workspaceId, {
      ...DEFAULT_IDE_WORKBENCH_LAYOUT,
      activity: 'git',
      primaryWidth: 320,
    });
    const key = ideWorkbenchLayoutPersistKey(workspaceId);
    const lastGood = lastGoodIdeWorkbenchLayout(workspaceId);
    if (!lastGood) throw new Error('expected last-good');
    resetIdeWorkbenchLayoutForRuntimeSwitch();
    rememberLastGoodIdeWorkbenchLayout(workspaceId, lastGood);

    let shouldFail = true;
    setIdeWorkbenchLayoutPersistBackendForTests({
      getItem: () => {
        if (shouldFail) throw new Error('disk');
        return store.get(key) ?? null;
      },
      setItem: (itemKey, value) => {
        writes.push(itemKey);
        store.set(itemKey, value);
      },
      removeItem: (itemKey) => {
        store.delete(itemKey);
      },
    });
    const writeCount = writes.length;
    expect(hydrateIdeWorkbenchLayout(workspaceId).activity).toBe('git');
    expect(writes.length).toBe(writeCount);

    resetIdeWorkbenchLayoutForRuntimeSwitch();
    store.set(key, '{');
    shouldFail = false;
    setIdeWorkbenchLayoutPersistBackendForTests({
      getItem: () => store.get(key) ?? null,
      setItem: (itemKey, value) => {
        writes.push(`overwrite:${itemKey}`);
        store.set(itemKey, value);
      },
      removeItem: (itemKey) => {
        store.delete(itemKey);
      },
    });
    expect(hydrateIdeWorkbenchLayout(workspaceId)).toEqual(DEFAULT_IDE_WORKBENCH_LAYOUT);
    expect(store.get(key)).toBe('{');
    expect(writes.some((entry) => entry.startsWith('overwrite:'))).toBe(false);
  });

  test('flush writes the last-good layout for the current workspace', () => {
    const { store, backend } = memoryStore();
    setIdeWorkbenchLayoutPersistBackendForTests(backend);
    const workspaceId = 'ws-flush';
    rememberLastGoodIdeWorkbenchLayout(workspaceId, {
      ...DEFAULT_IDE_WORKBENCH_LAYOUT,
      secondaryView: 'fleet',
    });
    flushPersistedIdeWorkbenchLayout(workspaceId);
    const raw = store.get(ideWorkbenchLayoutPersistKey(workspaceId));
    expect(raw).toContain('"fleet"');
  });
});
