import React from 'react';
import { toast } from '@/components/ui';
import { AgentManagerSidebar } from './AgentManagerSidebar';
import { AgentManagerEmptyState } from './AgentManagerEmptyState';
import { AgentGroupDetail } from './AgentGroupDetail';
import { PiInteractionHost } from '@/components/pi-session/PiInteractionHost';
import { cn } from '@/lib/utils';
import { useAgentGroupsStore } from '@/stores/useAgentGroupsStore';
import { useMultiRunStore } from '@/stores/useMultiRunStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import type { CreateMultiRunParams } from '@/types/multirun';

interface AgentManagerViewProps {
  className?: string;
}

export const AgentManagerView: React.FC<AgentManagerViewProps> = ({ className }) => {
  const { runtime } = useRuntimeAPIs();
  const isVSCodeRuntime = runtime.isVSCode;
  const setDirectory = useDirectoryStore((s) => s.setDirectory);
  const currentDirectory = useDirectoryStore((s) => s.currentDirectory);

  const groups = useAgentGroupsStore((s) => s.groups);
  const selectedGroupName = useAgentGroupsStore((s) => s.selectedGroupName);
  const selectGroup = useAgentGroupsStore((s) => s.selectGroup);
  const loadGroups = useAgentGroupsStore((s) => s.loadGroups);

  const createMultiRun = useMultiRunStore((s) => s.createMultiRun);
  const isCreatingMultiRun = useMultiRunStore((s) => s.isLoading);

  const selectedGroup = React.useMemo(
    () => (selectedGroupName ? groups.find((g) => g.name === selectedGroupName) ?? null : null),
    [groups, selectedGroupName],
  );

  React.useEffect(() => {
    if (!isVSCodeRuntime) return;
    const workspaceFolder = (typeof window !== 'undefined'
      ? (window as unknown as { __VSCODE_CONFIG__?: { workspaceFolder?: unknown } }).__VSCODE_CONFIG__?.workspaceFolder
      : null);
    if (typeof workspaceFolder === 'string' && workspaceFolder.trim().length > 0) {
      try { setDirectory(workspaceFolder, { showOverlay: false }); } catch { /* ignored */ }
    }
  }, [isVSCodeRuntime, setDirectory]);

  // Load groups on mount and when directory changes
  React.useEffect(() => {
    void loadGroups();
  }, [currentDirectory, loadGroups]);

  const handleGroupSelect = React.useCallback((groupName: string) => {
    selectGroup(groupName);
  }, [selectGroup]);

  const handleNewAgent = React.useCallback(() => {
    selectGroup(null);
  }, [selectGroup]);

  const handleCreateGroup = React.useCallback(async (params: CreateMultiRunParams) => {
    const totalModels = params.groups.reduce((sum, g) => sum + g.models.length, 0);
    toast.info(`Creating agent group "${params.name}" with ${totalModels} run(s)...`);

    const result = await createMultiRun(params);

    if (!result) {
      throw new Error(useMultiRunStore.getState().error ?? 'Failed to create agent group');
    }
    if (result.failures.length > 0) {
      toast.warning(`Agent group "${params.name}" created with ${result.sessionIds.length} session(s); ${result.failures.length} run(s) failed`);
    } else {
      toast.success(`Agent group "${params.name}" created with ${result.sessionIds.length} session(s)`);
    }
    await loadGroups();
    selectGroup(result.groupSlug);
  }, [createMultiRun, loadGroups, selectGroup]);

  return (
    <>
      <div className={cn('flex h-full w-full bg-background', className)}>
        <div className="w-64 flex-shrink-0">
          <AgentManagerSidebar
            groups={groups}
            selectedGroupName={selectedGroupName}
            onGroupSelect={handleGroupSelect}
            onNewAgent={handleNewAgent}
          />
        </div>
        <div className="flex-1 min-w-0">
          {selectedGroup ? (
            <AgentGroupDetail group={selectedGroup} />
          ) : (
            <AgentManagerEmptyState
              onCreateGroup={handleCreateGroup}
              isCreating={isCreatingMultiRun}
            />
          )}
        </div>
      </div>
      <PiInteractionHost />
    </>
  );
};
