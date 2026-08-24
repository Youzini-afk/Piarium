import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { toast } from '@/components/ui';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { dropdownTriggerVariants } from '@/components/ui/dropdown-trigger';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useI18n } from '@/lib/i18n';
import { startPiSessionDraftFromNavigation } from '@/lib/pi-runtime/sessionNavigation';
import { cn, formatDirectoryName } from '@/lib/utils';
import { workspaceEvents } from '@/lib/workspaceEvents';
import { useProjectsStore } from '@/stores/useProjectsStore';

const GENERAL_CHAT_VALUE = '__piarium_general_chat__';

export interface SessionWorkspacePickerProps {
  className?: string;
  onAddWorkspace?: () => void;
  onSelectionComplete?: () => void;
}

export const SessionWorkspacePicker: React.FC<SessionWorkspacePickerProps> = ({
  className,
  onAddWorkspace,
  onSelectionComplete,
}) => {
  const { t } = useI18n();
  const { runtime } = useRuntimeAPIs();
  const projects = useProjectsStore((state) => state.projects);
  const activeProjectId = useProjectsStore((state) => state.activeProjectId);
  const activeProject = projects.find((project) => project.id === activeProjectId) ?? null;
  const activeLabel = activeProject?.label?.trim()
    || (activeProject ? formatDirectoryName(activeProject.path, null) : '')
    || t('sessions.sidebar.workspacePicker.generalChat');
  const selectedValue = activeProject?.id ?? GENERAL_CHAT_VALUE;
  const canAddWorkspace = !runtime.isVSCode;

  const handleSelection = React.useCallback((value: string) => {
    const projectId = value === GENERAL_CHAT_VALUE ? null : value;
    void startPiSessionDraftFromNavigation({ projectId }).then(() => {
      onSelectionComplete?.();
    }).catch((error) => {
      toast.error(error instanceof Error ? error.message : String(error));
    });
  }, [onSelectionComplete]);

  const handleAddWorkspace = React.useCallback(() => {
    if (onAddWorkspace) onAddWorkspace();
    else workspaceEvents.requestDirectoryDialog();
  }, [onAddWorkspace]);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(dropdownTriggerVariants(), 'w-full min-w-0', className)}
          aria-label={t('sessions.sidebar.workspacePicker.chooseAria')}
        >
          <span className="flex min-w-0 items-center gap-2">
            <Icon name={activeProject ? 'folder' : 'chat-4'} className="size-4" />
            <span className="truncate">{activeLabel}</span>
          </span>
          <Icon name="arrow-down-s" className="size-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[var(--anchor-width)] max-w-[min(24rem,calc(100vw-2rem))]">
        <DropdownMenuRadioGroup value={selectedValue} onValueChange={handleSelection}>
          <DropdownMenuRadioItem value={GENERAL_CHAT_VALUE}>
            <Icon name="chat-4" className="mr-2 size-4" />
            <span className="truncate">{t('sessions.sidebar.workspacePicker.generalChat')}</span>
          </DropdownMenuRadioItem>
          {projects.map((project) => (
            <DropdownMenuRadioItem key={project.id} value={project.id}>
              <Icon name="folder" className="mr-2 size-4" />
              <span className="min-w-0 flex-1 truncate">
                {project.label?.trim() || formatDirectoryName(project.path, null) || project.path}
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        {canAddWorkspace ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={handleAddWorkspace}>
              <Icon name="folder-add" className="mr-2 size-4" />
              {t('sessions.sidebar.workspacePicker.addWorkspace')}
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
