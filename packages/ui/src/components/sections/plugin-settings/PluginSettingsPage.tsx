import React from 'react';
import type { PackageDescriptor, RuntimeContextTarget } from '@piarium/protocol';
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

const IntegrationStatus: React.FC<{ installed: boolean; loaded: boolean }> = ({ installed, loaded }) => {
  const { t } = useI18n();
  if (!loaded) return null;
  return (
    <span className={installed
      ? 'typography-micro text-[var(--status-success)]'
      : 'typography-micro text-muted-foreground'}>
      {installed
        ? t('settings.piarium.pluginSettings.status.installed')
        : t('settings.piarium.pluginSettings.status.notInstalled')}
    </span>
  );
};

export const PluginSettingsPage: React.FC = () => {
  const { t } = useI18n();
  const currentDirectory = useDirectoryStore((state) => state.currentDirectory);
  const activeSessionId = usePiSessionStore((state) => {
    const sessionId = state.currentSessionId;
    return sessionId && state.records[sessionId]?.open ? sessionId : null;
  });
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
  const [advancedOpen, setAdvancedOpen] = React.useState(
    navigationTarget !== null && navigationTarget.integrationId === null,
  );
  const generationRef = React.useRef(0);

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

  const selectedIntegration = PLUGIN_INTEGRATIONS.find((entry) => entry.id === selected)!;
  const selectedPackage = findPiPackage(packages, selectedIntegration.packageName);
  const selectedInstalled = selectedPackage?.installed === true;

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
      >
        <div className="grid grid-cols-1 gap-2 @xl:grid-cols-2 @4xl:grid-cols-3">
          {PLUGIN_INTEGRATIONS.map((integration) => {
            const installed = findPiPackage(packages, integration.packageName)?.installed === true;
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
                  <IntegrationStatus installed={installed} loaded={packagesLoaded} />
                </div>
                <p className="mt-2 line-clamp-3 typography-meta text-muted-foreground">
                  {t(integration.descriptionKey)}
                </p>
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
