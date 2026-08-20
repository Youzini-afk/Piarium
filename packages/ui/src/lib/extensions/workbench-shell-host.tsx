import React from 'react';
import { WorkbenchRecoveryShell } from '@/components/layout/WorkbenchRecoveryShell';
import { usePiariumExtensionCatalog } from './catalog-store';
import { piariumSurfaceRuntime } from './surface-runtime';
import { WorkbenchReplacement, WORKBENCH_REPLACEMENT_TARGETS } from './workbench-registry';
import { useWorkbenchWorkspaceId } from './workbench-workspace';
import { resolveWorkbenchShellView } from './workbench-shell-view';

const LOADING_SHELL = <div className="h-full min-h-0 w-full bg-background" />;

export const WorkbenchShellHost: React.FC<{
  fallback?: React.ReactNode;
}> = ({ fallback = LOADING_SHELL }) => {
  const catalog = usePiariumExtensionCatalog();
  const workspaceId = useWorkbenchWorkspaceId();
  const { resolved, view } = resolveWorkbenchShellView(
    catalog.snapshot,
    piariumSurfaceRuntime.surface,
    workspaceId,
  );

  if (view === 'loading' || !resolved) return <>{fallback}</>;

  if (view === 'recovery') {
    return <WorkbenchRecoveryShell resolved={resolved} />;
  }

  const recovery = <WorkbenchRecoveryShell resolved={resolved} />;
  return (
    <WorkbenchReplacement
      target={WORKBENCH_REPLACEMENT_TARGETS.shell}
      fallback={fallback}
      errorFallback={recovery}
    />
  );
};
