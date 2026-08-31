import { getRuntimeKey } from '@piarium/application-client';
import { restoreEditorWorkbenchSnapshot, serializeEditorWorkbenchSnapshot } from './snapshot';
import type { EditorWorkbenchState, SnapshotRestoreResult } from './types';

type PersistBackend = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

const memory = new Map<string, string>();
let backendOverride: PersistBackend | undefined;
const persistTimers = new Map<string, ReturnType<typeof setTimeout>>();
const lastGood = new Map<string, EditorWorkbenchState>();

const defaultBackend = (): PersistBackend => {
  if (backendOverride) return backendOverride;
  try {
    if (typeof localStorage !== 'undefined') return localStorage;
  } catch {
    // Restricted storage falls back to memory.
  }
  return {
    getItem: (key) => memory.get(key) ?? null,
    setItem: (key, value) => {
      memory.set(key, value);
    },
    removeItem: (key) => {
      memory.delete(key);
    },
  };
};

export const setEditorWorkbenchPersistBackendForTests = (backend?: PersistBackend): void => {
  backendOverride = backend;
};

export const editorWorkbenchPersistKey = (workspaceId: string, runtimeKey = getRuntimeKey()): string => (
  `piarium.editor-workbench:${runtimeKey}:${workspaceId}`
);

export const rememberLastGoodEditorWorkbench = (state: EditorWorkbenchState): void => {
  lastGood.set(state.workspaceId, state);
};

export const readPersistedEditorWorkbench = (workspaceId: string): SnapshotRestoreResult => {
  const key = editorWorkbenchPersistKey(workspaceId);
  try {
    const raw = defaultBackend().getItem(key);
    return restoreEditorWorkbenchSnapshot(raw, workspaceId);
  } catch (error) {
    return {
      status: 'failure',
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }
};

export const writePersistedEditorWorkbench = (state: EditorWorkbenchState): void => {
  rememberLastGoodEditorWorkbench(state);
  const key = editorWorkbenchPersistKey(state.workspaceId);
  try {
    defaultBackend().setItem(key, JSON.stringify(serializeEditorWorkbenchSnapshot(state)));
  } catch {
    // Keep last-good in memory; a failed write must not clear it.
  }
};

export const schedulePersistedEditorWorkbench = (workspaceId: string): void => {
  const existing = persistTimers.get(workspaceId);
  if (existing) clearTimeout(existing);
  persistTimers.set(workspaceId, setTimeout(() => {
    persistTimers.delete(workspaceId);
    const state = lastGood.get(workspaceId);
    if (state) writePersistedEditorWorkbench(state);
  }, 400));
};

export const flushPersistedEditorWorkbench = (workspaceId?: string): void => {
  if (workspaceId) {
    const timer = persistTimers.get(workspaceId);
    if (timer) {
      clearTimeout(timer);
      persistTimers.delete(workspaceId);
    }
    const state = lastGood.get(workspaceId);
    if (state) writePersistedEditorWorkbench(state);
    return;
  }
  for (const [id, timer] of persistTimers) {
    clearTimeout(timer);
    persistTimers.delete(id);
    const state = lastGood.get(id);
    if (state) writePersistedEditorWorkbench(state);
  }
};

export const lastGoodEditorWorkbench = (workspaceId: string): EditorWorkbenchState | undefined => (
  lastGood.get(workspaceId)
);

export const resetEditorWorkbenchPersistForRuntimeSwitch = (): void => {
  for (const timer of persistTimers.values()) clearTimeout(timer);
  persistTimers.clear();
  lastGood.clear();
  memory.clear();
};

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => flushPersistedEditorWorkbench(), { capture: true });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushPersistedEditorWorkbench();
  });
  document.addEventListener('freeze', () => flushPersistedEditorWorkbench());
}
