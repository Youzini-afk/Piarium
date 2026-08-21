import React from 'react';
import { ResourceEditorHost } from '@/components/workbench/ResourceEditorHost';
import { useWorkbenchWorkspaceId } from '@/lib/extensions/workbench-workspace';
import { resourceIdFromWorkspacePath } from '@/lib/documents/path';
import { resolveEditorProviderId } from '@/lib/workbench/editors/providers';
import type { EditorTab, EditorViewState } from '@/lib/workbench/editors/types';
import { useI18n } from '@/lib/i18n';

export const ContextResourceEditor: React.FC<{
  filePath: string;
  viewId: string;
  workspaceRoot: string;
}> = ({ filePath, viewId, workspaceRoot }) => {
  const { t } = useI18n();
  const workspaceId = useWorkbenchWorkspaceId();
  const resourceId = resourceIdFromWorkspacePath(workspaceRoot, filePath);
  const [viewState, setViewState] = React.useState<EditorViewState>({});
  React.useEffect(() => setViewState({}), [resourceId, viewId]);
  const tab = React.useMemo<EditorTab | null>(() => resourceId ? ({
    tabId: `context:${viewId}`,
    viewId: `context:${viewId}`,
    resourceId,
    preview: false,
    pinned: true,
    providerId: resolveEditorProviderId(resourceId),
    viewState,
  }) : null, [resourceId, viewId, viewState]);
  const patchViewState = React.useCallback((patch: EditorViewState) => {
    setViewState((current) => ({ ...current, ...patch }));
  }, []);
  if (!resourceId) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-center typography-ui text-muted-foreground">
        {t('filesView.document.outsideWorkspace')}
      </div>
    );
  }
  if (!workspaceId || !tab) return <div className="h-full bg-background" />;
  return (
    <ResourceEditorHost
      workspaceId={workspaceId}
      workspaceRoot={workspaceRoot}
      tab={tab}
      onViewStateChange={patchViewState}
    />
  );
};
