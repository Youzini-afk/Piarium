import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { normalizeContextPanelDirectoryKey, useUIStore } from '@/stores/useUIStore';

/** Header control for the workspace icon rail. Panel opening lives with the chat work-overview controls. */
export const ContextPanelControls: React.FC = () => {
  const { t } = useI18n();
  const directory = useEffectiveDirectory();
  const directoryKey = directory ? normalizeContextPanelDirectoryKey(directory) : '';
  const railOpen = useUIStore((state) => state.isContextRailOpen);
  const toggleRail = useUIStore((state) => state.toggleContextRail);
  const railLabel = t(railOpen ? 'contextRail.actions.collapse' : 'contextRail.actions.expand');
  const buttonClass = 'app-region-no-drag flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground';

  if (!directoryKey) return null;

  return <div className="app-region-no-drag flex shrink-0 items-center gap-0.5">
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
