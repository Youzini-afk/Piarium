import React from 'react';
import type { RuntimeContextTarget } from '@piarium/protocol';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { SettingsSidebarLayout } from '@/components/sections/shared/SettingsSidebarLayout';
import { SettingsSidebarItem } from '@/components/sections/shared/SettingsSidebarItem';
import { SETTINGS_PANEL_TITLE_CLASS } from '@/components/sections/shared/SettingsSection';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { usePiSessionStore } from '@/stores/usePiSessionStore';
import { subscribePiRuntimeCatalogChanged } from '@/lib/pi-runtime/catalog-events';
import { getRuntimeKey } from '@piarium/application-client';
import { useI18n } from '@/lib/i18n';
import {
  pluginSettingsPackageIdentity,
  refreshPluginSettingsCatalog,
  selectPluginSettingsPackage,
  usePluginSettingsCatalogState,
} from './plugin-settings-store';

interface PluginSettingsSidebarProps {
  onItemSelect?: () => void;
}

export const PluginSettingsSidebar: React.FC<PluginSettingsSidebarProps> = ({ onItemSelect }) => {
  const { t } = useI18n();
  const currentDirectory = useDirectoryStore((state) => state.currentDirectory);
  const activeSessionId = usePiSessionStore((state) => {
    const sessionId = state.currentSessionId;
    return sessionId && state.records[sessionId]?.open ? sessionId : null;
  });
  const runtimeTarget = React.useMemo<RuntimeContextTarget>(() => (
    activeSessionId ? { sessionId: activeSessionId } : { cwd: currentDirectory }
  ), [activeSessionId, currentDirectory]);
  const targetKey = `${getRuntimeKey()}:${activeSessionId ? `session:${activeSessionId}` : `cwd:${currentDirectory}`}`;
  const state = usePluginSettingsCatalogState();
  const refresh = React.useCallback(
    () => refreshPluginSettingsCatalog(runtimeTarget, targetKey),
    [runtimeTarget, targetKey],
  );

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  React.useEffect(() => subscribePiRuntimeCatalogChanged((reason) => {
    if (reason === 'package') void refresh();
  }), [refresh]);

  React.useEffect(() => {
    const refreshVisibleCatalog = (): void => {
      if (document.visibilityState === 'visible') void refresh();
    };
    window.addEventListener('focus', refreshVisibleCatalog);
    document.addEventListener('visibilitychange', refreshVisibleCatalog);
    return () => {
      window.removeEventListener('focus', refreshVisibleCatalog);
      document.removeEventListener('visibilitychange', refreshVisibleCatalog);
    };
  }, [refresh]);

  return (
    <SettingsSidebarLayout
      variant="background"
      header={(
        <div className="flex items-center justify-between gap-2 border-b border-border px-3 pb-3 pt-4">
          <div className="flex min-w-0 items-center gap-2">
            <h2 className={SETTINGS_PANEL_TITLE_CLASS}>{t('settings.page.pluginSettings.title')}</h2>
            <span className="typography-meta tabular-nums text-muted-foreground">{state.packages.length}</span>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7"
            disabled={state.loading}
            onClick={() => void refresh()}
          >
            <Icon name="refresh" className={state.loading ? 'size-4 animate-spin' : 'size-4'} />
            <span className="sr-only">{t('settings.piarium.recovery.actions.refresh')}</span>
          </Button>
        </div>
      )}
    >
      {state.packages.map((entry) => {
        const identity = pluginSettingsPackageIdentity(entry);
        return (
          <SettingsSidebarItem
            key={identity}
            title={entry.name}
            metadata={entry.source}
            selected={identity === state.selectedIdentity}
            onSelect={() => {
              selectPluginSettingsPackage(identity);
              onItemSelect?.();
            }}
            icon={<Icon name="plug-2" className="size-4 shrink-0 text-muted-foreground" />}
          />
        );
      })}
      {state.packages.length === 0 ? (
        <div className="px-3 py-10 text-center typography-meta text-muted-foreground">
          {state.loading
            ? <Icon name="loader-4" className="mx-auto size-5 animate-spin" />
            : state.error ?? t('settings.piarium.pluginSettings.installed.empty')}
        </div>
      ) : null}
      {state.packages.length > 0 && state.error ? (
        <div className="px-2 py-2 break-words typography-meta text-[var(--status-error)]">{state.error}</div>
      ) : null}
    </SettingsSidebarLayout>
  );
};
