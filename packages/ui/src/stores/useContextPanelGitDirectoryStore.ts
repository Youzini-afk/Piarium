import { create } from 'zustand';

interface ContextPanelGitDirectoryState {
  directories: Record<string, string>;
  setDirectory(scopeKey: string, directory: string | null): void;
}

export const useContextPanelGitDirectoryStore = create<ContextPanelGitDirectoryState>((set) => ({
  directories: {},
  setDirectory: (scopeKey, directory) => {
    const key = scopeKey.trim();
    if (!key) return;
    const value = directory?.trim() || null;
    set((state) => {
      if ((state.directories[key] ?? null) === value) return state;
      const directories = { ...state.directories };
      if (value === null) delete directories[key];
      else directories[key] = value;
      return { directories };
    });
  },
}));
