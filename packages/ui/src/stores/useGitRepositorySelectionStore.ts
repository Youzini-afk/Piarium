import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { createDeferredSafeJSONStorage } from './utils/safeStorage';

interface GitRepositorySelectionState {
  repositoryByWorkspace: Record<string, string>;
  setRepository(workspaceId: string, directory: string | null): void;
}

const sanitizeRepositorySelections = (value: unknown): Record<string, string> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const selections: Record<string, string> = {};
  for (const [rawWorkspaceId, rawDirectory] of Object.entries(value)) {
    const workspaceId = rawWorkspaceId.trim();
    const directory = typeof rawDirectory === 'string' ? rawDirectory.trim() : '';
    if (workspaceId && directory) selections[workspaceId] = directory;
  }
  return selections;
};

export const useGitRepositorySelectionStore = create<GitRepositorySelectionState>()(
  persist(
    (set) => ({
      repositoryByWorkspace: {},
      setRepository: (workspaceIdValue, directoryValue) => {
        const workspaceId = workspaceIdValue.trim();
        if (!workspaceId) return;
        const directory = directoryValue?.trim() || null;
        set((state) => {
          if ((state.repositoryByWorkspace[workspaceId] ?? null) === directory) return state;
          const repositoryByWorkspace = { ...state.repositoryByWorkspace };
          if (directory) repositoryByWorkspace[workspaceId] = directory;
          else delete repositoryByWorkspace[workspaceId];
          return { repositoryByWorkspace };
        });
      },
    }),
    {
      name: 'piarium.gitRepositorySelection.v1',
      storage: createDeferredSafeJSONStorage(),
      partialize: (state) => ({ repositoryByWorkspace: state.repositoryByWorkspace }),
      merge: (persistedState, currentState) => {
        const persisted = persistedState && typeof persistedState === 'object'
          ? persistedState as Partial<GitRepositorySelectionState>
          : {};
        return {
          ...currentState,
          repositoryByWorkspace: sanitizeRepositorySelections(persisted.repositoryByWorkspace),
        };
      },
    },
  ),
);
