import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { normalizeContextPanelDirectoryKey, useUIStore } from '@/stores/useUIStore';

/** Rail visibility and the last workspace panel are independent controls. */
export const ContextPanelControls: React.FC = () => {
  const { t } = useI18n();
  const directory = useEffectiveDirectory();
  const directoryKey = directory ? normalizeContextPanelDirectoryKey(directory) : '';
  const panel = useUIStore((state) => directoryKey ? state.contextPanelByDirectory[directoryKey] : undefined);
  const railOpen = useUIStore((state) => state.isContextRailOpen);
  const toggleRail = useUIStore((state) => state.toggleContextRail);
  const togglePanel = useUIStore((state) => state.toggleContextPanel);
  const panelOpen = Boolean(panel?.isOpen && panel.tabs.length > 0);
  const panelLabel = t(panelOpen ? 'contextPanel.actions.closePanel' : 'contextPanel.actions.openPanel');
  const railLabel = t(railOpen ? 'contextRail.actions.collapse' : 'contextRail.actions.expand');
  const buttonClass = 'app-region-no-drag flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground';

  if (!directoryKey) return null;

  return <div className="app-region-no-drag flex shrink-0 items-center gap-0.5">
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={panelLabel}
          aria-expanded={panelOpen}
          onClick={() => togglePanel(directoryKey)}
          className={cn(buttonClass, panelOpen && 'bg-interactive-selection text-primary')}
        >
          <Icon name="layout-right" className="size-4" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{panelLabel}</TooltipContent>
    </Tooltip>
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={railLabel}
          aria-expanded={railOpen}
          aria-controls={railOpen ? 'context-panel-rail' : undefined}
          onClick={toggleRail}
          className={cn(buttonClass, 'w-7', railOpen && 'text-foreground')}
        >
          <span aria-hidden="true" className="flex -space-x-2">
            <Icon name={railOpen ? 'arrow-right-s' : 'arrow-left-s'} className="size-4" />
            <Icon name={railOpen ? 'arrow-right-s' : 'arrow-left-s'} className="size-4" />
          </span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{railLabel}</TooltipContent>
    </Tooltip>
  </div>;
};
