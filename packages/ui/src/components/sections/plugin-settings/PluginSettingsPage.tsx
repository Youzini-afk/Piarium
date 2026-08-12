import React from 'react';
import type { PackageDescriptor, RuntimeContextTarget } from '@piarium/protocol';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import { SettingsSection } from '@/components/sections/shared/SettingsSection';
import { Button } from '@/components/ui/button';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { usePiSessionStore } from '@/stores/usePiSessionStore';
import { useUIStore } from '@/stores/useUIStore';
import { useI18n } from '@/lib/i18n';
import { getRuntimeKey } from '@/lib/runtime-switch';
import {
  consumePluginSettingsTarget,
  pluginSettingsIntegrationForPluginId,
  type PluginSettingsIntegrationId,
} from '@/lib/settings/plugin-settings-navigation';
import { AdvancedPluginConfigEditor } from './AdvancedPluginConfigEditor';
import { MagicContextSettings } from './MagicContextSettings';
import { SubagentsSettings } from './SubagentsSettings';
import { WebAccessSettings } from './WebAccessSettings';
import { WorkspaceHistorySettings } from './WorkspaceHistorySettings';
import { WtfSettings } from './WtfSettings';
import {
  pluginSettingsPackageIdentity,
  preferPluginSettingsPackage,
  refreshPluginSettingsCatalog,
  usePluginSettingsCatalogState,
} from './plugin-settings-store';

interface PluginIntegration {
  icon: IconName;
  id: Exclude<PluginSettingsIntegrationId, 'mcp'>;
  packageName: string;
}

const PLUGIN_INTEGRATIONS: readonly PluginIntegration[] = [
  { icon: 'robot-2', id: 'subagents', packageName: 'pi-subagents' },
  { icon: 'brain', id: 'magic-context', packageName: '@cortexkit/pi-magic-context' },
  { icon: 'global', id: 'web-access', packageName: 'pi-web-access' },
  { icon: 'history', id: 'workspace-history', packageName: 'pi-workspace-history' },
  { icon: 'arrow-go-back', id: 'wtf', packageName: 'pi-wtf' },
] as const;

const integrationForPackage = (entry: PackageDescriptor): PluginIntegration | null => {
  const integrationId = pluginSettingsIntegrationForPluginId(entry.name)
    ?? pluginSettingsIntegrationForPluginId(entry.source);
  return PLUGIN_INTEGRATIONS.find((candidate) => candidate.id === integrationId) ?? null;
};

export const PluginSettingsPage: React.FC = () => {
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
  const runtimeTargetKey = `${getRuntimeKey()}:${activeSessionId ? `session:${activeSessionId}` : `cwd:${currentDirectory}`}`;
  const catalog = usePluginSettingsCatalogState();
  const [navigationTarget] = React.useState(() => consumePluginSettingsTarget());
  const [visited, setVisited] = React.useState<ReadonlySet<string>>(() => new Set());

  React.useEffect(() => {
    void refreshPluginSettingsCatalog(runtimeTarget, runtimeTargetKey);
  }, [runtimeTarget, runtimeTargetKey]);

  React.useEffect(() => {
    if (!navigationTarget) return;
    preferPluginSettingsPackage(navigationTarget.pluginId, navigationTarget.packageIdentity);
  }, [navigationTarget]);

  const selectedPackage = catalog.packages.find((entry) => (
    pluginSettingsPackageIdentity(entry) === catalog.selectedIdentity
  )) ?? null;
  const selectedIdentity = selectedPackage ? pluginSettingsPackageIdentity(selectedPackage) : null;

  React.useEffect(() => {
    if (!selectedIdentity) return;
    setVisited((current) => current.has(selectedIdentity)
      ? current
      : new Set([...current, selectedIdentity]));
  }, [selectedIdentity]);

  return (
    <>
      {catalog.packages.map((entry) => {
        const identity = pluginSettingsPackageIdentity(entry);
        if (!visited.has(identity) && identity !== selectedIdentity) return null;
        const integration = integrationForPackage(entry);
        const integrationId = pluginSettingsIntegrationForPluginId(entry.name)
          ?? pluginSettingsIntegrationForPluginId(entry.source);
        return (
          <div key={identity} hidden={identity !== selectedIdentity} className="h-full">
            <SettingsPageLayout
              title={entry.name}
              titleLeading={<Icon name={integrationId === 'mcp' ? 'server' : integration?.icon ?? 'code-box'} className="size-5 text-muted-foreground" />}
              description={entry.source}
              showSaveStatus={false}
            >
              <SettingsSection divider={false} settingsItem="plugin-settings.configuration">
                <div className="mb-5 flex flex-wrap gap-x-3 gap-y-1 typography-micro text-muted-foreground">
                  <span>{entry.scope === 'project'
                    ? t('settings.common.scope.project')
                    : t('settings.common.scope.global')}</span>
                  {entry.version ? <span>v{entry.version}</span> : null}
                  {entry.resolvedPath ? <code className="break-all">{entry.resolvedPath}</code> : null}
                </div>
                {integrationId === 'mcp' ? (
                  <Button type="button" variant="outline" size="sm" onClick={() => setSettingsPage('mcp')}>
                    {t('settings.piarium.pluginSettings.mcp.open')}
                  </Button>
                ) : integration?.id === 'subagents' ? (
                  <SubagentsSettings runtimeTarget={runtimeTarget} targetKey={`${runtimeTargetKey}:${identity}`} />
                ) : integration?.id === 'magic-context' ? (
                  <MagicContextSettings
                    initialPanel={navigationTarget?.section === 'agents' ? 'agents' : undefined}
                    runtimeTarget={runtimeTarget}
                    targetKey={`${runtimeTargetKey}:${identity}`}
                  />
                ) : integration?.id === 'web-access' ? (
                  <WebAccessSettings runtimeTarget={runtimeTarget} targetKey={`${runtimeTargetKey}:${identity}`} />
                ) : integration?.id === 'workspace-history' ? (
                  <WorkspaceHistorySettings runtimeTarget={runtimeTarget} targetKey={`${runtimeTargetKey}:${identity}`} />
                ) : integration?.id === 'wtf' ? (
                  <WtfSettings runtimeTarget={runtimeTarget} targetKey={`${runtimeTargetKey}:${identity}`} />
                ) : (
                  <AdvancedPluginConfigEditor
                    key={`${runtimeTargetKey}:${identity}`}
                    cwd={currentDirectory}
                    sessionId={activeSessionId}
                  />
                )}
              </SettingsSection>
            </SettingsPageLayout>
          </div>
        );
      })}
      {!selectedPackage ? (
        <SettingsPageLayout
          title={t('settings.page.pluginSettings.title')}
          description={t('settings.piarium.pluginSettings.description')}
          showSaveStatus={false}
        >
          <SettingsSection divider={false} settingsItem="plugin-settings.configuration">
            <div className="py-8 text-center typography-ui text-muted-foreground">
              {catalog.loading && !catalog.loaded
                ? <Icon name="loader-4" className="mx-auto size-5 animate-spin" />
                : catalog.error ?? t('settings.piarium.pluginSettings.installed.empty')}
            </div>
          </SettingsSection>
        </SettingsPageLayout>
      ) : null}
    </>
  );
};
