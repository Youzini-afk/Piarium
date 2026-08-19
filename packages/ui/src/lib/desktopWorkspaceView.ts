import type { PiRuntimeManagerStatus } from '@piarium/protocol';

type DesktopWorkspaceView = 'loading' | 'main' | 'runtime-setup' | 'catalog-recovery';

export const resolveDesktopWorkspaceView = (input: {
  catalogError: unknown;
  catalogLoaded: boolean;
  catalogLoading?: boolean;
  runtimeStatus: PiRuntimeManagerStatus | null;
}): DesktopWorkspaceView => {
  if (input.catalogLoaded) return 'main';
  if (input.runtimeStatus === null || input.runtimeStatus === 'discovering') return 'loading';
  if (input.runtimeStatus === 'ready') {
    if (input.catalogLoading) return 'loading';
    return input.catalogError ? 'catalog-recovery' : 'loading';
  }
  return 'runtime-setup';
};

export const desktopWorkspaceIsOperable = (
  view: DesktopWorkspaceView,
  isSwitchingDirectory: boolean,
): boolean => view === 'runtime-setup' || (view === 'main' && !isSwitchingDirectory);
