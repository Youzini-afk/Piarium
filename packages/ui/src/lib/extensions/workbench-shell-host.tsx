import React from 'react';
import { resolvePiariumWorkbenchProfile } from '@piarium/extension-contract';
import { WorkbenchRecoveryShell } from '@/components/layout/WorkbenchRecoveryShell';
import { usePiariumExtensionCatalog } from './catalog-store';
import { piariumSurfaceRuntime } from './surface-runtime';
import { WorkbenchReplacement, WORKBENCH_REPLACEMENT_TARGETS } from './workbench-registry';
import { useWorkbenchWorkspaceId } from './workbench-workspace';

export const WorkbenchShellHost: React.FC<{
  fallback: React.ReactNode;
}> = ({ fallback }) => {
  const catalog = usePiariumExtensionCatalog();
  const workspaceId = useWorkbenchWorkspaceId();
  const snapshot = catalog.snapshot;
  const workbench = snapshot?.workbench;
  const resolved = snapshot && workbench?.authoritative
    ? resolvePiariumWorkbenchProfile(workbench.document, snapshot.catalog, {
      surface: piariumSurfaceRuntime.surface,
      userId: 'default',
      ...(workspaceId ? { workspaceId } : {}),
    })
    : null;

  if (resolved && (resolved.status === 'missing' || resolved.status === 'disabled' || resolved.status === 'failed')) {
    return <WorkbenchRecoveryShell resolved={resolved} />;
  }

  return (
    <WorkbenchReplacement
      target={WORKBENCH_REPLACEMENT_TARGETS.shell}
      fallback={fallback}
      {...(resolved?.status === 'ready' ? { errorFallback: <WorkbenchRecoveryShell resolved={resolved} /> } : {})}
    />
  );
};
