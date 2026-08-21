import React from 'react';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import type { McpAdapterServerStatus } from './mcpAdapterStatus';

const STATUS_LABEL_KEYS: Readonly<Record<McpAdapterServerStatus, I18nKey>> = {
  cached: 'settings.piarium.mcp.runtime.status.cached',
  connected: 'settings.piarium.mcp.runtime.status.connected',
  disabled: 'settings.piarium.mcp.runtime.status.disabled',
  failed: 'settings.piarium.mcp.runtime.status.failed',
  'needs-auth': 'settings.piarium.mcp.runtime.status.needsAuth',
  'not-connected': 'settings.piarium.mcp.runtime.status.notConnected',
};

const statusTone = (status: McpAdapterServerStatus): string => {
  if (status === 'connected') return 'bg-[var(--status-success)]/10 text-[var(--status-success)]';
  if (status === 'failed') return 'bg-[var(--status-error)]/10 text-[var(--status-error)]';
  if (status === 'needs-auth') return 'bg-[var(--status-warning)]/10 text-[var(--status-warning)]';
  return 'bg-muted text-muted-foreground';
};

export const McpServerStatusBadge: React.FC<{
  status: McpAdapterServerStatus;
}> = ({ status }) => {
  const { t } = useI18n();
  return (
    <span className={cn('shrink-0 rounded-full px-2 py-0.5 typography-micro font-medium', statusTone(status))}>
      {t(STATUS_LABEL_KEYS[status])}
    </span>
  );
};
