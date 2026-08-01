import {
  canUseElectronDesktopIPC,
  isDesktopLocalOriginActive,
  isVSCodeRuntime,
  requestDirectoryAccess,
  startAccessingDirectory,
} from '@/lib/desktop';
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

  const project = useProjectsStore.getState().addProject(selected.path);
  if (!project) {
    useDirectoryStore.getState().setDirectory(selected.path, { showOverlay: false });
  }

  await useWorkspaceStore.getState().refreshWorkspace();
  return { status: 'selected', path: selected.path };
};
