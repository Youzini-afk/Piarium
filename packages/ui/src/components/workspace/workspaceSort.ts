import type { WorkspaceEntry } from '@/lib/api/types';

export type WorkspaceSortMode = 'name-asc' | 'name-desc' | 'modified-desc' | 'modified-asc';

export const WORKSPACE_SORT_STORAGE_KEY = 'openchamber.workspaceSidebar.sortMode';
export const DEFAULT_WORKSPACE_SORT_MODE: WorkspaceSortMode = 'name-asc';

export const WORKSPACE_SORT_MODES: WorkspaceSortMode[] = [
  'name-asc',
  'name-desc',
  'modified-desc',
  'modified-asc',
];

export const normalizeWorkspaceSortMode = (value: unknown): WorkspaceSortMode => (
  typeof value === 'string' && (WORKSPACE_SORT_MODES as string[]).includes(value)
    ? value as WorkspaceSortMode
    : DEFAULT_WORKSPACE_SORT_MODE
);

const compareByType = (left: WorkspaceEntry, right: WorkspaceEntry): number => {
  const leftDirectory = left.type === 'directory';
  const rightDirectory = right.type === 'directory';
  if (leftDirectory === rightDirectory) return 0;
  return leftDirectory ? -1 : 1;
};

const compareByName = (left: WorkspaceEntry, right: WorkspaceEntry): number => (
  left.name.localeCompare(right.name, undefined, { sensitivity: 'base', numeric: true })
);

const compareByMtime = (left: WorkspaceEntry, right: WorkspaceEntry): number => (
  (left.mtimeMs ?? 0) - (right.mtimeMs ?? 0)
);

export const sortWorkspaceEntries = (entries: WorkspaceEntry[], mode: WorkspaceSortMode): WorkspaceEntry[] => {
  const normalizedMode = normalizeWorkspaceSortMode(mode);
  return entries.slice().sort((left, right) => {
    const typeOrder = compareByType(left, right);
    if (typeOrder !== 0) return typeOrder;

    switch (normalizedMode) {
      case 'name-desc': {
        return compareByName(right, left);
      }
      case 'modified-desc': {
        const modified = compareByMtime(right, left);
        return modified || compareByName(left, right);
      }
      case 'modified-asc': {
        const modified = compareByMtime(left, right);
        return modified || compareByName(left, right);
      }
      case 'name-asc':
      default:
        return compareByName(left, right);
    }
  });
};
