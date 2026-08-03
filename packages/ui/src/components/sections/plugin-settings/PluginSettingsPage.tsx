import React from 'react';
import type {
  PackageDescriptor,
  PiAgentCatalogSnapshot,
  RuntimeContextTarget,
} from '@piarium/protocol';
import { usePiChatCatalog } from '@/components/chat/usePiChatCatalog';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { Button } from '@/components/ui/button';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import { SettingsSection } from '@/components/sections/shared/SettingsSection';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { usePiSessionStore } from '@/stores/usePiSessionStore';
import { useUIStore } from '@/stores/useUIStore';
import { findPiPackage, listPiPackages } from '@/lib/pi-runtime/packages';
import { listPiAgentProviders } from '@/lib/pi-runtime/agent-providers';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import {
  consumePluginSettingsTarget,
  type PluginSettingsIntegrationId,
} from '@/lib/settings/plugin-settings-navigation';
import { AdvancedPluginConfigEditor } from './AdvancedPluginConfigEditor';
import { MagicContextSettings } from './MagicContextSettings';
import { SubagentsSettings } from './SubagentsSettings';
import { WebAccessSettings } from './WebAccessSettings';
import { WorkspaceHistorySettings } from './WorkspaceHistorySettings';
import { WtfSettings } from './WtfSettings';
import {
  MCP_ADAPTER_STATUS_CHANNEL,
  parseMcpAdapterStatus,
} from '../mcp/mcpAdapterStatus';
import {
  pluginRuntimeStatus,
  type PluginRuntimeStatus,
} from './plugin-runtime-status';

interface PluginIntegration {
  descriptionKey: I18nKey;
  icon: IconName;
  id: PluginSettingsIntegrationId;
  name: string;
  packageName: string;
}

const PLUGIN_INTEGRATIONS: readonly PluginIntegration[] = [
  {
    descriptionKey: 'settings.piarium.plugins.package.subagents',
    icon: 'robot-2',
    id: 'subagents',
    name: 'pi-subagents',
    packageName: 'pi-subagents',
  },
  {
    descriptionKey: 'settings.piarium.plugins.package.magicContext',
    icon: 'brain',
    id: 'magic-context',
    name: 'Magic Context',
    packageName: '@cortexkit/pi-magic-context',
  },
  {
    descriptionKey: 'settings.piarium.plugins.package.webAccess',
    icon: 'global',
    id: 'web-access',
    name: 'pi-web-access',
    packageName: 'pi-web-access',
  },
  {
    descriptionKey: 'settings.piarium.plugins.package.workspaceHistory',
    icon: 'history',
    id: 'workspace-history',
    name: 'pi-workspace-history',
    packageName: 'pi-workspace-history',
  },
  {
    descriptionKey: 'settings.piarium.plugins.package.wtf',
    icon: 'arrow-go-back',
    id: 'wtf',
    name: 'pi-wtf',
    packageName: 'pi-wtf',
  },
  {
    descriptionKey: 'settings.piarium.plugins.package.mcp',
    icon: 'server',
    id: 'mcp',
    name: 'pi-mcp-adapter',
    packageName: 'pi-mcp-adapter',
  },
] as const;

type PluginInstallStatus = 'checking' | 'configured-missing' | 'error' | 'installed' | 'not-configured';

const statusClassName = (status: PluginRuntimeStatus | PluginInstallStatus): string => {
  if (status === 'available' || status === 'installed') {
    return 'border-[var(--status-success)]/30 text-[var(--status-success)]';
  }
  if (status === 'unavailable' || status === 'configured-missing') {
    return 'border-[var(--status-warning)]/30 text-[var(--status-warning)]';
  }
  if (status === 'error') {
    return 'border-[var(--status-error)]/30 text-[var(--status-error)]';
  }
  return 'border-border/60 text-muted-foreground';
};

const IntegrationStatus: React.FC<{
  installStatus: PluginInstallStatus;
  runtimeStatus: PluginRuntimeStatus;
}> = ({ installStatus, runtimeStatus }) => {
  const { t } = useI18n();
  return (
    <div className="mt-auto flex flex-wrap gap-1.5 pt-3">
      <span className={cn(
        'rounded-full border px-2 py-0.5 typography-micro',
        statusClassName(installStatus),
      )}>
        {t(`settings.piarium.pluginSettings.status.install.${installStatus}`)}
      </span>
      <span className={cn(
        'rounded-full border px-2 py-0.5 typography-micro',
        statusClassName(runtimeStatus),
      )}>
        {t(`settings.piarium.pluginSettings.status.runtime.${runtimeStatus}`)}
      </span>
    </div>
  );
};

export const PluginSettingsPage: React.FC = () => {
  const { t } = useI18n();
  const currentDirectory = useDirectoryStore((state) => state.currentDirectory);
  const activeSessionId = usePiSessionStore((state) => {
    const sessionId = state.currentSessionId;
    return sessionId && state.records[sessionId]?.open ? sessionId : null;
  });
  const sessionRecord = usePiSessionStore((state) => (
    activeSessionId ? state.records[activeSessionId] : undefined
  ));
  const refreshRecoveryStatus = usePiSessionStore((state) => state.refreshRecoveryStatus);
  const setSettingsPage = useUIStore((state) => state.setSettingsPage);
  const runtimeTarget = React.useMemo<RuntimeContextTarget>(() => (
    activeSessionId ? { sessionId: activeSessionId } : { cwd: currentDirectory }
  ), [activeSessionId, currentDirectory]);
  const targetKey = activeSessionId ? `session:${activeSessionId}` : `cwd:${currentDirectory}`;
  const targetKeyRef = React.useRef(targetKey);
  targetKeyRef.current = targetKey;
  const [navigationTarget] = React.useState(() => consumePluginSettingsTarget());
  const [selected, setSelected] = React.useState<PluginSettingsIntegrationId>(
    navigationTarget?.integrationId ?? 'subagents',
  );
  const [packages, setPackages] = React.useState<PackageDescriptor[]>([]);
  const [packagesLoaded, setPackagesLoaded] = React.useState(false);
  const [packageError, setPackageError] = React.useState<string | null>(null);
  const [agentCatalog, setAgentCatalog] = React.useState<PiAgentCatalogSnapshot | null>(null);
  const [agentProvidersChecked, setAgentProvidersChecked] = React.useState(false);
  const [agentProvidersFailed, setAgentProvidersFailed] = React.useState(false);
  const [recoveryChecked, setRecoveryChecked] = React.useState(false);
  const [recoveryFailed, setRecoveryFailed] = React.useState(false);
  const [statusRefreshing, setStatusRefreshing] = React.useState(false);
  const [advancedOpen, setAdvancedOpen] = React.useState(
    navigationTarget !== null && navigationTarget.integrationId === null,
  );
  const generationRef = React.useRef(0);
  const runtimeGenerationRef = React.useRef(0);
  const commandCatalog = usePiChatCatalog({
    sessionId: activeSessionId,
    refreshOnMount: activeSessionId !== null,
  });

  const loadPackages = React.useCallback(async () => {
    const generation = ++generationRef.current;
    const runtimeKey = getRuntimeKey();
    const actionTargetKey = targetKey;
    setPackageError(null);
    try {
      const next = await listPiPackages(runtimeTarget);
      if (
        generation !== generationRef.current
        || actionTargetKey !== targetKeyRef.current
        || runtimeKey !== getRuntimeKey()
      ) return;
      setPackages(next);
      setPackagesLoaded(true);
    } catch (error) {
      if (
        generation !== generationRef.current
        || actionTargetKey !== targetKeyRef.current
        || runtimeKey !== getRuntimeKey()
      ) return;
      setPackages([]);
      setPackagesLoaded(false);
      setPackageError(error instanceof Error ? error.message : String(error));
    }
  }, [runtimeTarget, targetKey]);

  React.useEffect(() => {
    setPackages([]);
    setPackagesLoaded(false);
    void loadPackages();
  }, [loadPackages]);

  const loadRuntimeSignals = React.useCallback(async () => {
    const generation = ++runtimeGenerationRef.current;
    setAgentCatalog(null);
    setAgentProvidersChecked(false);
    setAgentProvidersFailed(false);
    setRecoveryChecked(false);
    setRecoveryFailed(false);
    if (!activeSessionId) return;

    const target = { sessionId: activeSessionId } as const;
    await Promise.allSettled([
      listPiAgentProviders(target)
        .then((next) => {
          if (generation === runtimeGenerationRef.current) setAgentCatalog(next);
        })
        .catch(() => {
          if (generation === runtimeGenerationRef.current) setAgentProvidersFailed(true);
        })
        .finally(() => {
          if (generation === runtimeGenerationRef.current) setAgentProvidersChecked(true);
        }),
      refreshRecoveryStatus(activeSessionId)
        .catch(() => {
          if (generation === runtimeGenerationRef.current) setRecoveryFailed(true);
        })
        .finally(() => {
          if (generation === runtimeGenerationRef.current) setRecoveryChecked(true);
        }),
    ]);
  }, [activeSessionId, refreshRecoveryStatus]);

  React.useEffect(() => {
    void loadRuntimeSignals();
  }, [loadRuntimeSignals]);

  const commandNames = React.useMemo(
    () => new Set(commandCatalog.commands.map((command) => command.name)),
    [commandCatalog.commands],
  );
  const runtimeSignals = React.useMemo(() => ({
    agentProviders: agentCatalog?.providers ?? [],
    agentProvidersChecked,
    agentProvidersFailed,
    commandNames,
    commandsChecked: commandCatalog.loaded || commandCatalog.error !== null,
    commandsFailed: commandCatalog.error !== null,
    hasActiveSession: activeSessionId !== null,
    mcpStatusReported: parseMcpAdapterStatus(
      sessionRecord?.extensionStates[MCP_ADAPTER_STATUS_CHANNEL],
    ) !== null,
    recoveryChecked,
    recoveryFailed,
    recoveryProviders: sessionRecord?.recoveryStatus?.providers ?? [],
  }), [
    activeSessionId,
    agentCatalog?.providers,
    agentProvidersChecked,
    agentProvidersFailed,
    commandCatalog.error,
    commandCatalog.loaded,
    commandNames,
    recoveryChecked,
    recoveryFailed,
    sessionRecord?.extensionStates,
    sessionRecord?.recoveryStatus?.providers,
  ]);

  const selectedIntegration = PLUGIN_INTEGRATIONS.find((entry) => entry.id === selected)!;
  const selectedPackage = findPiPackage(packages, selectedIntegration.packageName);
  const selectedInstalled = selectedPackage?.installed === true;
  const refreshStatuses = React.useCallback(async (): Promise<void> => {
    setStatusRefreshing(true);
    try {
      await Promise.allSettled([
        loadPackages(),
        loadRuntimeSignals(),
        activeSessionId ? commandCatalog.refresh() : Promise.resolve(),
      ]);
    } finally {
      setStatusRefreshing(false);
    }
  }, [activeSessionId, commandCatalog, loadPackages, loadRuntimeSignals]);

  const renderSelectedSettings = () => {
    switch (selected) {
      case 'subagents':
        return <SubagentsSettings runtimeTarget={runtimeTarget} targetKey={targetKey} />;
      case 'magic-context':
        return (
          <MagicContextSettings
            initialPanel={navigationTarget?.section === 'agents' ? 'agents' : undefined}
            runtimeTarget={runtimeTarget}
            targetKey={targetKey}
          />
        );
      case 'web-access':
        return <WebAccessSettings runtimeTarget={runtimeTarget} targetKey={targetKey} />;
      case 'workspace-history':
        return <WorkspaceHistorySettings runtimeTarget={runtimeTarget} targetKey={targetKey} />;
      case 'wtf':
        return <WtfSettings runtimeTarget={runtimeTarget} targetKey={targetKey} />;
      case 'mcp':
        return (
          <div className="space-y-4 rounded-lg border border-border/60 px-4 py-4">
            <p className="typography-ui text-muted-foreground">
              {t('settings.piarium.pluginSettings.mcp.description')}
            </p>
            <Button type="button" variant="outline" size="sm" onClick={() => setSettingsPage('mcp')}>
              {t('settings.piarium.pluginSettings.mcp.open')}
            </Button>
          </div>
        );
      default:
        return null;
    }
  };

  return (
    <SettingsPageLayout
      title={t('settings.page.pluginSettings.title')}
      description={t('settings.piarium.pluginSettings.description')}
      className="max-w-6xl"
      showSaveStatus={false}
    >
      <SettingsSection
        settingsItem="plugin-settings.integrations"
        title={t('settings.piarium.pluginSettings.integrations.title')}
        description={t('settings.piarium.pluginSettings.integrations.description')}
        divider={false}
        headerAction={(
          <Button
            type="button"
            variant="ghost"
            size="xs"
            disabled={statusRefreshing}
            onClick={() => void refreshStatuses()}
          >
            <Icon name="refresh" className={statusRefreshing ? 'size-4 animate-spin' : 'size-4'} />
            {t('settings.piarium.recovery.actions.refresh')}
          </Button>
        )}
      >
        <div className="grid grid-cols-1 gap-2 @xl:grid-cols-2 @4xl:grid-cols-3">
          {PLUGIN_INTEGRATIONS.map((integration) => {
            const packageDescriptor = findPiPackage(packages, integration.packageName);
            const installStatus: PluginInstallStatus = packageError
              ? 'error'
              : !packagesLoaded
              ? 'checking'
              : packageDescriptor?.installed === true
                ? 'installed'
                : packageDescriptor
                  ? 'configured-missing'
                  : 'not-configured';
            const runtimeStatus = pluginRuntimeStatus(integration.id, runtimeSignals);
            const active = integration.id === selected;
            return (
              <button
                key={integration.id}
                type="button"
                onClick={() => setSelected(integration.id)}
                aria-pressed={active}
                className={cn(
                  'flex min-h-28 flex-col rounded-lg border px-3 py-3 text-left transition-colors',
                  active
                    ? 'border-primary/50 bg-interactive-selection'
                    : 'border-border/60 hover:bg-interactive-hover',
                )}
              >
                <div className="flex w-full items-center gap-2">
                  <Icon name={integration.icon} className="size-4 shrink-0 text-foreground" />
                  <span className="min-w-0 flex-1 truncate typography-ui-label text-foreground">
                    {integration.name}
                  </span>
                </div>
                <p className="mt-2 line-clamp-3 typography-meta text-muted-foreground">
                  {t(integration.descriptionKey)}
                </p>
                <IntegrationStatus
                  installStatus={installStatus}
                  runtimeStatus={runtimeStatus}
                />
              </button>
            );
          })}
        </div>
        {packageError ? (
          <p className="mt-3 break-words typography-meta text-[var(--status-error)]">{packageError}</p>
        ) : null}
      </SettingsSection>

      <SettingsSection
        settingsItem="plugin-settings.configuration"
        title={selectedIntegration.name}
        description={t('settings.piarium.pluginSettings.configuration.description')}
        headerAction={!selectedInstalled && packagesLoaded ? (
          <Button type="button" variant="outline" size="xs" onClick={() => setSettingsPage('plugins')}>
            {t('settings.piarium.pluginSettings.actions.openPackages')}
          </Button>
        ) : undefined}
      >
        {renderSelectedSettings()}
      </SettingsSection>

      <SettingsSection
        settingsItem="plugin-settings.advanced"
        title={t('settings.piarium.pluginSettings.advanced.sectionTitle')}
        description={t('settings.piarium.pluginSettings.advanced.sectionDescription')}
      >
        {navigationTarget !== null && navigationTarget.integrationId === null ? (
          <div className="mb-3 rounded-lg border border-border/60 bg-background/50 px-3 py-2.5">
            <p className="typography-ui-label text-foreground">{navigationTarget.pluginId}</p>
            <p className="mt-1 typography-meta text-muted-foreground">
              This plugin owns its configuration. Choose its native JSON or JSONC file below;
              Piarium will preserve the complete document while editing it.
            </p>
          </div>
        ) : null}
        <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
          <CollapsibleTrigger className="border border-border/60 px-3 py-2.5">
            <span className="typography-ui-label text-foreground">
              {advancedOpen
                ? t('settings.piarium.pluginSettings.advanced.hide')
                : t('settings.piarium.pluginSettings.advanced.show')}
            </span>
            <Icon name={advancedOpen ? 'arrow-up-s' : 'arrow-down-s'} className="size-4 text-muted-foreground" />
          </CollapsibleTrigger>
          <CollapsibleContent className="pt-3">
            <AdvancedPluginConfigEditor cwd={currentDirectory} sessionId={activeSessionId} />
          </CollapsibleContent>
        </Collapsible>
      </SettingsSection>
    </SettingsPageLayout>
  );
};
