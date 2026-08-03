import React from 'react';
import type {
  JsonValue,
  PiAgentActionDescriptor,
  PiAgentCatalogSnapshot,
  PiAgentDescriptor,
  PiAgentProviderDescriptor,
  PiAgentStatus,
  RuntimeContextTarget,
} from '@piarium/protocol';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import {
  SETTINGS_FIELD_LABEL_CLASS,
  SETTINGS_HELPER_CLASS,
  SettingsSection,
} from '@/components/sections/shared/SettingsSection';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { usePiSessionStore } from '@/stores/usePiSessionStore';
import { useUIStore } from '@/stores/useUIStore';
import {
  listPiAgentProviders,
  runPiAgentProviderAction,
} from '@/lib/pi-runtime/agent-providers';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useI18n } from '@/lib/i18n';
import { requestPluginSettingsTarget } from '@/lib/settings/plugin-settings-navigation';
import { cn } from '@/lib/utils';
import { AgentProviderActionDialog } from './AgentProviderActionDialog';
import { PiSubagentsDefinitionDialog } from './PiSubagentsDefinitionDialog';
import type { PiSubagentsDefinitionMode } from './pi-subagents-action-model';

const EMPTY_CATALOG: PiAgentCatalogSnapshot = {
  agents: [],
  diagnostics: [],
  projectTrusted: false,
  providers: [],
};

type ProviderFilter = 'all' | string;
type StatusFilter = 'all' | PiAgentStatus;

interface AgentActionState {
  action: string;
  agentId?: string;
  loading: boolean;
  message?: string;
  providerId: string;
  success?: boolean;
}

const STATUS_FILTERS: readonly StatusFilter[] = [
  'all',
  'available',
  'disabled',
  'unconfigured',
  'error',
  'unavailable',
];

function displayEnum(value: string): string {
  return value
    .split('-')
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(' ');
}

function statusTone(status: PiAgentStatus): string {
  switch (status) {
    case 'available':
      return 'text-[var(--status-success)] bg-[color-mix(in_srgb,var(--status-success)_10%,transparent)]';
    case 'error':
    case 'unavailable':
      return 'text-[var(--status-error)] bg-[color-mix(in_srgb,var(--status-error)_10%,transparent)]';
    case 'unconfigured':
      return 'text-[var(--status-warning)] bg-[color-mix(in_srgb,var(--status-warning)_10%,transparent)]';
    case 'disabled':
    default:
      return 'text-muted-foreground bg-interactive-hover';
  }
}

function invocationExample(agent: PiAgentDescriptor): string | null {
  if (!agent.invocation) return null;
  const separator = agent.invocation.taskSeparator === 'double-dash' ? ' -- ' : ' ';
  return `/${agent.invocation.command} ${agent.name}${separator}<task>`;
}

const AgentBadge: React.FC<{
  children: React.ReactNode;
  className?: string;
}> = ({ children, className }) => (
  <span className={cn(
    'inline-flex min-w-0 items-center rounded-md px-1.5 py-0.5 typography-micro',
    className,
  )}>
    {children}
  </span>
);

const DetailRow: React.FC<{
  label: React.ReactNode;
  value: React.ReactNode;
}> = ({ label, value }) => (
  <div className="grid grid-cols-[7.5rem_minmax(0,1fr)] gap-3 py-2">
    <dt className={cn(SETTINGS_HELPER_CLASS, 'min-w-0')}>{label}</dt>
    <dd className="min-w-0 break-words typography-meta text-foreground">{value}</dd>
  </div>
);

const ProviderCard: React.FC<{
  agentCount: number;
  active: boolean;
  onSelect: () => void;
  provider: PiAgentProviderDescriptor;
}> = ({ active, agentCount, onSelect, provider }) => (
  <button
    type="button"
    aria-pressed={active}
    onClick={onSelect}
    className={cn(
      'min-w-0 rounded-xl border p-3 text-left transition-colors',
      active
        ? 'border-[var(--primary-base)] bg-[color-mix(in_srgb,var(--primary-base)_8%,transparent)]'
        : 'border-border/60 bg-[var(--surface-elevated)] hover:bg-interactive-hover',
    )}
  >
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <div className="truncate typography-ui-label font-medium text-foreground">{provider.label}</div>
        <div className="mt-0.5 line-clamp-2 typography-micro text-muted-foreground">
          {provider.description}
        </div>
      </div>
      <span
        className={cn(
          'mt-1 size-2 shrink-0 rounded-full',
          provider.available ? 'bg-[var(--status-success)]' : 'bg-[var(--status-error)]',
        )}
        aria-hidden
      />
    </div>
    <div className="mt-2 flex items-center justify-between gap-2 typography-micro text-muted-foreground">
      <span className="truncate font-mono" title={provider.source ?? provider.id}>
        {provider.source ?? provider.id}
      </span>
      <span className="shrink-0 tabular-nums">{agentCount}</span>
    </div>
  </button>
);

const AgentListItem: React.FC<{
  agent: PiAgentDescriptor;
  onSelect: () => void;
  providerLabel: string;
  selected: boolean;
}> = ({ agent, onSelect, providerLabel, selected }) => (
  <button
    type="button"
    aria-pressed={selected}
    onClick={onSelect}
    className={cn(
      'w-full rounded-lg border px-3 py-2.5 text-left transition-colors',
      selected
        ? 'border-[var(--primary-base)] bg-[color-mix(in_srgb,var(--primary-base)_8%,transparent)]'
        : 'border-border/60 bg-[var(--surface-elevated)] hover:bg-interactive-hover',
    )}
  >
    <div className="flex min-w-0 items-start justify-between gap-2">
      <div className="min-w-0">
        <div className="truncate typography-ui-label font-medium text-foreground">{agent.name}</div>
        <div className="mt-0.5 truncate typography-micro text-muted-foreground">
          {providerLabel} / {displayEnum(agent.kind)}
        </div>
      </div>
      <AgentBadge className={cn('shrink-0', statusTone(agent.status))}>
        {displayEnum(agent.status)}
      </AgentBadge>
    </div>
    {agent.description ? (
      <p className="mt-2 line-clamp-2 typography-micro text-muted-foreground">
        {agent.description}
      </p>
    ) : null}
  </button>
);

export const AgentsPage: React.FC = () => {
  const { t } = useI18n();
  const setSettingsPage = useUIStore((state) => state.setSettingsPage);
  const currentDirectory = useDirectoryStore((state) => state.currentDirectory);
  const activeSessionId = usePiSessionStore((state) => {
    const sessionId = state.currentSessionId;
    return sessionId && state.records[sessionId]?.open ? sessionId : null;
  });
  const runtimeTarget = React.useMemo<RuntimeContextTarget>(() => (
    activeSessionId ? { sessionId: activeSessionId } : { cwd: currentDirectory }
  ), [activeSessionId, currentDirectory]);
  const targetKey = activeSessionId ? `session:${activeSessionId}` : `cwd:${currentDirectory}`;
  const targetKeyRef = React.useRef(targetKey);
  targetKeyRef.current = targetKey;

  const [catalog, setCatalog] = React.useState<PiAgentCatalogSnapshot>(EMPTY_CATALOG);
  const [loaded, setLoaded] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [query, setQuery] = React.useState('');
  const [providerFilter, setProviderFilter] = React.useState<ProviderFilter>('all');
  const [statusFilter, setStatusFilter] = React.useState<StatusFilter>('all');
  const [selectedAgentId, setSelectedAgentId] = React.useState<string | null>(null);
  const [actionState, setActionState] = React.useState<AgentActionState | null>(null);
  const [definitionMode, setDefinitionMode] = React.useState<PiSubagentsDefinitionMode | null>(null);
  const [dialogAction, setDialogAction] = React.useState<PiAgentActionDescriptor | null>(null);
  const [dialogAgent, setDialogAgent] = React.useState<PiAgentDescriptor | null>(null);
  const refreshGenerationRef = React.useRef(0);

  const refresh = React.useCallback(async () => {
    const generation = ++refreshGenerationRef.current;
    const actionTargetKey = targetKey;
    const runtimeKey = getRuntimeKey();
    setLoading(true);
    setLoadError(null);
    try {
      const next = await listPiAgentProviders(runtimeTarget);
      if (
        generation !== refreshGenerationRef.current
        || actionTargetKey !== targetKeyRef.current
        || runtimeKey !== getRuntimeKey()
      ) return;
      setCatalog(next);
      setLoaded(true);
      setSelectedAgentId((current) => (
        current && next.agents.some((agent) => agent.id === current)
          ? current
          : (next.agents[0]?.id ?? null)
      ));
      setProviderFilter((current) => (
        current === 'all' || next.providers.some((provider) => provider.id === current)
          ? current
          : 'all'
      ));
    } catch (error) {
      if (
        generation !== refreshGenerationRef.current
        || actionTargetKey !== targetKeyRef.current
        || runtimeKey !== getRuntimeKey()
      ) return;
      setLoadError(error instanceof Error ? error.message : String(error));
      setLoaded(false);
    } finally {
      if (
        generation === refreshGenerationRef.current
        && actionTargetKey === targetKeyRef.current
        && runtimeKey === getRuntimeKey()
      ) setLoading(false);
    }
  }, [runtimeTarget, targetKey]);

  React.useEffect(() => {
    setCatalog(EMPTY_CATALOG);
    setLoaded(false);
    setActionState(null);
    setDefinitionMode(null);
    setDialogAction(null);
    setDialogAgent(null);
    void refresh();
  }, [refresh]);

  const providerById = React.useMemo(() => new Map(
    catalog.providers.map((provider) => [provider.id, provider]),
  ), [catalog.providers]);

  const filteredAgents = React.useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return catalog.agents.filter((agent) => {
      if (providerFilter !== 'all' && agent.providerId !== providerFilter) return false;
      if (statusFilter !== 'all' && agent.status !== statusFilter) return false;
      if (!normalizedQuery) return true;
      const provider = providerById.get(agent.providerId);
      const haystack = [
        agent.name,
        agent.id,
        agent.description,
        agent.kind,
        agent.status,
        agent.model,
        agent.thinking,
        agent.source.scope,
        agent.source.path,
        agent.source.packageName,
        provider?.label,
        provider?.id,
        provider?.source,
        ...(agent.aliases ?? []),
        ...(agent.fallbackModels ?? []),
      ].filter(Boolean).join(' ').toLocaleLowerCase();
      return haystack.includes(normalizedQuery);
    });
  }, [catalog.agents, providerById, providerFilter, query, statusFilter]);

  const selectedAgent = React.useMemo(() => (
    filteredAgents.find((agent) => agent.id === selectedAgentId)
      ?? filteredAgents[0]
      ?? null
  ), [filteredAgents, selectedAgentId]);
  const selectedInvocation = selectedAgent ? invocationExample(selectedAgent) : null;

  const runAction = React.useCallback(async (input: {
    action: string;
    agentId?: string;
    payload?: JsonValue;
    providerId: string;
    refreshCatalog?: boolean;
  }): Promise<boolean> => {
    const actionTargetKey = targetKey;
    const runtimeKey = getRuntimeKey();
    setActionState({
      action: input.action,
      ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
      loading: true,
      providerId: input.providerId,
    });
    try {
      const result = await runPiAgentProviderAction(
        runtimeTarget,
        input.providerId,
        input.action,
        input.agentId,
        input.payload,
      );
      if (actionTargetKey !== targetKeyRef.current || runtimeKey !== getRuntimeKey()) return false;
      if (result.success && input.refreshCatalog) await refresh();
      if (actionTargetKey !== targetKeyRef.current || runtimeKey !== getRuntimeKey()) return false;
      setActionState({
        action: input.action,
        ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
        loading: false,
        message: result.message,
        providerId: input.providerId,
        success: result.success,
      });
      return result.success;
    } catch (error) {
      if (actionTargetKey !== targetKeyRef.current || runtimeKey !== getRuntimeKey()) return false;
      setActionState({
        action: input.action,
        ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
        loading: false,
        message: error instanceof Error ? error.message : String(error),
        providerId: input.providerId,
        success: false,
      });
      return false;
    }
  }, [refresh, runtimeTarget, targetKey]);

  const openConfiguration = React.useCallback((configuration: PiAgentDescriptor['configuration']) => {
    if (!configuration) return;
    requestPluginSettingsTarget(
      configuration.pluginId,
      configuration.section,
    );
    setSettingsPage('plugin-settings');
  }, [setSettingsPage]);

  const selectedProvider = selectedAgent
    ? providerById.get(selectedAgent.providerId)
    : undefined;
  const activeProvider = providerFilter === 'all'
    ? (selectedProvider ?? catalog.providers[0])
    : providerById.get(providerFilter);
  const providerActionState = actionState
    && actionState.agentId === undefined
    && actionState.providerId === activeProvider?.id
    ? actionState
    : null;
  const selectedAgentActionState = selectedAgent
    && actionState?.agentId === selectedAgent.id
    ? actionState
    : null;
  const definitionAgent = definitionMode === 'update-agent' || definitionMode === 'update-workflow'
    ? selectedAgent ?? undefined
    : undefined;

  const displayActionLabel = React.useCallback((
    providerId: string,
    action: PiAgentActionDescriptor,
    agentKind?: PiAgentDescriptor['kind'],
  ): string => {
    if (providerId !== 'pi-subagents') return action.label;
    switch (action.id) {
      case 'create-agent':
        return t('settings.piarium.agents.definition.createAgent');
      case 'create-workflow':
        return t('settings.piarium.agents.definition.createWorkflow');
      case 'models':
        return t('settings.piarium.agents.actions.models');
      case 'inspect':
        return t('settings.piarium.agents.actions.inspect');
      case 'update':
        return t(agentKind === 'workflow'
          ? 'settings.piarium.agents.definition.editWorkflow'
          : 'settings.piarium.agents.definition.editAgent');
      case 'delete':
        return t('settings.common.actions.delete');
      case 'eject':
        return t('settings.piarium.agents.actions.copyToScope');
      case 'disable':
        return t('settings.piarium.agents.actions.disable');
      case 'enable':
        return t('settings.piarium.agents.actions.enable');
      case 'reset':
        return t('settings.common.actions.reset');
      default:
        return action.label;
    }
  }, [t]);

  const submitDefinition = React.useCallback(async (
    scope: 'user' | 'project',
    config: Record<string, JsonValue>,
  ): Promise<boolean> => {
    if (!definitionMode) return false;
    const creating = definitionMode === 'create-agent' || definitionMode === 'create-workflow';
    const action = creating ? definitionMode : 'update';
    const agent = creating ? undefined : definitionAgent;
    return runAction({
      action,
      ...(agent === undefined ? {} : { agentId: agent.id }),
      payload: { config, scope },
      providerId: agent?.providerId ?? 'pi-subagents',
      refreshCatalog: true,
    });
  }, [definitionAgent, definitionMode, runAction]);

  const requestAgentAction = React.useCallback((
    agent: PiAgentDescriptor,
    action: PiAgentActionDescriptor,
  ) => {
    if (agent.providerId === 'pi-subagents' && action.id === 'update') {
      setDefinitionMode(agent.kind === 'workflow' ? 'update-workflow' : 'update-agent');
      return;
    }
    const inferredScope = agent.source.scope === 'user' || agent.source.scope === 'project'
      ? agent.source.scope
      : undefined;
    if (action.destructive || (action.requiresScope && inferredScope === undefined)) {
      setDialogAgent(agent);
      setDialogAction({ ...action, label: displayActionLabel(agent.providerId, action, agent.kind) });
      return;
    }
    void runAction({
      action: action.id,
      agentId: agent.id,
      ...(action.requiresScope && inferredScope
        ? { payload: { scope: inferredScope } }
        : {}),
      providerId: agent.providerId,
      refreshCatalog: action.id !== 'inspect',
    });
  }, [displayActionLabel, runAction]);

  const submitDialogAction = React.useCallback(async (scope?: 'user' | 'project') => {
    if (!dialogAction || !dialogAgent) return false;
    return runAction({
      action: dialogAction.id,
      agentId: dialogAgent.id,
      ...(scope === undefined ? {} : { payload: { scope } }),
      providerId: dialogAgent.providerId,
      refreshCatalog: true,
    });
  }, [dialogAction, dialogAgent, runAction]);

  return (
    <>
      <SettingsPageLayout
        title={t('settings.page.agents.title')}
        description={t('settings.piarium.agents.description')}
        headerEnd={(
          <div className="flex items-center gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setSettingsPage('fleet')}>
              <Icon name="pulse" className="size-4" />
              {t('settings.page.fleet.title')}
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => void refresh()} disabled={loading}>
              <Icon name="refresh" className={cn('size-4', loading && 'animate-spin')} />
              {t('settings.piarium.agents.actions.refresh')}
            </Button>
          </div>
        )}
      >
      <SettingsSection
        divider={false}
        title={t('settings.piarium.agents.providers.title')}
        description={t('settings.piarium.agents.providers.description')}
        settingsItem="agents.providers"
      >
        {catalog.providers.length > 0 ? (
          <div className="grid grid-cols-1 gap-2 @2xl:grid-cols-2">
            {catalog.providers.map((provider) => (
              <ProviderCard
                key={provider.id}
                provider={provider}
                active={providerFilter === provider.id
                  || (providerFilter === 'all' && activeProvider?.id === provider.id)}
                agentCount={catalog.agents.filter((agent) => agent.providerId === provider.id).length}
                onSelect={() => setProviderFilter((current) => (
                  current === provider.id ? 'all' : provider.id
                ))}
              />
            ))}
          </div>
        ) : loaded ? (
          <div className="rounded-xl border border-dashed border-border/70 p-5 text-center">
            <Icon name="robot-2" className="mx-auto size-6 text-muted-foreground" />
            <div className="mt-2 typography-ui-label font-medium text-foreground">
              {t('settings.piarium.agents.empty.title')}
            </div>
            <p className="mx-auto mt-1 max-w-lg typography-meta text-muted-foreground">
              {t('settings.piarium.agents.empty.description')}
            </p>
            <Button type="button" variant="outline" size="sm" className="mt-4" onClick={() => setSettingsPage('plugins')}>
              <Icon name="plug-2" className="size-4" />
              {t('settings.piarium.agents.actions.packages')}
            </Button>
          </div>
        ) : null}
        {activeProvider ? (
          <div className="mt-4 rounded-xl border border-border/60 bg-background/50 p-3">
            <div className="flex flex-col gap-3 @xl:flex-row @xl:items-start @xl:justify-between">
              <div className="min-w-0">
                <div className="typography-ui-label font-medium text-foreground">
                  {activeProvider.label}
                </div>
                <p className="mt-0.5 typography-micro text-muted-foreground">
                  {t('settings.piarium.agents.providerActions.description')}
                </p>
              </div>
              {activeProvider.configuration ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  onClick={() => openConfiguration(activeProvider.configuration)}
                >
                  <Icon name="settings-3" className="size-3.5" />
                  {t('settings.piarium.agents.actions.configure')}
                </Button>
              ) : null}
            </div>
            {activeProvider.actions.length > 0 ? (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                {activeProvider.actions.map((action) => {
                  const loadingAction = providerActionState?.loading === true
                    && providerActionState.action === action.id;
                  const createAction = activeProvider.id === 'pi-subagents'
                    && (action.id === 'create-agent' || action.id === 'create-workflow');
                  return (
                    <Button
                      key={action.id}
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={!activeProvider.available || actionState?.loading === true}
                      onClick={() => {
                        if (createAction) {
                          setDefinitionMode(action.id as 'create-agent' | 'create-workflow');
                          return;
                        }
                        void runAction({ action: action.id, providerId: activeProvider.id });
                      }}
                    >
                      {loadingAction ? <Icon name="loader-4" className="size-4 animate-spin" /> : null}
                      {displayActionLabel(activeProvider.id, action)}
                    </Button>
                  );
                })}
              </div>
            ) : (
              <p className="mt-3 typography-micro text-muted-foreground">
                {t('settings.piarium.agents.providerActions.none')}
              </p>
            )}
            {providerActionState?.message ? (
              <pre className={cn(
                'mt-3 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg border p-3 typography-micro',
                providerActionState.success
                  ? 'border-border/60 bg-background/70 text-foreground'
                  : 'border-[color-mix(in_srgb,var(--status-error)_24%,transparent)] bg-[color-mix(in_srgb,var(--status-error)_7%,transparent)] text-[var(--status-error)]',
              )}>
                {providerActionState.message}
              </pre>
            ) : null}
          </div>
        ) : null}
        {loadError ? (
          <div className="mt-3 rounded-lg border border-[color-mix(in_srgb,var(--status-error)_24%,transparent)] bg-[color-mix(in_srgb,var(--status-error)_7%,transparent)] px-3 py-2 typography-meta text-[var(--status-error)]">
            {loadError}
          </div>
        ) : null}
      </SettingsSection>

      {catalog.diagnostics.length > 0 ? (
        <SettingsSection
          title={t('settings.piarium.agents.diagnostics.title')}
          settingsItem="agents.diagnostics"
        >
          <div className="space-y-2">
            {catalog.diagnostics.map((diagnostic, index) => (
              <div
                key={`${diagnostic.providerId}:${diagnostic.path ?? ''}:${index}`}
                className={cn(
                  'rounded-lg border px-3 py-2 typography-meta',
                  diagnostic.severity === 'error'
                    ? 'border-[color-mix(in_srgb,var(--status-error)_24%,transparent)] text-[var(--status-error)]'
                    : 'border-[color-mix(in_srgb,var(--status-warning)_24%,transparent)] text-[var(--status-warning)]',
                )}
              >
                <div className="font-medium">{providerById.get(diagnostic.providerId)?.label ?? diagnostic.providerId}</div>
                <div className="mt-0.5 break-words">{diagnostic.message}</div>
                {diagnostic.path ? <div className="mt-1 break-all font-mono typography-micro">{diagnostic.path}</div> : null}
              </div>
            ))}
          </div>
        </SettingsSection>
      ) : null}

      <SettingsSection
        title={t('settings.piarium.agents.catalog.title')}
        description={t('settings.piarium.agents.catalog.description', { count: catalog.agents.length })}
        settingsItem="agents.catalog"
      >
        <div className="space-y-3">
          <div className="relative">
            <Icon name="search" className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('settings.piarium.agents.search.placeholder')}
              aria-label={t('settings.piarium.agents.search.placeholder')}
              className="pl-9"
            />
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <Button
              type="button"
              variant="chip"
              size="xs"
              aria-pressed={providerFilter === 'all'}
              onClick={() => setProviderFilter('all')}
            >
              {t('settings.piarium.agents.filters.allProviders')}
            </Button>
            {catalog.providers.map((provider) => (
              <Button
                key={provider.id}
                type="button"
                variant="chip"
                size="xs"
                aria-pressed={providerFilter === provider.id}
                onClick={() => setProviderFilter(provider.id)}
              >
                {provider.label}
              </Button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {STATUS_FILTERS.map((status) => (
              <Button
                key={status}
                type="button"
                variant="chip"
                size="xs"
                aria-pressed={statusFilter === status}
                onClick={() => setStatusFilter(status)}
              >
                {status === 'all'
                  ? t('settings.piarium.agents.filters.allStatuses')
                  : displayEnum(status)}
              </Button>
            ))}
          </div>
        </div>

        {filteredAgents.length > 0 ? (
          <div className="mt-4 grid grid-cols-1 gap-4 @3xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
            <div className="space-y-2">
              {filteredAgents.map((agent) => (
                <AgentListItem
                  key={agent.id}
                  agent={agent}
                  providerLabel={providerById.get(agent.providerId)?.label ?? agent.providerId}
                  selected={selectedAgent?.id === agent.id}
                  onSelect={() => {
                    setSelectedAgentId(agent.id);
                    setActionState(null);
                  }}
                />
              ))}
            </div>

            {selectedAgent ? (
              <div className="self-start rounded-xl border border-border/60 bg-[var(--surface-elevated)] p-4">
                <div className="flex min-w-0 items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="truncate typography-settings-section-title text-foreground">
                      {selectedAgent.name}
                    </h3>
                    <div className="mt-1 break-all font-mono typography-micro text-muted-foreground">
                      {selectedAgent.providerId}/{selectedAgent.name}
                    </div>
                  </div>
                  <AgentBadge className={cn('shrink-0', statusTone(selectedAgent.status))}>
                    {displayEnum(selectedAgent.status)}
                  </AgentBadge>
                </div>

                {selectedAgent.description ? (
                  <p className="mt-3 typography-meta text-muted-foreground">
                    {selectedAgent.description}
                  </p>
                ) : null}

                <dl className="mt-3 divide-y divide-border/50">
                  <DetailRow label={t('settings.piarium.agents.detail.provider')} value={selectedProvider?.label ?? selectedAgent.providerId} />
                  <DetailRow label={t('settings.piarium.agents.detail.kind')} value={displayEnum(selectedAgent.kind)} />
                  <DetailRow label={t('settings.piarium.agents.detail.source')} value={displayEnum(selectedAgent.source.scope)} />
                  {selectedAgent.source.path ? (
                    <DetailRow label={t('settings.piarium.agents.detail.path')} value={<span className="font-mono typography-micro">{selectedAgent.source.path}</span>} />
                  ) : null}
                  {selectedAgent.source.packageName ? (
                    <DetailRow label={t('settings.piarium.agents.detail.package')} value={selectedAgent.source.packageName} />
                  ) : null}
                  {selectedInvocation ? (
                    <DetailRow
                      label={t('settings.piarium.agents.detail.invocation')}
                      value={<code className="font-mono typography-micro">{selectedInvocation}</code>}
                    />
                  ) : null}
                  <DetailRow
                    label={t('settings.piarium.agents.detail.model')}
                    value={selectedAgent.model ?? t('settings.piarium.agents.detail.inherited')}
                  />
                  {selectedAgent.thinking ? (
                    <DetailRow label={t('settings.piarium.agents.detail.thinking')} value={selectedAgent.thinking} />
                  ) : null}
                  {selectedAgent.fallbackModels?.length ? (
                    <DetailRow label={t('settings.piarium.agents.detail.fallbacks')} value={selectedAgent.fallbackModels.join(' → ')} />
                  ) : null}
                  {selectedAgent.aliases?.length ? (
                    <DetailRow label={t('settings.piarium.agents.detail.aliases')} value={selectedAgent.aliases.join(', ')} />
                  ) : null}
                </dl>

                {selectedAgent.configuration ? (
                  <div className="mt-4 rounded-lg border border-border/60 bg-background/50 p-3">
                    <div className={SETTINGS_FIELD_LABEL_CLASS}>
                      {t('settings.piarium.agents.configuration.title')}
                    </div>
                    <p className="mt-1 typography-meta text-muted-foreground">
                      {t('settings.piarium.agents.configuration.description', {
                        provider: selectedProvider?.label ?? selectedAgent.configuration.pluginId,
                      })}
                    </p>
                    <Button type="button" variant="outline" size="sm" className="mt-3" onClick={() => openConfiguration(selectedAgent.configuration)}>
                      <Icon name="settings-3" className="size-4" />
                      {t('settings.piarium.agents.actions.configure')}
                    </Button>
                  </div>
                ) : null}

                <div className="mt-4 flex flex-wrap items-center gap-2">
                  {selectedAgent.actions.map((action) => {
                    const actionLoading = selectedAgentActionState?.loading === true
                      && selectedAgentActionState.action === action.id;
                    return (
                      <Button
                        key={action.id}
                        type="button"
                        variant={action.destructive ? 'destructive' : 'outline'}
                        size="sm"
                        disabled={actionState?.loading === true}
                        onClick={() => requestAgentAction(selectedAgent, action)}
                      >
                        {actionLoading ? (
                          <Icon name="loader-4" className="size-4 animate-spin" />
                        ) : action.id === 'inspect' ? (
                          <Icon name="information" className="size-4" />
                        ) : null}
                        {displayActionLabel(selectedAgent.providerId, action, selectedAgent.kind)}
                      </Button>
                    );
                  })}
                </div>

                {selectedAgentActionState?.message ? (
                  <pre className={cn(
                    'mt-3 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg border p-3 typography-micro',
                    selectedAgentActionState.success
                      ? 'border-border/60 bg-background/70 text-foreground'
                      : 'border-[color-mix(in_srgb,var(--status-error)_24%,transparent)] bg-[color-mix(in_srgb,var(--status-error)_7%,transparent)] text-[var(--status-error)]',
                  )}>
                    {selectedAgentActionState.message}
                  </pre>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : loaded ? (
          <div className="mt-5 rounded-xl border border-dashed border-border/70 p-5 text-center typography-meta text-muted-foreground">
            {t('settings.piarium.agents.catalog.noMatches')}
          </div>
        ) : (
          <div className="mt-5 flex items-center justify-center py-8 text-muted-foreground">
            <Icon name="loader-4" className="size-5 animate-spin" />
          </div>
        )}
      </SettingsSection>
      </SettingsPageLayout>
      <PiSubagentsDefinitionDialog
        open={definitionMode !== null}
        mode={definitionMode}
        agent={definitionAgent}
        projectTrusted={catalog.projectTrusted}
        submitting={actionState?.loading === true}
        onOpenChange={(open) => {
          if (!open) setDefinitionMode(null);
        }}
        onSubmit={submitDefinition}
      />
      <AgentProviderActionDialog
        open={dialogAction !== null && dialogAgent !== null}
        action={dialogAction}
        agent={dialogAgent}
        projectTrusted={catalog.projectTrusted}
        submitting={actionState?.loading === true
          && actionState.agentId === dialogAgent?.id
          && actionState.action === dialogAction?.id}
        onOpenChange={(open) => {
          if (!open) {
            setDialogAction(null);
            setDialogAgent(null);
          }
        }}
        onSubmit={submitDialogAction}
      />
    </>
  );
};
