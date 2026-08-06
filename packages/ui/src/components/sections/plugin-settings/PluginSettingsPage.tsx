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
import {
  SettingsFieldRow,
  SettingsSection,
  SETTINGS_SELECT_ROW_TRIGGER_CLASS,
} from '@/components/sections/shared/SettingsSection';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
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
    <div className="flex flex-wrap gap-1.5">
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
  const [visitedIntegrations, setVisitedIntegrations] = React.useState<ReadonlySet<PluginSettingsIntegrationId>>(
    () => new Set([navigationTarget?.integrationId ?? 'subagents']),
  );
  const [customPluginId] = React.useState<string | null>(
    navigationTarget?.integrationId === null ? navigationTarget.pluginId : null,
  );
  const [unknownPluginId, setUnknownPluginId] = React.useState<string | null>(
    navigationTarget?.integrationId === null ? navigationTarget.pluginId : null,
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
  const selectedPackage = findPiPackage(
    packages,
    unknownPluginId ?? selectedIntegration.packageName,
  );
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

  // Keep every adapted panel mounted. The compact plugin selector therefore
  // never discards a draft when users compare or configure another extension.
  const knownSettings = (
    <>
      {visitedIntegrations.has('subagents') ? (
        <div hidden={selected !== 'subagents'}>
          <SubagentsSettings runtimeTarget={runtimeTarget} targetKey={targetKey} />
        </div>
      ) : null}
      {visitedIntegrations.has('magic-context') ? (
        <div hidden={selected !== 'magic-context'}>
          <MagicContextSettings
            initialPanel={navigationTarget?.section === 'agents' ? 'agents' : undefined}
            runtimeTarget={runtimeTarget}
            targetKey={targetKey}
          />
        </div>
      ) : null}
      {visitedIntegrations.has('web-access') ? (
        <div hidden={selected !== 'web-access'}>
          <WebAccessSettings runtimeTarget={runtimeTarget} targetKey={targetKey} />
        </div>
      ) : null}
      {visitedIntegrations.has('workspace-history') ? (
        <div hidden={selected !== 'workspace-history'}>
          <WorkspaceHistorySettings runtimeTarget={runtimeTarget} targetKey={targetKey} />
        </div>
      ) : null}
      {visitedIntegrations.has('wtf') ? (
        <div hidden={selected !== 'wtf'}>
          <WtfSettings runtimeTarget={runtimeTarget} targetKey={targetKey} />
        </div>
      ) : null}
      {visitedIntegrations.has('mcp') ? (
        <div hidden={selected !== 'mcp'} className="space-y-4">
          <p className="typography-ui text-muted-foreground">
            {t('settings.piarium.pluginSettings.mcp.description')}
          </p>
          <Button type="button" variant="outline" size="sm" onClick={() => setSettingsPage('mcp')}>
            {t('settings.piarium.pluginSettings.mcp.open')}
          </Button>
        </div>
      ) : null}
    </>
  );

  return (
    <SettingsPageLayout
      title={t('settings.page.pluginSettings.title')}
      description={t('settings.piarium.pluginSettings.description')}
      showSaveStatus={false}
    >
      <SettingsSection
        settingsItem="plugin-settings.integrations"
        title={t('settings.piarium.pluginSettings.integrations.title')}
        info={t('settings.piarium.pluginSettings.integrations.description')}
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
        <SettingsFieldRow
          label={t('settings.piarium.pluginSettings.integrations.choose')}
          settingsItem="plugin-settings.integration-picker"
          controlClassName="w-full max-w-[24rem]"
        >
          <Select
            value={unknownPluginId ? '__unknown__' : selected}
            onValueChange={(value) => {
              if (value === '__unknown__') {
                setUnknownPluginId(customPluginId);
                setAdvancedOpen(true);
                return;
              }
              const integrationId = value as PluginSettingsIntegrationId;
              setSelected(integrationId);
              setVisitedIntegrations((current) => current.has(integrationId)
                ? current
                : new Set([...current, integrationId]));
              setUnknownPluginId(null);
              setAdvancedOpen(false);
            }}
          >
            <SelectTrigger
              size="settings"
              className={SETTINGS_SELECT_ROW_TRIGGER_CLASS}
              aria-label={t('settings.piarium.pluginSettings.integrations.choose')}
            >
              <SelectValue>{unknownPluginId ?? selectedIntegration.name}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {customPluginId ? (
                <SelectItem value="__unknown__">{customPluginId}</SelectItem>
              ) : null}
              {PLUGIN_INTEGRATIONS.map((integration) => (
                <SelectItem key={integration.id} value={integration.id}>{integration.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsFieldRow>

        <div className="flex flex-col gap-3 border-t border-border/60 pt-4 @xl:flex-row @xl:items-start @xl:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Icon name={unknownPluginId ? 'code-box' : selectedIntegration.icon} className="size-4 shrink-0 text-foreground" />
              <span className="typography-ui-label text-foreground">{unknownPluginId ?? selectedIntegration.name}</span>
            </div>
            <p className="mt-1 max-w-2xl typography-meta text-muted-foreground">
              {unknownPluginId
                ? t('settings.piarium.pluginSettings.advanced.unknownPlugin')
                : t(selectedIntegration.descriptionKey)}
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 typography-micro text-muted-foreground">
              {selectedPackage ? (
                <>
                  <span>{selectedPackage.scope === 'project'
                    ? t('settings.common.scope.project')
                    : t('settings.common.scope.global')}</span>
                  {selectedPackage.version ? <span>v{selectedPackage.version}</span> : null}
                  <code className="break-all">{selectedPackage.source}</code>
                </>
              ) : null}
              <span>
                {activeSessionId
                  ? t('settings.piarium.pluginSettings.target.session')
                  : t('settings.piarium.pluginSettings.target.workspace')}
              </span>
              <code className="break-all">{sessionRecord?.snapshot?.cwd ?? currentDirectory}</code>
            </div>
          </div>
          <div className="flex shrink-0 flex-col items-start gap-2 @xl:items-end">
            {unknownPluginId ? null : (
              <IntegrationStatus
                installStatus={packageError
                  ? 'error'
                  : !packagesLoaded
                    ? 'checking'
                    : selectedPackage?.installed === true
                      ? 'installed'
                      : selectedPackage
                        ? 'configured-missing'
                        : 'not-configured'}
                runtimeStatus={pluginRuntimeStatus(selectedIntegration.id, runtimeSignals)}
              />
            )}
            {!selectedInstalled && packagesLoaded ? (
              <Button type="button" variant="outline" size="xs" onClick={() => setSettingsPage('plugins')}>
                {t('settings.piarium.pluginSettings.actions.openPackages')}
              </Button>
            ) : null}
          </div>
        </div>
        {packageError ? (
          <p className="mt-3 break-words typography-meta text-[var(--status-error)]">{packageError}</p>
        ) : null}
      </SettingsSection>

      <SettingsSection
        className={unknownPluginId ? 'hidden' : undefined}
        settingsItem="plugin-settings.configuration"
        title={selectedIntegration.name}
        info={t('settings.piarium.pluginSettings.configuration.description')}
      >
        {knownSettings}
      </SettingsSection>

      {customPluginId ? <SettingsSection
        className={unknownPluginId ? undefined : 'hidden'}
        settingsItem="plugin-settings.advanced"
        title={customPluginId}
        info={t('settings.piarium.pluginSettings.advanced.sectionDescription')}
      >
        <p className="mb-3 typography-meta text-muted-foreground">
          {t('settings.piarium.pluginSettings.advanced.unknownPlugin')}
        </p>
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
            <AdvancedPluginConfigEditor
              cwd={currentDirectory}
              sessionId={activeSessionId}
            />
          </CollapsibleContent>
        </Collapsible>
      </SettingsSection> : null}
    </SettingsPageLayout>
  );
};
