import React from 'react';
import type { PiFleetSnapshot } from '@piarium/protocol';
import { Icon } from '@/components/icon/Icon';
import { getPiFleetStatus } from '@/lib/pi-runtime/fleet';
import { piSessionContextUsage } from '@/lib/pi-runtime/sessionStats';
import { getCurrentIntlLocale, useI18n, type I18nKey } from '@/lib/i18n';
import { isVSCodeRuntime } from '@/lib/desktop';
import { cn } from '@/lib/utils';
import { usePiSessionStore } from '@/stores/usePiSessionStore';
import { useUIStore } from '@/stores/useUIStore';
import {
  MCP_ADAPTER_STATUS_CHANNEL,
  parseMcpAdapterStatus,
  type McpAdapterServerStatus,
} from '@/components/sections/mcp/mcpAdapterStatus';
import { formatFleetDuration } from '@/components/sections/fleet/fleetPresentation';
import { piWorkStatusEntryPreview, piWorkStatusQueueCount } from './piWorkStatus';

interface PiWorkStatusPanelProps {
  sessionId: string;
}

const MCP_STATUS_LABEL_KEYS: Record<McpAdapterServerStatus, I18nKey> = {
  cached: 'settings.piarium.mcp.runtime.status.cached',
  connected: 'settings.piarium.mcp.runtime.status.connected',
  disabled: 'settings.piarium.mcp.runtime.status.disabled',
  failed: 'settings.piarium.mcp.runtime.status.failed',
  'needs-auth': 'settings.piarium.mcp.runtime.status.needsAuth',
  'not-connected': 'settings.piarium.mcp.runtime.status.notConnected',
};

const formatCompact = (value: number): string => new Intl.NumberFormat(getCurrentIntlLocale(), {
  maximumFractionDigits: 1,
  notation: 'compact',
}).format(value);

const formatCost = (value: number): string => new Intl.NumberFormat(getCurrentIntlLocale(), {
  currency: 'USD',
  maximumFractionDigits: 4,
  style: 'currency',
}).format(value);

const statusDotClass = (status: McpAdapterServerStatus): string => {
  if (status === 'connected' || status === 'cached') return 'bg-[var(--status-success)]';
  if (status === 'failed') return 'bg-[var(--status-error)]';
  if (status === 'needs-auth') return 'bg-[var(--status-warning)]';
  return 'bg-muted-foreground/45';
};

const WorkSection: React.FC<{
  children: React.ReactNode;
  icon: React.ComponentProps<typeof Icon>['name'];
  title: string;
}> = ({ children, icon, title }) => (
  <section className="border-b border-border/55 px-3 py-3 last:border-b-0">
    <h3 className="mb-2 flex items-center gap-2 typography-micro font-semibold uppercase tracking-wide text-muted-foreground">
      <Icon name={icon} className="size-3.5" />
      {title}
    </h3>
    {children}
  </section>
);

const MetricRow: React.FC<{ label: string; value: React.ReactNode }> = ({ label, value }) => (
  <div className="flex min-w-0 items-baseline justify-between gap-3 py-0.5 typography-meta">
    <span className="shrink-0 text-muted-foreground">{label}</span>
    <span className="min-w-0 truncate text-right tabular-nums text-foreground">{value}</span>
  </div>
);

export const PiWorkStatusPanel: React.FC<PiWorkStatusPanelProps> = ({ sessionId }) => {
  const { t } = useI18n();
  const record = usePiSessionStore((state) => state.records[sessionId]);
  const refreshStats = usePiSessionStore((state) => state.refreshStats);
  const isMobile = useUIStore((state) => state.isMobile);
  const isVSCode = React.useMemo(() => isVSCodeRuntime(), []);
  const [fleet, setFleet] = React.useState<PiFleetSnapshot | null>(null);
  const fleetGeneration = React.useRef(0);
  const snapshot = record?.snapshot;
  const stats = record?.stats;
  const snapshotBusy = snapshot?.busy ?? false;
  const snapshotCompacting = snapshot?.isCompacting ?? false;
  const snapshotLeafId = snapshot?.leafId ?? null;
  const snapshotStreaming = snapshot?.isStreaming ?? false;

  React.useEffect(() => {
    if (!snapshot || snapshotBusy || snapshotStreaming || snapshotCompacting) return;
    void refreshStats(sessionId).catch(() => undefined);
  }, [refreshStats, sessionId, snapshot, snapshotBusy, snapshotCompacting, snapshotLeafId, snapshotStreaming]);

  React.useEffect(() => {
    if (!snapshot || isMobile || isVSCode) return;
    let disposed = false;
    const generation = ++fleetGeneration.current;
    const refresh = async () => {
      try {
        const next = await getPiFleetStatus(sessionId);
        if (!disposed && generation === fleetGeneration.current) setFleet(next);
      } catch {
        if (!disposed && generation === fleetGeneration.current) setFleet(null);
      }
    };
    void refresh();
    if (!snapshotBusy && !snapshotStreaming) return () => { disposed = true; };
    const timer = globalThis.setInterval(() => void refresh(), 2_000);
    return () => {
      disposed = true;
      globalThis.clearInterval(timer);
    };
  }, [isMobile, isVSCode, sessionId, snapshot, snapshotBusy, snapshotStreaming]);

  if (!snapshot || isMobile || isVSCode) return null;

  const context = piSessionContextUsage(stats, snapshot);
  const queueCount = piWorkStatusQueueCount(snapshot);
  const runningTools = Object.values(record?.toolExecutions ?? {})
    .filter((execution) => execution.status === 'running');
  const goal = snapshot.features.goal;
  const entriesById = new Map((record?.branchEntries?.entries ?? []).map((entry) => [entry.id, entry]));
  const pinned = snapshot.features.pinnedContext.map((pin) => ({
    ...pin,
    preview: piWorkStatusEntryPreview(entriesById.get(pin.entryId)),
  }));
  const mcp = parseMcpAdapterStatus(record?.extensionStates[MCP_ADAPTER_STATUS_CHANNEL]);
  const activeFleetEntries = fleet?.entries ?? [];
  const activeLabel = snapshot.isCompacting
    ? t('chat.workStatus.state.compacting')
    : snapshot.retryAttempt > 0
      ? t('chat.workStatus.state.retrying')
      : snapshot.busy || snapshot.isStreaming
        ? t('chat.workStatus.state.working')
        : t('chat.workStatus.state.idle');
  const now = Date.now();

  return (
    <aside
      aria-label={t('chat.workStatus.title')}
      className="pi-work-status-panel min-h-0 w-72 shrink-0 py-3 pr-3"
    >
      <div className="flex min-h-0 w-full flex-col overflow-hidden rounded-xl border border-border/70 bg-[var(--surface-elevated)] shadow-sm">
        <div className="flex shrink-0 items-center gap-2 border-b border-border/60 px-3 py-2.5">
          <Icon name="pulse" className={cn('size-4 text-primary', (snapshot.busy || snapshot.isStreaming) && 'animate-pulse')} />
          <h2 className="typography-ui-label font-semibold text-foreground">{t('chat.workStatus.title')}</h2>
          <span className="ml-auto typography-micro text-muted-foreground">{activeLabel}</span>
        </div>

        <div className="min-h-0 overflow-y-auto overscroll-contain">
          <WorkSection icon="donut-chart" title={t('chat.workStatus.section.session')}>
            {goal ? (
              <div className="mb-2 rounded-lg border border-primary/20 bg-primary/5 px-2.5 py-2">
                <div className="flex items-center gap-2">
                  <span className="size-1.5 shrink-0 rounded-full bg-primary" />
                  <span className="typography-micro font-medium text-primary">{t(`chat.goal.status.${goal.status}` as I18nKey)}</span>
                </div>
                <p className="mt-1 line-clamp-3 typography-meta text-foreground">{goal.objective}</p>
              </div>
            ) : null}
            {snapshot.model ? (
              <MetricRow label={t('chat.modelControls.model')} value={`${snapshot.model.provider}/${snapshot.model.id}`} />
            ) : null}
            {context ? (
              <MetricRow
                label={t('contextSidebar.section.context')}
                value={`${Math.min(context.percentage, 999).toFixed(1)}% · ${formatCompact(context.totalTokens)}/${formatCompact(context.contextLimit)}`}
              />
            ) : null}
            {stats ? (
              <>
                <MetricRow label={t('contextSidebar.stats.messages')} value={formatCompact(stats.totalMessages)} />
                <MetricRow label={t('chat.workStatus.toolCalls')} value={formatCompact(stats.toolCalls)} />
                <MetricRow label={t('chat.workStatus.tokens')} value={formatCompact(stats.tokens.total)} />
                <MetricRow label={t('contextSidebar.stats.cost')} value={formatCost(stats.cost)} />
              </>
            ) : null}
          </WorkSection>

          {(runningTools.length > 0 || snapshot.activeTools.length > 0 || queueCount > 0) ? (
            <WorkSection icon="hammer" title={t('chat.workStatus.section.activity')}>
              {queueCount > 0 ? <MetricRow label={t('chat.workStatus.queue')} value={queueCount} /> : null}
              <div className="mt-1 space-y-1">
                {(runningTools.length > 0
                  ? runningTools.map((tool) => ({ key: tool.toolCallId, name: tool.name }))
                  : snapshot.activeTools.map((name) => ({ key: name, name })))
                  .map((tool) => (
                    <div key={tool.key} className="flex min-w-0 items-center gap-2 rounded-md bg-muted/35 px-2 py-1.5">
                      <Icon name="loader-4" className="size-3 shrink-0 animate-spin text-primary" />
                      <code className="min-w-0 truncate typography-micro text-foreground">{tool.name}</code>
                    </div>
                  ))}
              </div>
            </WorkSection>
          ) : null}

          {activeFleetEntries.length > 0 ? (
            <WorkSection icon="ai-agent" title={t('settings.page.fleet.title')}>
              <MetricRow label={t('settings.piarium.fleet.active.title')} value={fleet?.totalActive ?? activeFleetEntries.length} />
              <div className="mt-1 space-y-1.5">
                {activeFleetEntries.map((entry) => (
                  <div key={`${entry.providerId}:${entry.key}`} className="rounded-md border border-border/50 bg-background/50 px-2 py-1.5">
                    <div className="flex items-center gap-2">
                      <span className="size-1.5 shrink-0 rounded-full bg-[var(--status-success)]" />
                      <span className="min-w-0 flex-1 truncate typography-meta font-medium text-foreground">{entry.agent}</span>
                      <span className="shrink-0 typography-micro text-muted-foreground">{formatFleetDuration(entry.startedAt, now)}</span>
                    </div>
                    {entry.goal ? <p className="mt-1 line-clamp-2 typography-micro text-muted-foreground">{entry.goal}</p> : null}
                  </div>
                ))}
              </div>
            </WorkSection>
          ) : null}

          {mcp && mcp.servers.length > 0 ? (
            <WorkSection icon="plug-2" title={t('settings.page.mcp.title')}>
              <MetricRow
                label={t('settings.piarium.mcp.runtime.connected')}
                value={`${mcp.connectedCount}/${mcp.servers.length}`}
              />
              <div className="mt-1 space-y-1">
                {mcp.servers.map((server) => (
                  <div key={server.name} className="flex min-w-0 items-center gap-2 py-0.5 typography-micro">
                    <span className={cn('size-1.5 shrink-0 rounded-full', statusDotClass(server.status))} />
                    <code className="min-w-0 flex-1 truncate text-foreground">{server.name}</code>
                    <span className="shrink-0 text-muted-foreground">{t(MCP_STATUS_LABEL_KEYS[server.status])}</span>
                  </div>
                ))}
              </div>
            </WorkSection>
          ) : null}

          {pinned.length > 0 ? (
            <WorkSection icon="pushpin-2" title={t('chat.workStatus.section.pinned')}>
              <div className="space-y-1.5">
                {pinned.map((entry) => (
                  <button
                    key={entry.entryId}
                    type="button"
                    onClick={() => document.getElementById(`pi-entry-${entry.entryId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })}
                    className="block w-full rounded-md border border-border/50 bg-background/50 px-2 py-1.5 text-left hover:bg-interactive-hover"
                  >
                    <span className="block typography-micro font-medium text-muted-foreground">{entry.role}</span>
                    <span className="mt-0.5 block line-clamp-2 typography-meta text-foreground">{entry.preview ?? entry.entryId}</span>
                  </button>
                ))}
              </div>
            </WorkSection>
          ) : null}
        </div>
      </div>
    </aside>
  );
};
