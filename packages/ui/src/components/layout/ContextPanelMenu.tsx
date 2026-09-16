import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { DiffIcon } from '@/components/icons/DiffIcon';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useI18n } from '@/lib/i18n';
import { isVSCodeRuntime } from '@/lib/desktop';
import { sortContextSurfaces } from '@/lib/surfaces/registry';
import { cn } from '@/lib/utils';
import { useFeatureFlagsStore } from '@/stores/useFeatureFlagsStore';
import { useGitStatus } from '@/stores/useGitStore';
import { normalizeContextPanelDirectoryKey, useUIStore } from '@/stores/useUIStore';

const EMPTY_TABS: never[] = [];

/** One entry point for auxiliary views; the panel retains its tabs and sizing when closed. */
export const ContextPanelMenu: React.FC = () => {
  const { t } = useI18n();
  const directory = useEffectiveDirectory();
  const directoryKey = directory ? normalizeContextPanelDirectoryKey(directory) : '';
  const panel = useUIStore((state) => directoryKey ? state.contextPanelByDirectory[directoryKey] : undefined);
  const order = useUIStore((state) => state.contextRailOrder);
  const openSurface = useUIStore((state) => state.openContextSurface);
  const closePanel = useUIStore((state) => state.closeContextPanel);
  const planEnabled = useFeatureFlagsStore((state) => state.planModeEnabled);
  const gitStatus = useGitStatus(directoryKey || null);
  const tabs = panel?.tabs ?? EMPTY_TABS;
  const activeTab = tabs.find((tab) => tab.id === panel?.activeTabId);
  const activeMode = panel?.isOpen ? activeTab?.mode : undefined;
  const changedFiles = gitStatus?.files.length ?? 0;
  const surfaces = sortContextSurfaces(order).filter((surface) => {
    if (surface.id === 'plan' && !planEnabled) return false;
    if (surface.id === 'walkthrough' && isVSCodeRuntime()) return false;
    return surface.availability === 'always' || tabs.some((tab) => tab.mode === surface.mode);
  });

  if (!directoryKey) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={t('contextPanel.menu.open')}
          title={t('contextPanel.menu.open')}
          className={cn(
            'app-region-no-drag relative flex size-8 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-interactive-hover',
            panel?.isOpen ? 'bg-interactive-selection text-primary' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          <Icon name="layout-right" className="size-4" />
          {changedFiles > 0 ? <span aria-hidden="true" className="absolute right-1 top-1 size-1.5 rounded-full bg-primary" /> : null}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56 overflow-y-auto">
        <DropdownMenuLabel>{t('contextPanel.menu.open')}</DropdownMenuLabel>
        {surfaces.map((surface) => (
          <DropdownMenuItem
            key={surface.id}
            onClick={() => {
              // Choosing the current view should keep it visible, not toggle it closed.
              if (activeMode !== surface.mode) openSurface(directoryKey, surface.mode);
            }}
            className={cn('gap-2.5 py-1.5', activeMode === surface.mode && 'bg-interactive-selection')}
          >
            {surface.id === 'diff' ? <DiffIcon className="size-4" /> : <Icon name={surface.icon} className="size-4" />}
            <span className="flex-1">{t(surface.labelKey)}</span>
            {surface.id === 'git' && changedFiles > 0 ? (
              <span className="typography-micro tabular-nums text-muted-foreground">{changedFiles}</span>
            ) : null}
            {activeMode === surface.mode ? <Icon name="check" className="size-3.5 text-primary" /> : null}
          </DropdownMenuItem>
        ))}
        {panel?.isOpen ? <>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => closePanel(directoryKey)} className="gap-2.5 py-1.5">
            <Icon name="close" className="size-4" />
            {t('contextPanel.actions.closePanel')}
          </DropdownMenuItem>
        </> : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
