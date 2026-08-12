import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { SettingsSidebarItem } from '@/components/sections/shared/SettingsSidebarItem';
import { SettingsSidebarLayout } from '@/components/sections/shared/SettingsSidebarLayout';
import { SETTINGS_PANEL_TITLE_CLASS } from '@/components/sections/shared/SettingsSection';
import { useResourceRuntimeTarget } from '@/components/sections/resources/useResourceRuntimeTarget';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { usePiSessionStore } from '@/stores/usePiSessionStore';
import {
  MCP_ADAPTER_STATUS_CHANNEL,
  parseMcpAdapterStatus,
} from './mcpAdapterStatus';
import {
  refreshMcpCatalog,
  selectMcpCatalogItem,
  useMcpCatalogState,
} from './mcp-catalog-store';

interface McpSidebarProps {
  onItemSelect?: () => void;
}

export const McpSidebar: React.FC<McpSidebarProps> = ({ onItemSelect }) => {
  const { t } = useI18n();
  const { runtimeTarget, targetKey } = useResourceRuntimeTarget();
  const catalogState = useMcpCatalogState();
  const extensionState = usePiSessionStore((state) => {
    const id = state.currentSessionId;
    return id ? state.records[id]?.extensionStates[MCP_ADAPTER_STATUS_CHANNEL] : undefined;
  });
  const runtimeStatus = React.useMemo(
    () => parseMcpAdapterStatus(extensionState),
    [extensionState],
  );

  React.useEffect(() => {
    void refreshMcpCatalog(runtimeTarget, targetKey);
  }, [runtimeTarget, targetKey]);

  React.useEffect(() => {
    const refresh = (): void => {
      if (document.visibilityState === 'visible') void refreshMcpCatalog(runtimeTarget, targetKey);
    };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [runtimeTarget, targetKey]);

  const catalog = catalogState.targetKey === targetKey ? catalogState.snapshot?.catalog : undefined;
  const select = React.useCallback((selection: Parameters<typeof selectMcpCatalogItem>[0]) => {
    if (selectMcpCatalogItem(selection)) onItemSelect?.();
  }, [onItemSelect]);

  return (
    <SettingsSidebarLayout
      variant="background"
      header={(
        <div className="border-b border-border px-3 pb-3 pt-4">
          <div className="flex items-center justify-between gap-2">
            <h2 className={SETTINGS_PANEL_TITLE_CLASS}>{t('settings.page.mcp.title')}</h2>
            <div className="flex items-center gap-1">
              <span className="typography-meta tabular-nums text-muted-foreground">
                {catalog?.servers.length ?? 0}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-7"
                disabled={!catalog}
                onClick={() => select({ kind: 'new' })}
              >
                <Icon name="add" className="size-4" />
                <span className="sr-only">{t('settings.piarium.mcp.structured.addServer')}</span>
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-7"
                disabled={!catalog}
                onClick={() => select({ kind: 'settings' })}
              >
                <Icon name="settings-3" className="size-4" />
                <span className="sr-only">{t('settings.piarium.mcp.config.title')}</span>
              </Button>
            </div>
          </div>
        </div>
      )}
    >
      {catalog ? catalog.servers.map((server) => {
        const live = runtimeStatus?.servers.find((candidate) => candidate.name === server.name);
        const status = live?.status ?? (server.disabled ? 'disabled' : undefined);
        const label = status
          ? t(`settings.piarium.mcp.runtime.status.${status === 'needs-auth' ? 'needsAuth' : status === 'not-connected' ? 'notConnected' : status}` as never)
          : t(`settings.piarium.mcp.structured.transport.${server.transport.kind === 'stdio'
            ? 'localCommand'
            : server.transport.kind === 'socket'
              ? 'localSocket'
              : server.transport.kind}` as never);
        return (
          <SettingsSidebarItem
            key={server.name}
            title={server.name}
            metadata={label}
            selected={catalogState.selection.kind === 'server' && catalogState.selection.name === server.name}
            onSelect={() => select({ kind: 'server', name: server.name })}
            icon={(
              <span className={cn(
                'size-2 shrink-0 rounded-full',
                status === 'connected' ? 'bg-[var(--status-success)]'
                  : status === 'failed' ? 'bg-[var(--status-error)]'
                    : status === 'needs-auth' ? 'bg-[var(--status-warning)]'
                      : 'bg-muted-foreground/60',
              )} />
            )}
          />
        );
      }) : (
        <div className="px-3 py-10 text-center typography-meta text-muted-foreground">
          {catalogState.loading
            ? <Icon name="loader-4" className="mx-auto size-5 animate-spin" />
            : catalogState.error
              ?? catalogState.snapshot?.provider.issue
              ?? t('settings.piarium.mcp.runtime.noStatus')}
        </div>
      )}
    </SettingsSidebarLayout>
  );
};
