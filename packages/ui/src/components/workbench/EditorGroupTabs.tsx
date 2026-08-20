import React from 'react';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { FileTypeIcon } from '@/components/icons/FileTypeIcon';
import { Icon } from '@/components/icon/Icon';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { workspacePathFromResourceId } from '@/lib/documents/path';
import type { EditorGroupLeaf } from '@/lib/workbench/editors/types';
import { ScrollingFileName } from '@/components/workbench/FilesExplorer';

type EditorGroupTabsProps = {
  group: EditorGroupLeaf;
  workspaceRoot: string;
  dirtyResourceIds: ReadonlySet<string>;
  isActiveGroup: boolean;
  alwaysShowActions: boolean;
  isMobile: boolean;
  onActivate: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onPin: (tabId: string, pinned: boolean) => void;
  onMoveToGroup?: (tabId: string, targetGroupId: string) => void;
  otherGroupIds?: Array<{ groupId: string; label: string }>;
};

export const EditorGroupTabs: React.FC<EditorGroupTabsProps> = ({
  group,
  workspaceRoot,
  dirtyResourceIds,
  isActiveGroup,
  alwaysShowActions,
  isMobile,
  onActivate,
  onClose,
  onPin,
  onMoveToGroup,
  otherGroupIds,
}) => {
  const { t } = useI18n();
  const scrollRef = React.useRef<HTMLDivElement>(null);

  if (isMobile) {
    const active = group.tabs.find((tab) => tab.tabId === group.activeTabId) ?? group.tabs[0];
    if (!active) {
      return <div className="typography-ui-label font-medium truncate">{t('filesView.editor.selectFile')}</div>;
    }
    const name = active.resourceId.split('/').pop() ?? active.resourceId;
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="inline-flex min-w-0 max-w-full items-center gap-1 text-left typography-ui-label font-medium"
            aria-label={t('filesView.editor.openFilesAria')}
          >
            <FileTypeIcon filePath={active.resourceId} className="size-3.5 flex-shrink-0" />
            <ScrollingFileName name={name} />
            <Icon name="arrow-down-s" className="size-4 flex-shrink-0 text-muted-foreground" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-[min(24rem,calc(100vw-2rem))] max-w-[calc(100vw-2rem)]">
          {group.tabs.map((tab) => {
            const tabName = tab.resourceId.split('/').pop() ?? tab.resourceId;
            const isActive = tab.tabId === group.activeTabId;
            return (
              <DropdownMenuItem
                key={tab.tabId}
                onSelect={() => onActivate(tab.tabId)}
                className={cn(
                  'flex min-w-0 items-center justify-between gap-2 overflow-hidden',
                  isActive && 'bg-[var(--interactive-selection)] text-[var(--interactive-selection-foreground)]',
                )}
              >
                <span className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
                  <FileTypeIcon filePath={tab.resourceId} className="size-3.5 flex-shrink-0" />
                  <ScrollingFileName name={tabName} />
                  {dirtyResourceIds.has(tab.resourceId) ? (
                    <span className="size-1.5 shrink-0 rounded-full bg-[var(--status-warning)]" />
                  ) : null}
                </span>
                <button
                  type="button"
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    onClose(tab.tabId);
                  }}
                  className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-[var(--surface-muted-foreground)] hover:text-[var(--surface-foreground)]"
                  aria-label={t('filesView.editor.closeFileAria', { name: tabName })}
                >
                  <Icon name="close" className="size-3.5" />
                </button>
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  if (group.tabs.length === 0) {
    return <div className="typography-ui-label font-medium truncate px-3 py-1.5">{t('filesView.editor.selectFile')}</div>;
  }

  return (
    <div className={cn('relative min-w-0 flex-1', !isActiveGroup && 'opacity-80')}>
      <div
        ref={scrollRef}
        className="flex min-w-0 items-center gap-1 overflow-x-auto scrollbar-none px-3 py-1.5"
        style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
      >
        {group.tabs.map((tab) => {
          const isActive = tab.tabId === group.activeTabId;
          const tabName = tab.resourceId.split('/').pop() ?? tab.resourceId;
          const path = workspacePathFromResourceId(workspaceRoot, tab.resourceId);
          return (
            <div
              key={tab.tabId}
              draggable
              onDragStart={(event) => {
                event.dataTransfer.setData('text/piarium-tab', tab.tabId);
                event.dataTransfer.effectAllowed = 'move';
              }}
              onDragOver={(event) => {
                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';
              }}
              onDrop={(event) => {
                event.preventDefault();
                const moved = event.dataTransfer.getData('text/piarium-tab');
                if (moved && onMoveToGroup) onMoveToGroup(moved, group.groupId);
              }}
              title={path}
              className={cn(
                'group inline-flex items-center gap-1 rounded-md border px-2 py-1 typography-ui-label transition-colors whitespace-nowrap',
                tab.preview && 'italic',
                isActive
                  ? 'bg-[var(--interactive-selection)] border-[var(--primary-muted)] text-[var(--interactive-selection-foreground)]'
                  : 'bg-transparent border-[var(--interactive-border)] text-[var(--surface-muted-foreground)] hover:bg-[var(--interactive-hover)] hover:text-[var(--surface-foreground)]',
              )}
            >
              {tab.pinned ? <Icon name="pushpin-2" className="size-3 shrink-0" /> : null}
              <FileTypeIcon filePath={tab.resourceId} className="size-3.5 flex-shrink-0" />
              <button type="button" onClick={() => onActivate(tab.tabId)} className="max-w-[12rem] truncate text-left">
                {tabName}
              </button>
              {dirtyResourceIds.has(tab.resourceId) ? (
                <span className="size-1.5 shrink-0 rounded-full bg-[var(--status-warning)]" />
              ) : null}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className={cn(
                      'rounded-sm p-0.5 text-[var(--surface-muted-foreground)] hover:text-[var(--surface-foreground)]',
                      !isActive && !alwaysShowActions && 'opacity-0 group-hover:opacity-100',
                    )}
                    aria-label={t('filesView.editor.controlsTitle')}
                  >
                    <Icon name="more-2-fill" className="size-3.5" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={() => onPin(tab.tabId, !tab.pinned)}>
                    {t(tab.pinned ? 'filesView.editor.unpinTab' : 'filesView.editor.pinTab')}
                  </DropdownMenuItem>
                  {otherGroupIds?.map((target) => (
                    <DropdownMenuItem key={target.groupId} onSelect={() => onMoveToGroup?.(tab.tabId, target.groupId)}>
                      {t('filesView.editor.moveTab')} · {target.label}
                    </DropdownMenuItem>
                  ))}
                  <DropdownMenuItem onSelect={() => onClose(tab.tabId)}>
                    {t('filesView.editor.closeFileAria', { name: tabName })}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          );
        })}
      </div>
    </div>
  );
};
