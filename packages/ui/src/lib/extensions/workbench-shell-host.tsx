import React from 'react';
import { WorkbenchRecoveryShell } from '@/components/layout/WorkbenchRecoveryShell';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { usePiariumExtensionCatalog } from './catalog-store';
import { piariumSurfaceRuntime } from './surface-runtime';
import {
  WorkbenchReplacement,
  WORKBENCH_REPLACEMENT_TARGETS,
  useSurfaceRegistrySnapshot,
} from './workbench-registry';
import { WorkbenchShellStagingHost } from './workbench-shell-staging';
import { useWorkbenchWorkspace } from './workbench-workspace';
import { resolveWorkbenchShellView } from './workbench-shell-view';

const LOADING_SHELL = <div className="h-full min-h-0 w-full bg-background" />;

const WorkspaceResolutionFailure: React.FC<{ errorMessage: string; retry(): void }> = ({ errorMessage, retry }) => {
  const { t } = useI18n();
  return (
    <div className="flex h-full items-center justify-center bg-background px-6 text-foreground">
      <div className="flex max-w-md flex-col items-center gap-4 text-center">
        <div className="flex flex-col gap-2">
          <h1 className="typography-title text-foreground">{t('startup.initRecovery.title')}</h1>
          <p className="typography-body text-muted-foreground">{t('startup.initRecovery.description')}</p>
          <p className="typography-meta text-status-error">{errorMessage}</p>
        </div>
        <Button type="button" onClick={retry}>{t('startup.initRecovery.retry')}</Button>
      </div>
    </div>
  );
};

export const WorkbenchShellHost: React.FC<{
  fallback?: React.ReactNode;
}> = ({ fallback = LOADING_SHELL }) => {
  const catalog = usePiariumExtensionCatalog();
  const surfaceSnapshot = useSurfaceRegistrySnapshot();
  const workspace = useWorkbenchWorkspace();
  const workspaceId = workspace.status === 'ready' ? workspace.workspaceId : undefined;
  const { resolved, view } = resolveWorkbenchShellView(
    catalog.snapshot,
    piariumSurfaceRuntime.surface,
    workspaceId,
    surfaceSnapshot,
  );

  let content: React.ReactNode;
  if (workspace.status === 'loading') content = fallback;
  else if (workspace.status === 'error') {
    content = <WorkspaceResolutionFailure errorMessage={workspace.errorMessage} retry={workspace.retry} />;
  } else if (view === 'loading' || !resolved) content = fallback;
  else if (view === 'recovery') {
    content = <WorkbenchRecoveryShell resolved={resolved} workspaceId={workspaceId} />;
  } else {
    const recovery = <WorkbenchRecoveryShell resolved={resolved} workspaceId={workspaceId} />;
    content = (
      <WorkbenchReplacement
        target={WORKBENCH_REPLACEMENT_TARGETS.shell}
        fallback={fallback}
        errorFallback={recovery}
      />
    );
  }

  return (
    <>
      <WorkbenchShellStagingHost />
      {content}
    </>
  );
};
