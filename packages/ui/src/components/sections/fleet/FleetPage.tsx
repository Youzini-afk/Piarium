import React from 'react';
import type {
  JsonValue,
  PiFleetActionDescriptor,
  PiFleetEntry,
  PiFleetEntryKind,
  PiFleetEntryState,
  PiFleetLogsData,
  PiFleetProviderSnapshot,
  PiFleetSnapshot,
} from '@piarium/protocol';
import { Icon } from '@/components/icon/Icon';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import {
  SettingsCheckboxRow,
  SettingsChipGroup,
  SettingsFieldRow,
  SettingsSection,
  SettingsStackedField,
} from '@/components/sections/shared/SettingsSection';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NumberInput } from '@/components/ui/number-input';
import { toast } from '@/components/ui';
import { usePiChatCatalog } from '@/components/chat/usePiChatCatalog';
import { getPiFleetStatus, runPiFleetAction } from '@/lib/pi-runtime/fleet';
import { useI18n, type I18nKey } from '@/lib/i18n';
import {
  getRuntimeKey,
  subscribeRuntimeEndpointChanged,
} from '@/lib/runtime-switch';
import { requestPluginSettingsIntegration } from '@/lib/settings/plugin-settings-navigation';
import { cn } from '@/lib/utils';
import { usePiSessionStore } from '@/stores/usePiSessionStore';
import { useUIStore } from '@/stores/useUIStore';
import {
  entryAdvertisesAction,
  filterFleetEntries,
  findFleetEntry,
  findFleetProvider,
  fleetEntryIdentity,
  fleetProviderTone,
  formatFleetDuration,
  providerAdvertisesAction,
  type FleetKindFilter,
  type FleetStateFilter,
} from './fleetPresentation';

const FLEET_REFRESH_INTERVAL_MS = 2_000;

const KIND_FILTERS: FleetKindFilter[] = [
  'all',
  'delegated-agent',
  'background-agent',
  'background-task',
];
const STATE_FILTERS: FleetStateFilter[] = [
  'all',
  'running',
  'completed',
  'failed',
  'stopped',
];

const KIND_LABEL_KEYS: Record<PiFleetEntryKind, I18nKey> = {
  'background-agent': 'settings.piarium.fleet.kind.background-agent',
  'background-task': 'settings.piarium.fleet.kind.background-task',
  'delegated-agent': 'settings.piarium.fleet.kind.delegated-agent',
};
const STATE_LABEL_KEYS: Record<PiFleetEntryState, I18nKey> = {
  completed: 'settings.piarium.fleet.entryState.completed',
  failed: 'settings.piarium.fleet.entryState.failed',
  running: 'settings.piarium.fleet.entryState.running',
  stopped: 'settings.piarium.fleet.entryState.stopped',
};
const ACTION_LABEL_KEYS: Record<string, I18nKey> = {
  kill: 'settings.piarium.fleet.actions.kill',
  logs: 'settings.piarium.fleet.actions.logs',
  run: 'settings.piarium.fleet.actions.newTask',
};
const PROVIDER_STATE_LABEL_KEYS: Record<PiFleetProviderSnapshot['state'], I18nKey> = {
  active: 'settings.piarium.fleet.provider.state.active',
  degraded: 'settings.piarium.fleet.provider.state.degraded',
  incompatible: 'settings.piarium.fleet.provider.state.incompatible',
  unavailable: 'settings.piarium.fleet.provider.state.unavailable',
};

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

const emptyRunDraft = () => ({
  command: '',
  isAgent: false,
  name: '',
  notifyOnCompletion: true,
  timeoutSeconds: undefined as number | undefined,
  triggerOnCompletion: false,
});

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
  const [busyAction, setBusyAction] = React.useState<string | null>(null);
  const [selectedIdentity, setSelectedIdentity] = React.useState<string | null>(null);
  const [composingRun, setComposingRun] = React.useState(false);
  const [runProviderId, setRunProviderId] = React.useState<string | null>(null);
  const [runDraft, setRunDraft] = React.useState(emptyRunDraft);
  const [logs, setLogs] = React.useState<{ identity: string; value: PiFleetLogsData } | null>(null);
  const [kindFilter, setKindFilter] = React.useState<FleetKindFilter>('all');
  const [stateFilter, setStateFilter] = React.useState<FleetStateFilter>('all');
  const [providerFilter, setProviderFilter] = React.useState<'all' | string>('all');
  const [query, setQuery] = React.useState('');
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
    setSelectedIdentity(null);
    setComposingRun(false);
    setLogs(null);
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
  const visibleEntries = React.useMemo(
    () => filterFleetEntries(snapshot?.entries ?? [], {
      kind: kindFilter,
      providerId: providerFilter,
      query,
      state: stateFilter,
    }),
    [kindFilter, providerFilter, query, snapshot?.entries, stateFilter],
  );
  const selectedEntry = findFleetEntry(snapshot, selectedIdentity);
  const selectedProvider = selectedEntry
    ? findFleetProvider(providers, selectedEntry.providerId)
    : runProviderId
      ? findFleetProvider(providers, runProviderId)
      : undefined;
  const now = Date.now();
  const runProviders = providers.filter((provider) => providerAdvertisesAction(provider, 'run'));

  React.useEffect(() => {
    if (logs && logs.identity !== selectedIdentity) setLogs(null);
  }, [logs, selectedIdentity]);

  const runFleetAction = React.useCallback(async (input: {
    action: string;
    entry?: PiFleetEntry;
    payload?: JsonValue;
    providerId: string;
  }) => {
    if (!sessionId || busyAction) return;
    const actionKey = `${input.providerId}:${input.action}:${input.entry?.key ?? 'provider'}`;
    setBusyAction(actionKey);
    try {
      const result = await runPiFleetAction({
        action: input.action,
        ...(input.entry ? { entryKey: input.entry.key } : {}),
        ...(input.payload === undefined ? {} : { payload: input.payload }),
        providerId: input.providerId,
        sessionId,
      });
      setSnapshot(result.snapshot);
      if (result.entry) setSelectedIdentity(fleetEntryIdentity(result.entry));
      if (result.logs && input.entry) {
        setLogs({ identity: fleetEntryIdentity(result.entry ?? input.entry), value: result.logs });
      }
    } catch (actionError) {
      toast.error(t('settings.piarium.fleet.actionFailed'), {
        description: actionError instanceof Error ? actionError.message : String(actionError),
      });
    } finally {
      setBusyAction(null);
    }
  }, [busyAction, sessionId, t]);

  const submitRun = React.useCallback(async () => {
    if (!runProviderId) return;
    const name = runDraft.name.trim();
    const command = runDraft.command.trim();
    if (!name || !command) return;
    const payload: JsonValue = {
      command,
      isAgent: runDraft.isAgent,
      name,
      notifyOnCompletion: runDraft.notifyOnCompletion,
      triggerOnCompletion: runDraft.triggerOnCompletion,
      ...(runDraft.timeoutSeconds === undefined ? {} : { timeoutSeconds: runDraft.timeoutSeconds }),
    };
    await runFleetAction({ action: 'run', payload, providerId: runProviderId });
    setComposingRun(false);
    setRunDraft(emptyRunDraft());
  }, [runDraft, runFleetAction, runProviderId]);

  const requestEntryAction = React.useCallback((entry: PiFleetEntry, descriptor: PiFleetActionDescriptor) => {
    if (descriptor.action === 'kill') {
      if (!window.confirm(t('settings.piarium.fleet.actions.killConfirm', { name: entry.name }))) return;
    }
    void runFleetAction({
      action: descriptor.action,
      entry,
      providerId: entry.providerId,
    });
  }, [runFleetAction, t]);

  const actionLabel = React.useCallback((action: string) => {
    const key = ACTION_LABEL_KEYS[action];
    return key ? t(key) : action;
  }, [t]);

  const showDetail = Boolean(selectedEntry || composingRun);
  const nowLabel = formatFleetDuration;

  return (
    <SettingsPageLayout
      title={t('settings.page.fleet.title')}
      description={t('settings.piarium.fleet.description')}
      className="max-w-6xl"
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
          <div className="flex flex-wrap gap-2">
            {providers.map((provider) => (
              <div key={provider.id} className={cn('min-w-0 rounded-lg border px-3 py-2', providerToneClass(provider))}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="typography-ui-label text-foreground">{provider.label}</span>
                  <span className="rounded-full border border-current/20 px-2 py-0.5 typography-micro">
                    {t(PROVIDER_STATE_LABEL_KEYS[provider.state])}
                  </span>
                </div>
                {provider.issue ? (
                  <p className="mt-1 break-words typography-meta">{provider.issue}</p>
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
        settingsItem="fleet.list"
        title={t('settings.piarium.fleet.list.title')}
        headerAction={snapshot ? (
          <span className="tabular-nums typography-meta text-muted-foreground">
            {t('settings.piarium.fleet.active.count', { count: snapshot.totalActive })}
          </span>
        ) : undefined}
      >
        {!sessionId ? (
          <p className="typography-meta text-muted-foreground">
            {t('settings.piarium.fleet.active.unavailable')}
          </p>
        ) : (
          <div className="@3xl:grid @3xl:grid-cols-[minmax(16rem,22rem)_minmax(0,1fr)] @3xl:items-start @3xl:gap-6">
            <div className={cn('space-y-4', showDetail && 'hidden @3xl:block')}>
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t('settings.piarium.fleet.search.placeholder')}
                aria-label={t('settings.piarium.fleet.search.placeholder')}
                className="max-w-md"
              />
              <SettingsChipGroup
                aria-label={t('settings.piarium.fleet.filter.provider')}
                value={providerFilter}
                onChange={setProviderFilter}
                options={[
                  { value: 'all', label: t('settings.piarium.fleet.filter.providerAll') },
                  ...providers.map((provider) => ({ value: provider.id, label: provider.label })),
                ]}
              />
              <SettingsChipGroup
                aria-label={t('settings.piarium.fleet.filter.kind')}
                value={kindFilter}
                onChange={setKindFilter}
                options={KIND_FILTERS.map((value) => ({
                  value,
                  label: value === 'all'
                    ? t('settings.piarium.fleet.filter.kindAll')
                    : t(KIND_LABEL_KEYS[value]),
                }))}
              />
              <SettingsChipGroup
                aria-label={t('settings.piarium.fleet.filter.state')}
                value={stateFilter}
                onChange={setStateFilter}
                options={STATE_FILTERS.map((value) => ({
                  value,
                  label: value === 'all'
                    ? t('settings.piarium.fleet.filter.stateAll')
                    : t(STATE_LABEL_KEYS[value]),
                }))}
              />
              {runProviders.length > 0 ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={!sessionId}
                  onClick={() => {
                    setComposingRun(true);
                    setSelectedIdentity(null);
                    setRunProviderId(runProviders[0]?.id ?? null);
                    setRunDraft(emptyRunDraft());
                  }}
                >
                  {t('settings.piarium.fleet.actions.newTask')}
                </Button>
              ) : null}
              {visibleEntries.length > 0 ? (
                <div className="space-y-1.5">
                  {visibleEntries.map((item) => {
                    const identity = fleetEntryIdentity(item);
                    const selected = identity === selectedIdentity && !composingRun;
                    return (
                      <button
                        key={identity}
                        type="button"
                        onClick={() => {
                          setSelectedIdentity(identity);
                          setComposingRun(false);
                        }}
                        className={cn(
                          'w-full rounded-lg border px-3 py-2 text-left transition-colors',
                          selected
                            ? 'border-border bg-[var(--interactive-selection)]'
                            : 'border-border/60 bg-background/40 hover:bg-[var(--surface-subtle)]',
                        )}
                      >
                        <div className="flex min-w-0 items-center gap-2">
                          {item.state === 'running' ? (
                            <span className="relative flex size-2 shrink-0">
                              <span className="absolute inline-flex size-full animate-ping rounded-full bg-[var(--status-success)] opacity-50" />
                              <span className="relative inline-flex size-2 rounded-full bg-[var(--status-success)]" />
                            </span>
                          ) : (
                            <span className="size-2 shrink-0 rounded-full bg-muted-foreground/50" />
                          )}
                          <span className="min-w-0 flex-1 truncate typography-ui-label text-foreground">{item.name}</span>
                          <span className="shrink-0 typography-micro text-muted-foreground">
                            {t(STATE_LABEL_KEYS[item.state])}
                          </span>
                        </div>
                        <p className="mt-1 truncate typography-micro text-muted-foreground">
                          {t(KIND_LABEL_KEYS[item.kind])}
                          {providers.length > 1 ? ` · ${findFleetProvider(providers, item.providerId)?.label ?? item.providerId}` : ''}
                        </p>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <div className="rounded-lg border border-dashed border-border/70 px-4 py-8 text-center">
                  <Icon name="pulse" className="mx-auto size-6 text-muted-foreground" />
                  <p className="mt-3 typography-ui-label text-foreground">
                    {t('settings.piarium.fleet.list.empty')}
                  </p>
                </div>
              )}
              {snapshot && snapshot.omitted > 0 ? (
                <p className="typography-meta text-muted-foreground">
                  {t('settings.piarium.fleet.active.omitted', { count: snapshot.omitted })}
                </p>
              ) : null}
            </div>

            <div className={cn(!showDetail && 'hidden @3xl:block')}>
              {showDetail ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="mb-3 gap-1.5 @3xl:hidden"
                  onClick={() => {
                    setSelectedIdentity(null);
                    setComposingRun(false);
                  }}
                >
                  <Icon name="arrow-left" className="size-4" />
                  {t('settings.piarium.fleet.back')}
                </Button>
              ) : null}
              {composingRun && runProviderId ? (
                <div className="space-y-4">
                  <p className="typography-ui-label text-foreground">{t('settings.piarium.fleet.run.title')}</p>
                  {runProviders.length > 1 ? (
                    <SettingsChipGroup
                      aria-label={t('settings.piarium.fleet.filter.provider')}
                      value={runProviderId}
                      onChange={setRunProviderId}
                      options={runProviders.map((provider) => ({
                        value: provider.id,
                        label: provider.label,
                      }))}
                    />
                  ) : null}
                  <SettingsStackedField label={t('settings.piarium.fleet.run.name')}>
                    <Input
                      value={runDraft.name}
                      onChange={(event) => setRunDraft((current) => ({ ...current, name: event.target.value }))}
                    />
                  </SettingsStackedField>
                  <SettingsStackedField label={t('settings.piarium.fleet.run.command')}>
                    <Input
                      value={runDraft.command}
                      onChange={(event) => setRunDraft((current) => ({ ...current, command: event.target.value }))}
                    />
                  </SettingsStackedField>
                  <SettingsCheckboxRow
                    checked={runDraft.isAgent}
                    onChange={(checked) => setRunDraft((current) => ({ ...current, isAgent: checked }))}
                    label={t('settings.piarium.fleet.run.isAgent')}
                  />
                  <SettingsCheckboxRow
                    checked={runDraft.notifyOnCompletion}
                    onChange={(checked) => setRunDraft((current) => ({ ...current, notifyOnCompletion: checked }))}
                    label={t('settings.piarium.fleet.run.notifyOnCompletion')}
                  />
                  <SettingsCheckboxRow
                    checked={runDraft.triggerOnCompletion}
                    onChange={(checked) => setRunDraft((current) => ({ ...current, triggerOnCompletion: checked }))}
                    label={t('settings.piarium.fleet.run.triggerOnCompletion')}
                  />
                  <SettingsFieldRow label={t('settings.piarium.fleet.run.timeoutSeconds')}>
                    <NumberInput
                      value={runDraft.timeoutSeconds}
                      min={1}
                      step={1}
                      onValueChange={(value) => setRunDraft((current) => ({ ...current, timeoutSeconds: value }))}
                      onClear={() => setRunDraft((current) => ({ ...current, timeoutSeconds: undefined }))}
                    />
                  </SettingsFieldRow>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      size="sm"
                      disabled={!runDraft.name.trim() || !runDraft.command.trim() || busyAction !== null}
                      onClick={() => void submitRun()}
                    >
                      {t('settings.piarium.fleet.run.submit')}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setComposingRun(false)}
                    >
                      {t('settings.piarium.fleet.run.cancel')}
                    </Button>
                  </div>
                </div>
              ) : selectedEntry ? (
                <div className="space-y-4">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="typography-ui-label text-foreground">{selectedEntry.name}</h3>
                      <span className="rounded-full border border-border/60 px-2 py-0.5 typography-micro text-muted-foreground">
                        {t(STATE_LABEL_KEYS[selectedEntry.state])}
                      </span>
                      <span className="typography-micro text-muted-foreground">
                        {t(KIND_LABEL_KEYS[selectedEntry.kind])}
                      </span>
                    </div>
                    {selectedEntry.description ? (
                      <p className="mt-2 typography-meta text-foreground/80">{selectedEntry.description}</p>
                    ) : null}
                    {selectedEntry.error ? (
                      <p className="mt-2 break-words typography-meta text-[var(--status-error)]">{selectedEntry.error}</p>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap gap-x-3 gap-y-1 typography-micro text-muted-foreground">
                    {selectedProvider ? <span>{selectedProvider.label}</span> : null}
                    {selectedEntry.agent ? <span>{selectedEntry.agent}</span> : null}
                    {selectedEntry.role ? <span>{selectedEntry.role}</span> : null}
                    {selectedEntry.model ? <span>{selectedEntry.model}</span> : null}
                    {selectedEntry.effort ? <span>{selectedEntry.effort}</span> : null}
                    <span>{nowLabel(selectedEntry.startedAt, now)}</span>
                    {selectedEntry.tokens ? (
                      <span>
                        {t('settings.piarium.fleet.entry.tokens', {
                          count: new Intl.NumberFormat().format(selectedEntry.tokens.total),
                        })}
                      </span>
                    ) : null}
                    {selectedEntry.bytesWritten !== undefined ? (
                      <span>
                        {t('settings.piarium.fleet.entry.bytes', {
                          count: new Intl.NumberFormat().format(selectedEntry.bytesWritten),
                        })}
                      </span>
                    ) : null}
                  </div>
                  {selectedEntry.tokens ? (
                    <div className="flex gap-3 typography-micro text-muted-foreground/80">
                      <span>{t('settings.piarium.fleet.entry.input', { count: selectedEntry.tokens.input })}</span>
                      <span>{t('settings.piarium.fleet.entry.output', { count: selectedEntry.tokens.output })}</span>
                    </div>
                  ) : null}
                  {selectedEntry.actions.length > 0 ? (
                    <div className="flex flex-wrap gap-2">
                      {selectedEntry.actions.filter((descriptor) => ACTION_LABEL_KEYS[descriptor.action]).map((descriptor) => (
                        <Button
                          key={descriptor.action}
                          type="button"
                          variant={descriptor.destructive ? 'destructive' : 'outline'}
                          size="sm"
                          disabled={busyAction !== null}
                          onClick={() => requestEntryAction(selectedEntry, descriptor)}
                        >
                          {actionLabel(descriptor.action)}
                        </Button>
                      ))}
                    </div>
                  ) : null}
                  {entryAdvertisesAction(selectedEntry, 'logs') ? (
                    <div>
                      <p className="typography-ui-label text-foreground">{t('settings.piarium.fleet.logs.title')}</p>
                      {logs && logs.identity === fleetEntryIdentity(selectedEntry) ? (
                        <>
                          {logs.value.truncated ? (
                            <p className="mt-1 typography-meta text-muted-foreground">
                              {t('settings.piarium.fleet.logs.truncated', { bytes: logs.value.bytesRead })}
                            </p>
                          ) : null}
                          <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border/60 bg-background/40 p-3 typography-micro text-foreground">
                            {logs.value.text}
                          </pre>
                        </>
                      ) : (
                        <p className="mt-1 typography-meta text-muted-foreground">
                          {t('settings.piarium.fleet.logs.empty')}
                        </p>
                      )}
                    </div>
                  ) : null}
                </div>
              ) : (
                <p className="typography-meta text-muted-foreground">
                  {t('settings.piarium.fleet.detail.empty')}
                </p>
              )}
            </div>
          </div>
        )}
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
