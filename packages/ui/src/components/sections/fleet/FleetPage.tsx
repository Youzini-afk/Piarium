import React from 'react';
import type { PiFleetProviderSnapshot, PiFleetSnapshot } from '@piarium/protocol';
import { Icon } from '@/components/icon/Icon';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import { SettingsSection } from '@/components/sections/shared/SettingsSection';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui';
import { usePiChatCatalog } from '@/components/chat/usePiChatCatalog';
import { getPiFleetStatus } from '@/lib/pi-runtime/fleet';
import { useI18n } from '@/lib/i18n';
import {
  getRuntimeKey,
  subscribeRuntimeEndpointChanged,
} from '@/lib/runtime-switch';
import { requestPluginSettingsIntegration } from '@/lib/settings/plugin-settings-navigation';
import { cn } from '@/lib/utils';
import { usePiSessionStore } from '@/stores/usePiSessionStore';
import { useUIStore } from '@/stores/useUIStore';
import { fleetProviderTone, formatFleetDuration } from './fleetPresentation';

const FLEET_REFRESH_INTERVAL_MS = 2_000;

const providerToneClass = (provider: PiFleetProviderSnapshot): string => {
  switch (fleetProviderTone(provider.state)) {
    case 'success':
      return 'border-[var(--status-success)]/30 bg-[var(--status-success)]/5 text-[var(--status-success)]';
    case 'warning':
      return 'border-[var(--status-warning)]/30 bg-[var(--status-warning)]/5 text-[var(--status-warning)]';
    case 'error':
      return 'border-[var(--status-error)]/30 bg-[var(--status-error)]/5 text-[var(--status-error)]';
    case 'muted':
    default:
      return 'border-border/60 bg-background/40 text-muted-foreground';
  }
};

const subscribeRuntimeKey = (notify: () => void): (() => void) => (
  subscribeRuntimeEndpointChanged(() => notify())
);

export const FleetPage: React.FC = () => {
  const { t } = useI18n();
  const runtimeKey = React.useSyncExternalStore(
    subscribeRuntimeKey,
    getRuntimeKey,
    getRuntimeKey,
  );
  const sessionId = usePiSessionStore((state) => {
    const current = state.currentSessionId;
    return current && state.records[current]?.open ? current : null;
  });
  const executeCommand = usePiSessionStore((state) => state.executeCommand);
  const setSettingsPage = useUIStore((state) => state.setSettingsPage);
  const catalog = usePiChatCatalog({ sessionId, refreshOnMount: true });
  const [snapshot, setSnapshot] = React.useState<PiFleetSnapshot | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [runningCommand, setRunningCommand] = React.useState<string | null>(null);
  const targetKey = sessionId ? `${runtimeKey}:session:${sessionId}` : null;
  const targetKeyRef = React.useRef(targetKey);
  targetKeyRef.current = targetKey;
  const requestGenerationRef = React.useRef(0);
  const inFlightRef = React.useRef<{ key: string; promise: Promise<void> } | null>(null);

  const refresh = React.useCallback((showLoading = false): Promise<void> => {
    if (!sessionId || !targetKey) return Promise.resolve();
    if (inFlightRef.current?.key === targetKey) return inFlightRef.current.promise;
    const generation = ++requestGenerationRef.current;
    if (showLoading) setLoading(true);
    const actionRuntimeKey = runtimeKey;
    const promise = (async () => {
      try {
        const next = await getPiFleetStatus(sessionId);
        if (
          generation !== requestGenerationRef.current
          || targetKeyRef.current !== targetKey
          || getRuntimeKey() !== actionRuntimeKey
        ) return;
        setSnapshot(next);
        setError(null);
      } catch (nextError) {
        if (
          generation !== requestGenerationRef.current
          || targetKeyRef.current !== targetKey
          || getRuntimeKey() !== actionRuntimeKey
        ) return;
        setError(nextError instanceof Error ? nextError.message : String(nextError));
      } finally {
        if (generation === requestGenerationRef.current && targetKeyRef.current === targetKey) {
          setLoading(false);
        }
      }
    })();
    inFlightRef.current = { key: targetKey, promise };
    void promise.finally(() => {
      if (inFlightRef.current?.promise === promise) inFlightRef.current = null;
    });
    return promise;
  }, [runtimeKey, sessionId, targetKey]);

  React.useEffect(() => {
    requestGenerationRef.current += 1;
    inFlightRef.current = null;
    setSnapshot(null);
    setError(null);
    setLoading(Boolean(sessionId));
    if (!sessionId) return;
    void refresh(true);
    const timer = globalThis.setInterval(() => void refresh(false), FLEET_REFRESH_INTERVAL_MS);
    return () => {
      globalThis.clearInterval(timer);
      requestGenerationRef.current += 1;
    };
  }, [refresh, sessionId]);

  const commandNames = React.useMemo(
    () => new Set(catalog.commands.map((command) => command.name)),
    [catalog.commands],
  );

  const runCommand = React.useCallback(async (command: string) => {
    if (!sessionId || runningCommand) return;
    setRunningCommand(command);
    try {
      await executeCommand(sessionId, `/${command}`);
      await refresh(false);
    } catch (commandError) {
      toast.error(t('settings.piarium.fleet.commandFailed'), {
        description: commandError instanceof Error ? commandError.message : String(commandError),
      });
    } finally {
      setRunningCommand(null);
    }
  }, [executeCommand, refresh, runningCommand, sessionId, t]);

  const openSubagentsSettings = React.useCallback(() => {
    requestPluginSettingsIntegration('subagents');
    setSettingsPage('plugin-settings');
  }, [setSettingsPage]);

  const providers = snapshot?.providers ?? [];
  const hasActiveProvider = providers.some((provider) => provider.state === 'active');
  const now = Date.now();

  return (
    <SettingsPageLayout
      title={t('settings.page.fleet.title')}
      description={t('settings.piarium.fleet.description')}
      className="max-w-5xl"
      showSaveStatus={false}
      headerEnd={sessionId ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={loading}
          onClick={() => void refresh(true)}
          className="gap-1.5"
        >
          <Icon name="refresh" className={loading ? 'size-4 animate-spin' : 'size-4'} />
          {t('settings.piarium.fleet.refresh')}
        </Button>
      ) : undefined}
    >
      <SettingsSection
        settingsItem="fleet.provider"
        title={t('settings.piarium.fleet.provider.title')}
        description={t('settings.piarium.fleet.provider.description')}
        divider={false}
        headerAction={(
          <Button type="button" variant="outline" size="xs" onClick={openSubagentsSettings}>
            {t('settings.piarium.fleet.configure')}
          </Button>
        )}
      >
        {!sessionId ? (
          <div className="rounded-lg border border-border/60 bg-background/40 px-4 py-4">
            <p className="typography-ui-label text-foreground">
              {t('settings.piarium.fleet.noSession.title')}
            </p>
            <p className="mt-1 typography-meta text-muted-foreground">
              {t('settings.piarium.fleet.noSession.description')}
            </p>
          </div>
        ) : providers.length > 0 ? (
          <div className="space-y-2">
            {providers.map((provider) => (
              <div key={provider.id} className={cn('rounded-lg border px-4 py-3', providerToneClass(provider))}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="typography-ui-label text-foreground">{provider.label}</span>
                  <span className="rounded-full border border-current/20 px-2 py-0.5 typography-micro">
                    {t(`settings.piarium.fleet.provider.state.${provider.state}`)}
                  </span>
                  {provider.bridgeVersion !== undefined ? (
                    <span className="typography-micro text-muted-foreground">
                      {t('settings.piarium.fleet.provider.bridgeVersion', { version: provider.bridgeVersion })}
                    </span>
                  ) : null}
                </div>
                {provider.source ? (
                  <p className="mt-1 font-mono typography-micro text-muted-foreground">{provider.source}</p>
                ) : null}
                {provider.issue ? (
                  <p className="mt-2 break-words typography-meta">{provider.issue}</p>
                ) : null}
              </div>
            ))}
          </div>
        ) : loading ? (
          <div className="flex items-center gap-2 py-3 typography-meta text-muted-foreground">
            <Icon name="loader-4" className="size-4 animate-spin" />
            {t('settings.piarium.fleet.loading')}
          </div>
        ) : null}
        {error ? (
          <p className="mt-3 break-words typography-meta text-[var(--status-error)]">{error}</p>
        ) : null}
      </SettingsSection>

      <SettingsSection
        settingsItem="fleet.active"
        title={t('settings.piarium.fleet.active.title')}
        description={t('settings.piarium.fleet.active.description')}
        headerAction={hasActiveProvider ? (
          <span className="tabular-nums typography-meta text-muted-foreground">
            {t('settings.piarium.fleet.active.count', { count: snapshot?.totalActive ?? 0 })}
          </span>
        ) : undefined}
      >
        {hasActiveProvider && snapshot && snapshot.entries.length > 0 ? (
          <div className="grid grid-cols-1 gap-3 @3xl:grid-cols-2">
            {snapshot.entries.map((entry) => (
              <article key={`${entry.providerId}:${entry.key}`} className="rounded-lg border border-border/60 bg-background/40 px-4 py-3">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="relative flex size-2 shrink-0">
                    <span className="absolute inline-flex size-full animate-ping rounded-full bg-[var(--status-success)] opacity-50" />
                    <span className="relative inline-flex size-2 rounded-full bg-[var(--status-success)]" />
                  </span>
                  <h3 className="min-w-0 flex-1 truncate typography-ui-label text-foreground">{entry.agent}</h3>
                  {entry.role ? (
                    <span className="max-w-32 truncate rounded bg-[var(--surface-elevated)] px-1.5 py-0.5 typography-micro text-muted-foreground">
                      {entry.role}
                    </span>
                  ) : null}
                  {providers.length > 1 ? (
                    <span className="max-w-32 truncate typography-micro text-muted-foreground">
                      {providers.find((provider) => provider.id === entry.providerId)?.label ?? entry.providerId}
                    </span>
                  ) : null}
                </div>
                {entry.goal ? (
                  <p className="mt-2 line-clamp-3 typography-meta text-foreground/80">{entry.goal}</p>
                ) : null}
                <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 typography-micro text-muted-foreground">
                  {entry.model ? <span>{entry.model}</span> : null}
                  {entry.effort ? <span>{entry.effort}</span> : null}
                  <span>{formatFleetDuration(entry.startedAt, now)}</span>
                  <span>
                    {t('settings.piarium.fleet.entry.tokens', {
                      count: new Intl.NumberFormat().format(entry.tokens.total),
                    })}
                  </span>
                </div>
                <div className="mt-1 flex gap-3 typography-micro text-muted-foreground/80">
                  <span>{t('settings.piarium.fleet.entry.input', { count: entry.tokens.input })}</span>
                  <span>{t('settings.piarium.fleet.entry.output', { count: entry.tokens.output })}</span>
                </div>
              </article>
            ))}
          </div>
        ) : hasActiveProvider && snapshot ? (
          <div className="rounded-lg border border-dashed border-border/70 px-4 py-8 text-center">
            <Icon name="pulse" className="mx-auto size-6 text-muted-foreground" />
            <p className="mt-3 typography-ui-label text-foreground">
              {t('settings.piarium.fleet.empty.title')}
            </p>
            <p className="mt-1 typography-meta text-muted-foreground">
              {t('settings.piarium.fleet.empty.description')}
            </p>
          </div>
        ) : (
          <p className="typography-meta text-muted-foreground">
            {t('settings.piarium.fleet.active.unavailable')}
          </p>
        )}
        {hasActiveProvider && snapshot && snapshot.omitted > 0 ? (
          <p className="mt-3 typography-meta text-muted-foreground">
            {t('settings.piarium.fleet.active.omitted', { count: snapshot.omitted })}
          </p>
        ) : null}
      </SettingsSection>

      <SettingsSection
        settingsItem="fleet.actions"
        title={t('settings.piarium.fleet.actions.title')}
        description={t('settings.piarium.fleet.actions.description')}
      >
        <div className="flex flex-wrap gap-2">
          {commandNames.has('subagents-fleet') ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!sessionId || runningCommand !== null}
              onClick={() => void runCommand('subagents-fleet')}
            >
              {t('settings.piarium.fleet.actions.inspector')}
            </Button>
          ) : null}
          {commandNames.has('subagents-stop') ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!sessionId || runningCommand !== null}
              onClick={() => void runCommand('subagents-stop')}
            >
              {t('settings.piarium.fleet.actions.stop')}
            </Button>
          ) : null}
          {commandNames.has('subagents-doctor') ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!sessionId || runningCommand !== null}
              onClick={() => void runCommand('subagents-doctor')}
            >
              {t('settings.piarium.fleet.actions.doctor')}
            </Button>
          ) : null}
          <Button type="button" variant="ghost" size="sm" onClick={() => setSettingsPage('plugins')}>
            {t('settings.piarium.fleet.actions.packages')}
          </Button>
        </div>
        <p className="mt-3 typography-meta text-muted-foreground">
          {t('settings.piarium.fleet.actions.targetNote')}
        </p>
      </SettingsSection>
    </SettingsPageLayout>
  );
};
