import React from 'react';
import type { PiAgentStatus, RuntimeContextTarget } from '@piarium/protocol';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { SettingsSidebarLayout } from '@/components/sections/shared/SettingsSidebarLayout';
import { SettingsSidebarItem } from '@/components/sections/shared/SettingsSidebarItem';
import { SETTINGS_PANEL_TITLE_CLASS } from '@/components/sections/shared/SettingsSection';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { usePiSessionStore } from '@/stores/usePiSessionStore';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { cn } from '@/lib/utils';
import { AGENT_KIND_LABEL_KEYS, filterAgentsCatalog } from './agents-catalog-model';
import {
  refreshAgentsCatalog,
  requestAgentsCatalogDefinition,
  selectAgentsCatalogAgent,
  setAgentsCatalogProviderFilter,
  setAgentsCatalogQuery,
  setAgentsCatalogStatusFilter,
  useAgentsCatalogState,
  type AgentStatusFilter,
} from './agents-catalog-store';

const STATUS_FILTERS: readonly AgentStatusFilter[] = [
  'all', 'available', 'disabled', 'unconfigured', 'error', 'unavailable',
];

const STATUS_KEYS: Partial<Record<PiAgentStatus, I18nKey>> = {
  available: 'settings.piarium.pluginSettings.subagents.status.available',
  disabled: 'settings.piarium.pluginSettings.subagents.status.disabled',
  error: 'settings.piarium.pluginSettings.subagents.status.error',
  unavailable: 'settings.piarium.pluginSettings.subagents.status.unavailable',
  unconfigured: 'settings.piarium.pluginSettings.subagents.status.unconfigured',
};

interface AgentsSidebarProps {
  onItemSelect?: () => void;
}

export const AgentsSidebar: React.FC<AgentsSidebarProps> = ({ onItemSelect }) => {
  const { t } = useI18n();
  const currentDirectory = useDirectoryStore((value) => value.currentDirectory);
  const activeSessionId = usePiSessionStore((value) => {
    const sessionId = value.currentSessionId;
    return sessionId && value.records[sessionId]?.open ? sessionId : null;
  });
  const runtimeTarget = React.useMemo<RuntimeContextTarget>(() => (
    activeSessionId ? { sessionId: activeSessionId } : { cwd: currentDirectory }
  ), [activeSessionId, currentDirectory]);
  const runtimeKey = getRuntimeKey();
  const targetKey = `${runtimeKey}:${activeSessionId ? `session:${activeSessionId}` : `cwd:${currentDirectory}`}`;
  const state = useAgentsCatalogState();

  React.useEffect(() => {
    void refreshAgentsCatalog(runtimeTarget, targetKey);
  }, [runtimeTarget, targetKey]);

  const filtered = React.useMemo(() => filterAgentsCatalog(
    state.catalog,
    state.query,
    state.providerFilter,
    state.statusFilter,
  ), [state.catalog, state.providerFilter, state.query, state.statusFilter]);
  const selectedId = filtered.some((agent) => agent.id === state.selectedAgentId)
    ? state.selectedAgentId
    : (filtered[0]?.id ?? null);
  const filterCount = Number(state.providerFilter !== 'all') + Number(state.statusFilter !== 'all');
  const definitionActions = state.catalog.providers
    .filter((provider) => provider.id === 'pi-subagents' && provider.available)
    .flatMap((provider) => provider.actions)
    .filter((action) => action.id === 'create-agent' || action.id === 'create-workflow');

  return (
    <SettingsSidebarLayout
      variant="background"
      header={(
        <div className="border-b border-border px-3 pb-3 pt-4">
          <div className="mb-3 flex items-center justify-between gap-2">
            <h2 className={SETTINGS_PANEL_TITLE_CLASS}>{t('settings.page.agents.title')}</h2>
            <div className="flex items-center gap-1">
              <span className="typography-meta tabular-nums text-muted-foreground">{state.catalog.agents.length}</span>
              {definitionActions.length > 0 ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button type="button" variant="ghost" size="icon" className="size-7">
                      <Icon name="add" className="size-4" />
                      <span className="sr-only">{t('settings.piarium.agents.definition.createAgent')}</span>
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    {definitionActions.map((action) => (
                      <DropdownMenuItem
                        key={action.id}
                        onClick={() => {
                          requestAgentsCatalogDefinition(action.id as 'create-agent' | 'create-workflow');
                          onItemSelect?.();
                        }}
                      >
                        {action.id === 'create-agent'
                          ? t('settings.piarium.agents.definition.createAgent')
                          : t('settings.piarium.agents.definition.createWorkflow')}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : null}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <div className="relative min-w-0 flex-1">
              <Icon name="search" className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={state.query}
                onChange={(event) => setAgentsCatalogQuery(event.target.value)}
                placeholder={t('settings.piarium.agents.search.placeholder')}
                aria-label={t('settings.piarium.agents.search.placeholder')}
                className="h-8 pl-8"
              />
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button type="button" variant="outline" size="icon" className="relative size-8 shrink-0">
                  <Icon name="equalizer-2" className="size-4" />
                  {filterCount > 0 ? (
                    <span className="absolute -right-1 -top-1 flex size-4 items-center justify-center rounded-full bg-primary typography-micro text-primary-foreground">
                      {filterCount}
                    </span>
                  ) : null}
                  <span className="sr-only">{t('settings.piarium.agents.filters.allProviders')}</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-56">
                <DropdownMenuLabel>{t('settings.piarium.agents.detail.provider')}</DropdownMenuLabel>
                <DropdownMenuRadioGroup value={state.providerFilter} onValueChange={setAgentsCatalogProviderFilter}>
                  <DropdownMenuRadioItem value="all">{t('settings.piarium.agents.filters.allProviders')}</DropdownMenuRadioItem>
                  {state.catalog.providers.map((provider) => (
                    <DropdownMenuRadioItem key={provider.id} value={provider.id}>{provider.label}</DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
                <DropdownMenuSeparator />
                <DropdownMenuLabel>{t('settings.piarium.pluginSettings.subagents.definition.status')}</DropdownMenuLabel>
                <DropdownMenuRadioGroup value={state.statusFilter} onValueChange={(value) => setAgentsCatalogStatusFilter(value as AgentStatusFilter)}>
                  {STATUS_FILTERS.map((status) => (
                    <DropdownMenuRadioItem key={status} value={status}>
                      {status === 'all'
                        ? t('settings.piarium.agents.filters.allStatuses')
                        : t(STATUS_KEYS[status] ?? 'settings.piarium.pluginSettings.field.unsupportedValue')}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      )}
    >
      {filtered.length > 0 ? filtered.map((agent) => {
        const provider = state.catalog.providers.find((candidate) => candidate.id === agent.providerId);
        return (
          <SettingsSidebarItem
            key={agent.id}
            title={agent.name}
            metadata={`${provider?.label ?? agent.providerId} · ${t(AGENT_KIND_LABEL_KEYS[agent.kind] ?? 'settings.piarium.pluginSettings.field.unsupportedValue')}`}
            selected={agent.id === selectedId}
            onSelect={() => {
              selectAgentsCatalogAgent(agent.id);
              onItemSelect?.();
            }}
            icon={<span className={cn('size-2 shrink-0 rounded-full', agent.status === 'available' ? 'bg-[var(--status-success)]' : agent.status === 'error' || agent.status === 'unavailable' ? 'bg-[var(--status-error)]' : 'bg-muted-foreground/60')} />}
          />
        );
      }) : (
        <div className="px-3 py-10 text-center typography-meta text-muted-foreground">
          {state.loading
            ? <Icon name="loader-4" className="mx-auto size-5 animate-spin" />
            : state.error ?? (state.catalog.agents.length === 0
              ? t('settings.piarium.agents.empty.title')
              : t('settings.piarium.agents.catalog.noMatches'))}
        </div>
      )}
    </SettingsSidebarLayout>
  );
};
