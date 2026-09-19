import React from 'react';

import { useWorkspaceStore } from '@/stores/useWorkspaceStore';
import { WorkspaceArchiveDialog } from './WorkspaceArchiveDialog';
import { WorkspaceGitPanel } from './WorkspaceGitPanel';
import { WorkspaceTerminalDialog } from './WorkspaceTerminalDialog';

export const WorkspaceOverlays: React.FC = () => {
  const terminalOpen = useWorkspaceStore((state) => state.terminalDialog.open);
  const gitPanelOpen = useWorkspaceStore((state) => state.gitPanel.open);
  const archiveDialogOpen = useWorkspaceStore((state) => state.archiveDialog.open);

  return (
    <>
      {terminalOpen ? <WorkspaceTerminalDialog /> : null}
      {gitPanelOpen ? <WorkspaceGitPanel /> : null}
      {archiveDialogOpen ? <WorkspaceArchiveDialog /> : null}
    </>
  );
};
