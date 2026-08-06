import React from 'react';
import type { RuntimeContextTarget } from '@piarium/protocol';
import { usePiChatCatalog } from '@/components/chat/usePiChatCatalog';
import { Icon } from '@/components/icon/Icon';
import { SettingsControlGroup } from '@/components/sections/shared/SettingsSection';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { usePiSessionStore } from '@/stores/usePiSessionStore';
import {
  buildWebAccessRuntimeCommand,
  webAccessRuntimeCommandName,
  type WebAccessRuntimeActionId,
} from './web-access-runtime';

interface WebAccessRuntimePanelProps {
  runtimeTarget: RuntimeContextTarget;
}

export const WebAccessRuntimePanel: React.FC<WebAccessRuntimePanelProps> = ({
  runtimeTarget,
}) => {
  const { t } = useI18n();
  const sessionId = 'sessionId' in runtimeTarget ? runtimeTarget.sessionId : null;
  const catalog = usePiChatCatalog({ sessionId, refreshOnMount: true });
  const executeCommand = usePiSessionStore((state) => state.executeCommand);
  const sessionRecord = usePiSessionStore((state) => (
    sessionId ? state.records[sessionId] : undefined
  ));
  const [query, setQuery] = React.useState('');
  const [runningCommand, setRunningCommand] = React.useState<string | null>(null);
  const commandNames = React.useMemo(
    () => new Set(catalog.commands.map((command) => command.name)),
    [catalog.commands],
  );
  const sessionBusy = sessionRecord?.snapshot?.busy === true;
  const webAccessAvailable = sessionId !== null && commandNames.has('websearch');
  const actionsDisabled = !webAccessAvailable || sessionBusy || runningCommand !== null;
  const providerState = !sessionId
    ? 'unavailable'
    : catalog.loading && !catalog.loaded
      ? 'loading'
      : webAccessAvailable
        ? 'available'
        : 'unavailable';

  const commandAvailable = React.useCallback((action: WebAccessRuntimeActionId) => (
    commandNames.has(webAccessRuntimeCommandName(action))
  ), [commandNames]);

  const runAction = React.useCallback(async (
    action: WebAccessRuntimeActionId,
    options?: { query?: string },
  ): Promise<void> => {
    if (!sessionId || runningCommand || sessionBusy) return;
    const command = buildWebAccessRuntimeCommand(action, options);
    setRunningCommand(webAccessRuntimeCommandName(action));
    try {
      await executeCommand(sessionId, `/${command}`);
    } catch (error) {
      toast.error(t('settings.piarium.pluginSettings.webAccess.runtime.commandFailed'), {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setRunningCommand(null);
    }
  }, [executeCommand, runningCommand, sessionBusy, sessionId, t]);

  const openCurator = React.useCallback(() => {
    void runAction('open-curator', { query });
  }, [query, runAction]);

  return (
    <div className="space-y-5 border-t border-border/60 pt-6">
      <div className="flex flex-col gap-3 @xl:flex-row @xl:items-start @xl:justify-between">
        <div className="min-w-0 space-y-1">
          <h3 className="typography-settings-group-title text-foreground">
            {t('settings.piarium.pluginSettings.webAccess.runtime.title')}
          </h3>
          <p className="typography-meta text-muted-foreground">
            {t('settings.piarium.pluginSettings.webAccess.runtime.description')}
          </p>
        </div>
        <span className={cn(
          'w-fit rounded-full border px-2 py-0.5 typography-micro',
          providerState === 'available'
            ? 'border-[var(--status-success)]/30 text-[var(--status-success)]'
            : 'border-border/60 text-muted-foreground',
        )}>
          {t(`settings.piarium.pluginSettings.webAccess.runtime.state.${providerState}`)}
        </span>
      </div>

      {!sessionId ? (
        <p className="rounded-md bg-[var(--surface-elevated)] px-3 py-2 typography-meta text-muted-foreground">
          {t('settings.piarium.pluginSettings.webAccess.runtime.openSession')}
        </p>
      ) : catalog.error ? (
        <p className="break-words typography-meta text-[var(--status-error)]">{catalog.error}</p>
      ) : !webAccessAvailable && catalog.loaded ? (
        <p className="rounded-md bg-[var(--surface-elevated)] px-3 py-2 typography-meta text-muted-foreground">
          {t('settings.piarium.pluginSettings.webAccess.runtime.notActive')}
        </p>
      ) : null}

      {runningCommand ? (
        <p className="flex items-center gap-2 rounded-md bg-[var(--surface-elevated)] px-3 py-2 typography-meta text-muted-foreground">
          <Icon name="loader-4" className="size-4 animate-spin" />
          {t('settings.piarium.pluginSettings.webAccess.runtime.running', {
            command: `/${runningCommand}`,
          })}
        </p>
      ) : sessionBusy ? (
        <p className="rounded-md border border-[var(--status-warning)]/30 bg-[var(--status-warning)]/5 px-3 py-2 typography-meta text-[var(--status-warning)]">
          {t('settings.piarium.pluginSettings.webAccess.runtime.busy')}
        </p>
      ) : null}

      <SettingsControlGroup
        title={t('settings.piarium.pluginSettings.webAccess.runtime.curator.title')}
        description={t('settings.piarium.pluginSettings.webAccess.runtime.curator.description')}
        contentClassName="space-y-3"
      >
        <form
          className="flex flex-col gap-2 @xl:flex-row @xl:items-end"
          onSubmit={(event) => {
            event.preventDefault();
            openCurator();
          }}
        >
          <div className="min-w-0 flex-1 space-y-1.5">
            <label className="typography-settings-field-label text-foreground" htmlFor="web-access-query">
              {t('settings.piarium.pluginSettings.webAccess.runtime.query')}
            </label>
            <Input
              id="web-access-query"
              value={query}
              disabled={actionsDisabled}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('settings.piarium.pluginSettings.webAccess.runtime.queryPlaceholder')}
            />
          </div>
          <Button
            type="submit"
            variant="outline"
            size="sm"
            disabled={actionsDisabled || !commandAvailable('open-curator')}
          >
            {runningCommand === 'websearch' ? <Icon name="loader-4" className="size-4 animate-spin" /> : null}
            {t('settings.piarium.pluginSettings.webAccess.runtime.action.openCurator')}
          </Button>
        </form>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={actionsDisabled || !commandAvailable('curator-on')}
            onClick={() => void runAction('curator-on')}
          >
            {t('settings.piarium.pluginSettings.webAccess.runtime.action.curatorOn')}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={actionsDisabled || !commandAvailable('curator-summary-review')}
            onClick={() => void runAction('curator-summary-review')}
          >
            {t('settings.piarium.pluginSettings.webAccess.runtime.action.curatorSummaryReview')}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={actionsDisabled || !commandAvailable('curator-off')}
            onClick={() => void runAction('curator-off')}
          >
            {t('settings.piarium.pluginSettings.webAccess.runtime.action.curatorOff')}
          </Button>
        </div>
      </SettingsControlGroup>

      <SettingsControlGroup
        className="border-t border-border/60 pt-5"
        title={t('settings.piarium.pluginSettings.webAccess.runtime.utilities.title')}
        description={t('settings.piarium.pluginSettings.webAccess.runtime.utilities.description')}
        contentClassName="flex flex-wrap gap-2"
      >
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={actionsDisabled || !commandAvailable('google-account')}
          onClick={() => void runAction('google-account')}
        >
          {runningCommand === 'google-account' ? <Icon name="loader-4" className="size-4 animate-spin" /> : null}
          {t('settings.piarium.pluginSettings.webAccess.runtime.action.googleAccount')}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={actionsDisabled || !commandAvailable('stored-results')}
          onClick={() => void runAction('stored-results')}
        >
          {runningCommand === 'search' ? <Icon name="loader-4" className="size-4 animate-spin" /> : null}
          {t('settings.piarium.pluginSettings.webAccess.runtime.action.storedResults')}
        </Button>
      </SettingsControlGroup>

      <p className="typography-meta text-muted-foreground">
        {t('settings.piarium.pluginSettings.webAccess.runtime.ownershipNote')}
      </p>
    </div>
  );
};
