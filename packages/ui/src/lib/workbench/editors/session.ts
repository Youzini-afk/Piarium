import { getRuntimeKey } from '@/lib/runtime-switch';
import { restoreEditorWorkbenchSnapshot } from './snapshot';
import {
  closeEditorGroup,
  closeEditorTab,
  createEmptyEditorWorkbench,
  listOpenResourceIds,
  moveEditorTab,
  openEditor,
  pinEditorTab,
  setActiveEditor,
  setEditorSplitRatio,
  splitEditorGroup,
  updateEditorViewState,
  type EditorIdFactory,
} from './groups';
import {
  flushPersistedEditorWorkbench,
  lastGoodEditorWorkbench,
  readPersistedEditorWorkbench,
  rememberLastGoodEditorWorkbench,
  resetEditorWorkbenchPersistForRuntimeSwitch,
  schedulePersistedEditorWorkbench,
} from './persist';
import { resetWorkbenchPanelsForRuntimeSwitch } from './panels';
import { resolveEditorProviderId } from './providers';
import type { EditorViewState, EditorWorkbenchState } from './types';

type EditorWorkbenchSession = {
  runtimeKey: string;
  byWorkspace: Map<string, EditorWorkbenchState>;
};

let session: EditorWorkbenchSession = {
  runtimeKey: getRuntimeKey(),
  byWorkspace: new Map(),
};

const listeners = new Set<() => void>();
const createId: EditorIdFactory = () => crypto.randomUUID();

const emit = (): void => {
  for (const listener of listeners) listener();
};

export const subscribeEditorWorkbench = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const peekEditorWorkbench = (workspaceId: string | undefined): EditorWorkbenchState | undefined => (
  workspaceId ? session.byWorkspace.get(workspaceId) : undefined
);

const persistStructural = (state: EditorWorkbenchState): EditorWorkbenchState => {
  rememberLastGoodEditorWorkbench(state);
  schedulePersistedEditorWorkbench(state.workspaceId);
  return state;
};

export const replaceEditorWorkbench = (
  state: EditorWorkbenchState,
  options?: { persist?: boolean; notify?: boolean },
): EditorWorkbenchState => {
  session.byWorkspace.set(state.workspaceId, state);
  rememberLastGoodEditorWorkbench(state);
  if (options?.persist !== false) persistStructural(state);
  if (options?.notify !== false) emit();
  return state;
};

export const ensureEditorWorkbench = (
  workspaceId: string,
  hydrate?: { resourceIds: string[]; selectedResourceId?: string },
): EditorWorkbenchState => {
  const existing = session.byWorkspace.get(workspaceId);
  if (existing) return existing;

  const persisted = readPersistedEditorWorkbench(workspaceId);
  if (persisted.status === 'ready') {
    session.byWorkspace.set(workspaceId, persisted.state);
    rememberLastGoodEditorWorkbench(persisted.state);
    emit();
    return persisted.state;
  }

  const preservePersist = persisted.status === 'failure' || persisted.status === 'malformed';
  if (preservePersist) {
    const lastGood = lastGoodEditorWorkbench(workspaceId);
    if (lastGood) {
      session.byWorkspace.set(workspaceId, lastGood);
      emit();
      return lastGood;
    }
  }

  let created = createEmptyEditorWorkbench(workspaceId, createId);
  if (hydrate?.resourceIds.length) {
    for (const resourceId of hydrate.resourceIds) {
      created = openEditor(created, {
        resourceId,
        providerId: resolveEditorProviderId(resourceId),
      }, createId);
    }
    if (hydrate.selectedResourceId) {
      const group = created.tree.type === 'group' ? created.tree : undefined;
      const tab = group?.tabs.find((candidate) => candidate.resourceId === hydrate.selectedResourceId);
      if (group && tab) {
        created = setActiveEditor(created, group.groupId, tab.tabId);
      }
    }
  }
  session.byWorkspace.set(workspaceId, created);
  if (!preservePersist) {
    rememberLastGoodEditorWorkbench(created);
    if (created.tree.type === 'group' && created.tree.tabs.length > 0) {
      persistStructural(created);
    }
  }
  emit();
  return created;
};

export const getEditorWorkbench = (workspaceId: string): EditorWorkbenchState => (
  ensureEditorWorkbench(workspaceId)
);

export const restoreEditorWorkbench = (workspaceId: string, raw: unknown): EditorWorkbenchState => {
  const restored = restoreEditorWorkbenchSnapshot(raw, workspaceId);
  if (restored.status === 'ready') {
    return replaceEditorWorkbench(restored.state);
  }
  const current = session.byWorkspace.get(workspaceId);
  if (current && restored.status === 'failure') return current;
  const lastGood = lastGoodEditorWorkbench(workspaceId);
  if (lastGood && restored.status === 'failure') {
    session.byWorkspace.set(workspaceId, lastGood);
    emit();
    return lastGood;
  }
  const created = createEmptyEditorWorkbench(workspaceId, createId);
  session.byWorkspace.set(workspaceId, created);
  emit();
  return created;
};

export const openWorkbenchEditor = (
  workspaceId: string,
  resourceId: string,
  providerId?: string,
  options?: { preview?: boolean; newView?: boolean; groupId?: string },
): EditorWorkbenchState => {
  const next = openEditor(ensureEditorWorkbench(workspaceId), {
    resourceId,
    providerId: providerId ?? resolveEditorProviderId(resourceId),
    ...(options?.preview === true ? { preview: true } : {}),
    ...(options?.newView === true ? { newView: true } : {}),
    ...(options?.groupId ? { groupId: options.groupId } : {}),
  }, createId);
  return replaceEditorWorkbench(next);
};

export const closeWorkbenchEditor = (workspaceId: string, tabId: string): EditorWorkbenchState => (
  replaceEditorWorkbench(closeEditorTab(ensureEditorWorkbench(workspaceId), tabId))
);

export const pinWorkbenchEditor = (workspaceId: string, tabId: string, pinned = true): EditorWorkbenchState => (
  replaceEditorWorkbench(pinEditorTab(ensureEditorWorkbench(workspaceId), tabId, pinned))
);

export const setActiveWorkbenchEditor = (
  workspaceId: string,
  groupId: string,
  tabId?: string,
): EditorWorkbenchState => (
  replaceEditorWorkbench(setActiveEditor(ensureEditorWorkbench(workspaceId), groupId, tabId))
);

export const splitActiveEditor = (
  workspaceId: string,
  direction: 'horizontal' | 'vertical',
): EditorWorkbenchState => (
  replaceEditorWorkbench(splitEditorGroup(ensureEditorWorkbench(workspaceId), { direction }, createId))
);

export const moveWorkbenchEditor = (
  workspaceId: string,
  tabId: string,
  targetGroupId: string,
  index?: number,
): EditorWorkbenchState => (
  replaceEditorWorkbench(moveEditorTab(ensureEditorWorkbench(workspaceId), tabId, targetGroupId, index))
);

export const closeWorkbenchEditorGroup = (workspaceId: string, groupId: string): EditorWorkbenchState => (
  replaceEditorWorkbench(closeEditorGroup(ensureEditorWorkbench(workspaceId), groupId))
);

export const setWorkbenchSplitRatio = (
  workspaceId: string,
  splitId: string,
  ratio: number,
): EditorWorkbenchState => (
  replaceEditorWorkbench(setEditorSplitRatio(ensureEditorWorkbench(workspaceId), splitId, ratio))
);

export const patchEditorViewState = (
  workspaceId: string,
  viewId: string,
  viewState: EditorViewState,
): void => {
  const current = session.byWorkspace.get(workspaceId);
  if (!current) return;
  const next = updateEditorViewState(current, viewId, viewState);
  session.byWorkspace.set(workspaceId, next);
  rememberLastGoodEditorWorkbench(next);
};

export const listWorkbenchOpenResourceIds = (workspaceId: string): string[] => {
  const state = session.byWorkspace.get(workspaceId);
  return state ? listOpenResourceIds(state.tree) : [];
};

let activeWorkspaceId: string | undefined;

export const setActiveWorkbenchWorkspaceId = (workspaceId: string | undefined): void => {
  activeWorkspaceId = workspaceId;
};

export const getActiveWorkbenchWorkspaceId = (): string | undefined => activeWorkspaceId;

export const resetEditorWorkbenchForTests = (): void => {
  resetEditorWorkbenchPersistForRuntimeSwitch();
  resetWorkbenchPanelsForRuntimeSwitch();
  session = { runtimeKey: getRuntimeKey(), byWorkspace: new Map() };
  activeWorkspaceId = undefined;
};

export const resetEditorWorkbenchForRuntimeSwitch = (runtimeKey: string): void => {
  if (session.runtimeKey === runtimeKey) return;
  flushPersistedEditorWorkbench();
  resetEditorWorkbenchPersistForRuntimeSwitch();
  resetWorkbenchPanelsForRuntimeSwitch();
  session = { runtimeKey, byWorkspace: new Map() };
  emit();
};
