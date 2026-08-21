import type {
  EditorGroupLeaf,
  EditorGroupNode,
  EditorGroupSplit,
  EditorTab,
  EditorViewState,
  EditorWorkbenchState,
} from './types';

export type EditorIdFactory = () => string;

const defaultId: EditorIdFactory = () => crypto.randomUUID();

export const createEmptyEditorWorkbench = (
  workspaceId: string,
  createId: EditorIdFactory = defaultId,
): EditorWorkbenchState => {
  const groupId = createId();
  return {
    workspaceId,
    activeGroupId: groupId,
    tree: {
      type: 'group',
      groupId,
      tabs: [],
      activeTabId: null,
    },
  };
};

const isLeaf = (node: EditorGroupNode): node is EditorGroupLeaf => node.type === 'group';

export const listEditorGroups = (node: EditorGroupNode): EditorGroupLeaf[] => {
  if (isLeaf(node)) return [node];
  return [...listEditorGroups(node.first), ...listEditorGroups(node.second)];
};

export const findEditorGroup = (node: EditorGroupNode, groupId: string): EditorGroupLeaf | undefined => (
  listEditorGroups(node).find((group) => group.groupId === groupId)
);

const mapGroup = (
  node: EditorGroupNode,
  groupId: string,
  update: (group: EditorGroupLeaf) => EditorGroupLeaf,
): EditorGroupNode => {
  if (isLeaf(node)) {
    return node.groupId === groupId ? update(node) : node;
  }
  return {
    ...node,
    first: mapGroup(node.first, groupId, update),
    second: mapGroup(node.second, groupId, update),
  };
};

const replaceNode = (
  node: EditorGroupNode,
  targetId: string,
  replacement: EditorGroupNode,
): EditorGroupNode => {
  if (isLeaf(node)) {
    return node.groupId === targetId ? replacement : node;
  }
  if (node.splitId === targetId) return replacement;
  return {
    ...node,
    first: replaceNode(node.first, targetId, replacement),
    second: replaceNode(node.second, targetId, replacement),
  };
};

const collectGroupIds = (node: EditorGroupNode): string[] => listEditorGroups(node).map((group) => group.groupId);

export const activeEditorTab = (state: EditorWorkbenchState): EditorTab | undefined => {
  const group = findEditorGroup(state.tree, state.activeGroupId);
  if (!group || !group.activeTabId) return undefined;
  return group.tabs.find((tab) => tab.tabId === group.activeTabId);
};

export const openEditor = (
  state: EditorWorkbenchState,
  input: {
    resourceId: string;
    providerId: string;
    preview?: boolean;
    pinned?: boolean;
    groupId?: string;
    newView?: boolean;
  },
  createId: EditorIdFactory = defaultId,
): EditorWorkbenchState => {
  const groupId = input.groupId ?? state.activeGroupId;
  const group = findEditorGroup(state.tree, groupId) ?? listEditorGroups(state.tree)[0];
  if (!group) return state;

  const existing = input.newView
    ? undefined
    : group.tabs.find((tab) => tab.resourceId === input.resourceId);
  if (existing) {
    return {
      ...state,
      activeGroupId: group.groupId,
      tree: mapGroup(state.tree, group.groupId, (current) => ({
        ...current,
        activeTabId: existing.tabId,
      })),
    };
  }

  const tab: EditorTab = {
    tabId: createId(),
    viewId: createId(),
    resourceId: input.resourceId,
    preview: input.preview === true && input.pinned !== true,
    pinned: input.pinned === true,
    providerId: input.providerId,
    viewState: {},
  };

  const nextTabs = (() => {
    if (tab.preview) {
      const previewIndex = group.tabs.findIndex((candidate) => candidate.preview && !candidate.pinned);
      if (previewIndex >= 0) {
        const copy = [...group.tabs];
        copy[previewIndex] = tab;
        return copy;
      }
    }
    return [...group.tabs, tab];
  })();

  return {
    ...state,
    activeGroupId: group.groupId,
    tree: mapGroup(state.tree, group.groupId, () => ({
      ...group,
      tabs: nextTabs,
      activeTabId: tab.tabId,
    })),
  };
};

export const closeEditorTab = (
  state: EditorWorkbenchState,
  tabId: string,
): EditorWorkbenchState => {
  const owner = listEditorGroups(state.tree).find((group) => group.tabs.some((tab) => tab.tabId === tabId));
  if (!owner) return state;
  const remaining = owner.tabs.filter((tab) => tab.tabId !== tabId);
  const activeTabId = owner.activeTabId === tabId
    ? (remaining[remaining.length - 1]?.tabId ?? null)
    : owner.activeTabId;
  return {
    ...state,
    tree: mapGroup(state.tree, owner.groupId, () => ({
      ...owner,
      tabs: remaining,
      activeTabId,
    })),
  };
};

export const pinEditorTab = (
  state: EditorWorkbenchState,
  tabId: string,
  pinned = true,
): EditorWorkbenchState => {
  const owner = listEditorGroups(state.tree).find((group) => group.tabs.some((tab) => tab.tabId === tabId));
  if (!owner) return state;
  return {
    ...state,
    tree: mapGroup(state.tree, owner.groupId, () => ({
      ...owner,
      tabs: owner.tabs.map((tab) => (
        tab.tabId === tabId ? { ...tab, pinned, preview: pinned ? false : tab.preview } : tab
      )),
    })),
  };
};

export const setActiveEditor = (
  state: EditorWorkbenchState,
  groupId: string,
  tabId?: string,
): EditorWorkbenchState => {
  const group = findEditorGroup(state.tree, groupId);
  if (!group) return state;
  const nextTabId = tabId && group.tabs.some((tab) => tab.tabId === tabId)
    ? tabId
    : group.activeTabId;
  return {
    ...state,
    activeGroupId: groupId,
    tree: mapGroup(state.tree, groupId, () => ({
      ...group,
      activeTabId: nextTabId,
    })),
  };
};

export const updateEditorViewState = (
  state: EditorWorkbenchState,
  viewId: string,
  viewState: EditorViewState,
): EditorWorkbenchState => {
  const owner = listEditorGroups(state.tree).find((group) => group.tabs.some((tab) => tab.viewId === viewId));
  if (!owner) return state;
  return {
    ...state,
    tree: mapGroup(state.tree, owner.groupId, () => ({
      ...owner,
      tabs: owner.tabs.map((tab) => (
        tab.viewId === viewId ? { ...tab, viewState: { ...tab.viewState, ...viewState } } : tab
      )),
    })),
  };
};

export const splitEditorGroup = (
  state: EditorWorkbenchState,
  input: {
    groupId?: string;
    direction: 'horizontal' | 'vertical';
  },
  createId: EditorIdFactory = defaultId,
): EditorWorkbenchState => {
  const groupId = input.groupId ?? state.activeGroupId;
  const group = findEditorGroup(state.tree, groupId);
  if (!group || group.tabs.length === 0) return state;
  const source = group.tabs.find((tab) => tab.tabId === group.activeTabId) ?? group.tabs[0];
  if (!source) return state;
  const newGroupId = createId();
  const cloned: EditorTab = {
    ...source,
    tabId: createId(),
    viewId: createId(),
    preview: false,
    viewState: { ...source.viewState },
  };
  const second: EditorGroupLeaf = {
    type: 'group',
    groupId: newGroupId,
    tabs: [cloned],
    activeTabId: cloned.tabId,
  };
  const split: EditorGroupSplit = {
    type: 'split',
    splitId: createId(),
    direction: input.direction,
    ratio: 0.5,
    first: group,
    second,
  };
  return {
    ...state,
    activeGroupId: newGroupId,
    tree: replaceNode(state.tree, group.groupId, split),
  };
};

export const moveEditorTab = (
  state: EditorWorkbenchState,
  tabId: string,
  targetGroupId: string,
  index?: number,
): EditorWorkbenchState => {
  const source = listEditorGroups(state.tree).find((group) => group.tabs.some((tab) => tab.tabId === tabId));
  const target = findEditorGroup(state.tree, targetGroupId);
  if (!source || !target) return state;
  const tab = source.tabs.find((candidate) => candidate.tabId === tabId);
  if (!tab) return state;
  if (source.groupId === target.groupId) {
    const without = source.tabs.filter((candidate) => candidate.tabId !== tabId);
    const insertAt = Math.max(0, Math.min(index ?? without.length, without.length));
    without.splice(insertAt, 0, tab);
    return {
      ...state,
      activeGroupId: source.groupId,
      tree: mapGroup(state.tree, source.groupId, () => ({
        ...source,
        tabs: without,
        activeTabId: tab.tabId,
      })),
    };
  }
  const sourceRemaining = source.tabs.filter((candidate) => candidate.tabId !== tabId);
  const targetTabs = [...target.tabs];
  const insertAt = Math.max(0, Math.min(index ?? targetTabs.length, targetTabs.length));
  targetTabs.splice(insertAt, 0, tab);
  let tree = mapGroup(state.tree, source.groupId, () => ({
    ...source,
    tabs: sourceRemaining,
    activeTabId: source.activeTabId === tabId
      ? (sourceRemaining[sourceRemaining.length - 1]?.tabId ?? null)
      : source.activeTabId,
  }));
  tree = mapGroup(tree, target.groupId, () => ({
    ...target,
    tabs: targetTabs,
    activeTabId: tab.tabId,
  }));
  const next: EditorWorkbenchState = {
    ...state,
    activeGroupId: target.groupId,
    tree,
  };
  if (sourceRemaining.length === 0) {
    return closeEditorGroup(next, source.groupId);
  }
  return next;
};

export const closeEditorGroup = (
  state: EditorWorkbenchState,
  groupId: string,
): EditorWorkbenchState => {
  if (isLeaf(state.tree) && state.tree.groupId === groupId) {
    return {
      ...state,
      tree: { ...state.tree, tabs: [], activeTabId: null },
    };
  }
  const collapse = (node: EditorGroupNode): EditorGroupNode => {
    if (isLeaf(node)) return node;
    if (isLeaf(node.first) && node.first.groupId === groupId) return node.second;
    if (isLeaf(node.second) && node.second.groupId === groupId) return node.first;
    return {
      ...node,
      first: collapse(node.first),
      second: collapse(node.second),
    };
  };
  const tree = collapse(state.tree);
  const ids = collectGroupIds(tree);
  return {
    ...state,
    tree,
    activeGroupId: ids.includes(state.activeGroupId) ? state.activeGroupId : (ids[0] ?? state.activeGroupId),
  };
};

export const setEditorSplitRatio = (
  state: EditorWorkbenchState,
  splitId: string,
  ratio: number,
): EditorWorkbenchState => {
  const clamped = Math.min(1, Math.max(0, ratio));
  const apply = (node: EditorGroupNode): EditorGroupNode => {
    if (isLeaf(node)) return node;
    if (node.splitId === splitId) return { ...node, ratio: clamped };
    return {
      ...node,
      first: apply(node.first),
      second: apply(node.second),
    };
  };
  return { ...state, tree: apply(state.tree) };
};

export const listOpenResourceIds = (node: EditorGroupNode): string[] => {
  const ids: string[] = [];
  for (const group of listEditorGroups(node)) {
    for (const tab of group.tabs) {
      if (!ids.includes(tab.resourceId)) ids.push(tab.resourceId);
    }
  }
  return ids;
};

export const findEditorTab = (
  node: EditorGroupNode,
  tabId: string,
): { group: EditorGroupLeaf; tab: EditorTab } | undefined => {
  for (const group of listEditorGroups(node)) {
    const tab = group.tabs.find((candidate) => candidate.tabId === tabId);
    if (tab) return { group, tab };
  }
  return undefined;
};

export const findEditorTabsByResource = (
  node: EditorGroupNode,
  resourceId: string,
): EditorTab[] => (
  listEditorGroups(node).flatMap((group) => group.tabs.filter((tab) => tab.resourceId === resourceId))
);

const resourceWithinPrefix = (resourceId: string, prefix: string): boolean => (
  resourceId === prefix || resourceId.startsWith(`${prefix.replace(/\/$/, '')}/`)
);

export const closeEditorTabsByResourcePrefix = (
  state: EditorWorkbenchState,
  prefix: string,
): EditorWorkbenchState => {
  let next = state;
  const tabIds = listEditorGroups(state.tree).flatMap((group) => group.tabs
    .filter((tab) => resourceWithinPrefix(tab.resourceId, prefix))
    .map((tab) => tab.tabId));
  for (const tabId of tabIds) next = closeEditorTab(next, tabId);
  return next;
};

export const renameEditorResourcePrefix = (
  state: EditorWorkbenchState,
  from: string,
  to: string,
  providerFor: (resourceId: string) => string,
): EditorWorkbenchState => {
  const renameNode = (node: EditorGroupNode): EditorGroupNode => {
    if (node.type === 'split') {
      return { ...node, first: renameNode(node.first), second: renameNode(node.second) };
    }
    return {
      ...node,
      tabs: node.tabs.map((tab) => {
        if (!resourceWithinPrefix(tab.resourceId, from)) return tab;
        const suffix = tab.resourceId.slice(from.length).replace(/^\//, '');
        const resourceId = suffix ? `${to.replace(/\/$/, '')}/${suffix}` : to;
        return { ...tab, resourceId, providerId: providerFor(resourceId) };
      }),
    };
  };
  return { ...state, tree: renameNode(state.tree) };
};
