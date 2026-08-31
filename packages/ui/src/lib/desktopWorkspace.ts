import {
  canUseElectronDesktopIPC,
  isDesktopLocalOriginActive,
  isVSCodeRuntime,
  requestDirectoryAccess,
  startAccessingDirectory,
} from '@/lib/desktop';
import type { ProjectEntry } from '@piarium/application-client';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useWorkspaceStore } from '@/stores/useWorkspaceStore';

export type DesktopWorkspaceSwitchResult =
  | { status: 'selected'; path: string }
  | { status: 'cancelled' }
  | { status: 'unavailable' }
  | { status: 'error'; error: string };

export const canChooseDesktopWorkspace = (): boolean => (
  canUseElectronDesktopIPC() && isDesktopLocalOriginActive() && !isVSCodeRuntime()
);

export const switchDesktopWorkspaceFromPicker = async (): Promise<DesktopWorkspaceSwitchResult> => {
  if (!canChooseDesktopWorkspace()) {
    return { status: 'unavailable' };
  }

  const directoryState = useDirectoryStore.getState();
  const initialDirectory = directoryState.currentDirectory || directoryState.homeDirectory || '';
  const selected = await requestDirectoryAccess(initialDirectory);

  if (!selected.success || !selected.path) {
    if (selected.error && selected.error !== 'Directory selection cancelled') {
      return { status: 'error', error: selected.error };
    }
    return { status: 'cancelled' };
  }

  const access = await startAccessingDirectory(selected.path);
  if (!access.success) {
    return {
      status: 'error',
      error: access.error || 'Failed to access the selected workspace.',
    };
  }

  useWorkspaceStore.getState().clearWorkspaceCache();

  let project: ProjectEntry | null;
  try {
    project = await useProjectsStore.getState().addProject(selected.path);
  } catch (error) {
    return {
      status: 'error',
      error: error instanceof Error ? error.message : 'Failed to persist the selected workspace.',
    };
  }
  if (!project) {
    return { status: 'error', error: 'Failed to persist the selected workspace.' };
  }

  await useWorkspaceStore.getState().refreshWorkspace();
  return { status: 'selected', path: selected.path };
};
