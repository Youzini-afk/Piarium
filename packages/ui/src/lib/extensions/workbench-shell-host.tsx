import React from 'react';
import { resolvePiariumWorkbenchProfile } from '@piarium/extension-contract';
import { WorkbenchRecoveryShell } from '@/components/layout/WorkbenchRecoveryShell';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { usePiariumExtensionCatalog } from './catalog-store';
import { piariumSurfaceRuntime } from './surface-runtime';
import { WorkbenchReplacement, WORKBENCH_REPLACEMENT_TARGETS } from './workbench-registry';

export const WorkbenchShellHost: React.FC<{
  fallback: React.ReactNode;
}> = ({ fallback }) => {
  const catalog = usePiariumExtensionCatalog();
  const currentDirectory = useDirectoryStore((state) => state.currentDirectory);
  const snapshot = catalog.snapshot;
  const workbench = snapshot?.workbench;
  const resolved = snapshot && workbench?.authoritative
    ? resolvePiariumWorkbenchProfile(workbench.document, snapshot.catalog, {
      surface: piariumSurfaceRuntime.surface,
      userId: 'default',
      ...(currentDirectory ? { workspaceId: currentDirectory } : {}),
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
