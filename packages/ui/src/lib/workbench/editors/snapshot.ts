import type { EditorGroupNode, EditorWorkbenchState, SnapshotRestoreResult } from './types';
import { EDITOR_WORKBENCH_SNAPSHOT_VERSION } from './types';
import { listEditorGroups } from './groups';

type SnapshotEnvelope = {
  version: number;
  workspaceId: string;
  state: EditorWorkbenchState;
};

const isObject = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const isLeaf = (value: unknown): boolean => (
  isObject(value)
  && value.type === 'group'
  && typeof value.groupId === 'string'
  && Array.isArray(value.tabs)
);

const isSplit = (value: unknown): boolean => (
  isObject(value)
  && value.type === 'split'
  && typeof value.splitId === 'string'
  && (value.direction === 'horizontal' || value.direction === 'vertical')
  && typeof value.ratio === 'number'
);

const isNode = (value: unknown): value is EditorGroupNode => {
  if (isLeaf(value)) return (value as { tabs: unknown[] }).tabs.every((tab) => (
    isObject(tab)
    && typeof tab.tabId === 'string'
    && typeof tab.viewId === 'string'
    && typeof tab.resourceId === 'string'
    && typeof tab.providerId === 'string'
  ));
  if (isSplit(value)) {
    return isNode((value as { first: unknown }).first) && isNode((value as { second: unknown }).second);
  }
  return false;
};

const isWorkbench = (value: unknown): value is EditorWorkbenchState => {
  if (!isObject(value) || typeof value.workspaceId !== 'string' || typeof value.activeGroupId !== 'string') {
    return false;
  }
  if (!isNode(value.tree)) return false;
  const ids = listEditorGroups(value.tree as EditorGroupNode).map((group) => group.groupId);
  return ids.includes(value.activeGroupId);
};

export const serializeEditorWorkbenchSnapshot = (state: EditorWorkbenchState): SnapshotEnvelope => ({
  version: EDITOR_WORKBENCH_SNAPSHOT_VERSION,
  workspaceId: state.workspaceId,
  state,
});

export const restoreEditorWorkbenchSnapshot = (
  raw: unknown,
  workspaceId: string,
): SnapshotRestoreResult => {
  if (raw === undefined || raw === null) return { status: 'missing' };
  if (raw === '' || (isObject(raw) && Object.keys(raw).length === 0)) return { status: 'empty' };
  try {
    const payload = typeof raw === 'string' ? JSON.parse(raw) as unknown : raw;
    if (!isObject(payload) || payload.version !== EDITOR_WORKBENCH_SNAPSHOT_VERSION) {
      return { status: 'malformed' };
    }
    if (typeof payload.workspaceId !== 'string' || payload.workspaceId !== workspaceId) {
      return { status: 'malformed' };
    }
    if (!isWorkbench(payload.state) || payload.state.workspaceId !== workspaceId) {
      return { status: 'malformed' };
    }
    return { status: 'ready', state: payload.state };
  } catch (error) {
    return {
      status: 'failure',
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }
};
