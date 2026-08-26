import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useI18n } from '@/lib/i18n';
import { requestPluginSettingsIntegration } from '@/lib/settings/plugin-settings-navigation';
import { cn } from '@/lib/utils';
import { usePiSessionStore } from '@/stores/usePiSessionStore';
import { useUIStore } from '@/stores/useUIStore';
import {
  parsePermissionSystemStatus,
  PERMISSION_SYSTEM_STATUS_CHANNEL,
  type PermissionSystemDecisionSnapshot,
  type PermissionSystemPromptSnapshot,
} from './permissionSystemStatus';

interface PermissionSystemComposerControlProps {
  footerIconButtonClass?: string;
  sessionId?: string | null;
}

const valueSummary = (surface: string | null, value: string | null): string => (
  [surface, value].filter((entry): entry is string => Boolean(entry)).join(' · ')
);

const PromptRow: React.FC<{ prompt: PermissionSystemPromptSnapshot }> = ({ prompt }) => {
  const { t } = useI18n();
  return (
    <div className="rounded-lg border border-[var(--status-warning)]/25 bg-[var(--status-warning)]/5 px-3 py-2">
      <div className="flex items-center gap-2 typography-meta font-medium text-foreground">
        <span className="size-1.5 rounded-full bg-[var(--status-warning)]" />
        {t('chat.modelControls.permissionLabel.ask')}
      </div>
      <p className="mt-1 line-clamp-3 break-all font-mono typography-micro text-muted-foreground">
        {valueSummary(prompt.surface, prompt.value)}
      </p>
      {prompt.agentName || prompt.forwarding?.requesterAgentName ? (
        <p className="mt-1 truncate typography-micro text-muted-foreground">
          {prompt.forwarding?.requesterAgentName ?? prompt.agentName}
        </p>
      ) : null}
    </div>
  );
};

const DecisionRow: React.FC<{ decision: PermissionSystemDecisionSnapshot }> = ({ decision }) => {
  const { t } = useI18n();
  const allowed = decision.result === 'allow';
  return (
    <div className="rounded-lg border border-border/60 px-3 py-2">
      <div className={cn(
        'flex items-center gap-2 typography-meta font-medium',
        allowed ? 'text-[var(--status-success)]' : 'text-[var(--status-error)]',
      )}>
        <Icon name={allowed ? 'check' : 'close'} className="size-3.5" />
        {t(allowed
          ? 'chat.modelControls.permissionLabel.allow'
          : 'chat.modelControls.permissionLabel.deny')}
      </div>
      <p className="mt-1 line-clamp-2 break-all font-mono typography-micro text-muted-foreground">
        {valueSummary(decision.surface, decision.value)}
      </p>
    </div>
  );
};

export const PermissionSystemComposerControl: React.FC<PermissionSystemComposerControlProps> = ({
  footerIconButtonClass,
  sessionId,
}) => {
  const { t } = useI18n();
  const isMobile = useUIStore((state) => state.isMobile);
  const setSettingsDialogOpen = useUIStore((state) => state.setSettingsDialogOpen);
  const setSettingsPage = useUIStore((state) => state.setSettingsPage);
  const [open, setOpen] = React.useState(false);
  const rawStatus = usePiSessionStore((state) => (
    sessionId ? state.records[sessionId]?.extensionStates[PERMISSION_SYSTEM_STATUS_CHANNEL] : undefined
  ));
  const status = React.useMemo(() => parsePermissionSystemStatus(rawStatus), [rawStatus]);

  if (!status) return null;

  const latestPrompt = status.pending.at(-1);
  const openSettings = (): void => {
    setOpen(false);
    requestPluginSettingsIntegration('permission-system');
    setSettingsPage('plugin-settings');
    setSettingsDialogOpen(true);
  };
  const title = t('settings.piarium.pluginSettings.permissionSystem.section.policy');
  const trigger = (
    <button
      type="button"
      className={cn(
        footerIconButtonClass,
        'relative',
        latestPrompt && 'text-[var(--status-warning)]',
      )}
      title={title}
      aria-label={title}
      onClick={isMobile ? () => setOpen(true) : undefined}
    >
      <Icon name="shield-keyhole" className="size-4" />
      {latestPrompt ? (
        <span className="absolute right-0.5 top-0.5 size-1.5 rounded-full bg-[var(--status-warning)]" />
      ) : null}
    </button>
  );
  const content = (
    <div className="space-y-2 p-2">
      {latestPrompt ? <PromptRow prompt={latestPrompt} /> : (
        <p className="px-2 py-2 typography-meta text-muted-foreground">
          {t('settings.piarium.pluginSettings.permissionSystem.runtime.state.available')}
        </p>
      )}
      {status.lastDecision ? <DecisionRow decision={status.lastDecision} /> : null}
      <button
        type="button"
        className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left typography-meta text-foreground hover:bg-interactive-hover"
        onClick={openSettings}
      >
        <Icon name="settings-3" className="size-4 text-muted-foreground" />
        {t('workbench.ide.settings')}
      </button>
    </div>
  );

  if (isMobile) {
    return (
      <>
        {trigger}
        <MobileOverlayPanel open={open} onClose={() => setOpen(false)} title={title}>
          {content}
        </MobileOverlayPanel>
      </>
    );
  }

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[min(320px,calc(100vw-2rem))]" portalToBody>
        <DropdownMenuLabel>{title}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <div className="space-y-2 p-1">
          {latestPrompt ? <PromptRow prompt={latestPrompt} /> : (
            <p className="px-2 py-2 typography-meta text-muted-foreground">
              {t('settings.piarium.pluginSettings.permissionSystem.runtime.state.available')}
            </p>
          )}
          {status.lastDecision ? <DecisionRow decision={status.lastDecision} /> : null}
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={openSettings}>
          <Icon name="settings-3" className="size-4" />
          {t('workbench.ide.settings')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
