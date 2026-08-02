import React from 'react';
import { canUseElectronDesktopIPC, invokeDesktop, isDesktopLocalOriginActive } from '@/lib/desktop';
import { getRuntimeApiBaseUrl } from '@/lib/runtime-switch';
import {
  desktopHostsGet,
  getDesktopHostApiUrl,
  locationMatchesHost,
  redactSensitiveUrl,
} from '@/lib/desktopHosts';
import { useQuotaStore } from '@/stores/useQuotaStore';
import { QUOTA_PROVIDERS, formatWindowLabel, formatQuotaValueLabel } from '@/lib/quota';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { usePiSessionStore } from '@/stores/usePiSessionStore';
import { projectPiTraySessions, type PiTraySession } from '@/lib/pi-runtime/piTraySnapshot';

const FLUSH_DEBOUNCE_MS = 500;
const CATALOG_REFRESH_MS = 45_000;

type TrayApproval = {
  kind: 'permission' | 'question';
  id: string;
  sessionId: string;
  sessionTitle: string;
  label: string;
  directory: string;
};

type TrayUsageRow = { label: string; value: string };
type TrayUsageGroup = { provider: string; rows: TrayUsageRow[]; status: string | null };
type TrayUsage = { mode: 'usage' | 'remaining'; groups: TrayUsageGroup[] };

type TraySnapshot = {
  approvals: TrayApproval[];
  dockBadgeCount: number;
  instanceName: string;
  sessions: PiTraySession[];
  usage: TrayUsage;
};

const isTrayPlatform = (): boolean => {
  if (typeof window === 'undefined') return false;
  const platform = (window as unknown as { __OPENCHAMBER_PLATFORM__?: string }).__OPENCHAMBER_PLATFORM__;
  return platform === 'darwin' || platform === 'win32' || platform === 'linux';
};

const isTrayEnabled = (): boolean => (
  typeof window !== 'undefined' && window.__OPENCHAMBER_ELECTRON__?.trayEnabled !== false
);

const buildUsage = (): TrayUsage => {
  const { results, dropdownProviderIds, displayMode } = useQuotaStore.getState();
  const mode: TrayUsage['mode'] = displayMode === 'remaining' ? 'remaining' : 'usage';
  if (dropdownProviderIds.length === 0) return { mode, groups: [] };

  const byProvider = new Map(results.map((result) => [result.providerId, result]));
  const groups: TrayUsageGroup[] = [];
  for (const meta of QUOTA_PROVIDERS) {
    if (!dropdownProviderIds.includes(meta.id)) continue;
    const result = byProvider.get(meta.id);
    if (!result || result.configured !== true) continue;

    const rows: TrayUsageRow[] = [];
    for (const [label, window] of Object.entries(result.usage?.windows ?? {})) {
      const percent = mode === 'remaining' ? window.remainingPercent : window.usedPercent;
      rows.push({
        label: formatWindowLabel(label),
        value: formatQuotaValueLabel(window.valueLabel, percent),
      });
    }

    const status = !result.ok && result.error
      ? result.error
      : rows.length === 0
        ? 'No rate limits reported'
        : null;
    groups.push({ provider: meta.name, rows, status });
  }
  return { mode, groups };
};

const resolveInstanceName = async (): Promise<string> => {
  try {
    if (isDesktopLocalOriginActive()) return 'Local Piarium';
    const localOrigin = (window as unknown as { __OPENCHAMBER_LOCAL_ORIGIN__?: string }).__OPENCHAMBER_LOCAL_ORIGIN__
      || window.location.origin;
    const runtimeApiBaseUrl = getRuntimeApiBaseUrl();
    if (runtimeApiBaseUrl && locationMatchesHost(runtimeApiBaseUrl, localOrigin)) return 'Local Piarium';
    const config = await desktopHostsGet();
    const match = config.hosts.find((host) => (
      runtimeApiBaseUrl
        ? locationMatchesHost(runtimeApiBaseUrl, getDesktopHostApiUrl(host))
        : false
    ));
    if (match?.label?.trim()) return redactSensitiveUrl(match.label.trim());
    return 'Piarium';
  } catch {
    return 'Piarium';
  }
};

const buildSnapshot = (instanceName: string): TraySnapshot => {
  const sessionState = usePiSessionStore.getState();
  return {
    approvals: [],
    dockBadgeCount: 0,
    instanceName,
    sessions: projectPiTraySessions(
      sessionState.summaries,
      sessionState.records,
      useProjectsStore.getState().projects,
    ),
    usage: buildUsage(),
  };
};

export const useTraySync = (options: { enabled?: boolean } = {}): void => {
  const enabled = options.enabled ?? true;
  React.useEffect(() => {
    if (!enabled || !isTrayPlatform() || !isTrayEnabled() || !canUseElectronDesktopIPC()) return;

    let disposed = false;
    let flushTimer: number | null = null;
    let instanceName = 'Piarium';
    let lastSerialized = '';

    const flushNow = () => {
      if (disposed) return;
      const snapshot = buildSnapshot(instanceName);
      const serialized = JSON.stringify(snapshot);
      if (serialized === lastSerialized) return;
      lastSerialized = serialized;
      void invokeDesktop('desktop_tray_update', snapshot);
    };

    const scheduleFlush = () => {
      if (disposed || flushTimer !== null) return;
      flushTimer = window.setTimeout(() => {
        flushTimer = null;
        flushNow();
      }, FLUSH_DEBOUNCE_MS);
    };

    const refreshCatalog = () => {
      const state = usePiSessionStore.getState();
      if (state.catalogLoading) return;
      void state.loadCatalog().catch(() => undefined);
    };

    const unsubscribeSessions = usePiSessionStore.subscribe(() => scheduleFlush());
    const unsubscribeProjects = useProjectsStore.subscribe(() => scheduleFlush());
    const unsubscribeQuota = useQuotaStore.subscribe(() => scheduleFlush());

    const sessionState = usePiSessionStore.getState();
    if (!sessionState.catalogLoaded && !sessionState.catalogLoading) refreshCatalog();
    const catalogRefreshTimer = window.setInterval(refreshCatalog, CATALOG_REFRESH_MS);

    void resolveInstanceName().then((name) => {
      if (disposed) return;
      instanceName = name;
      flushNow();
    });

    void useQuotaStore.getState().loadSettings().then(() => {
      if (disposed) return;
      const quota = useQuotaStore.getState();
      const needsFetch = quota.dropdownProviderIds.length > 0
        && quota.dropdownProviderIds.some((id) => !quota.results.some((result) => result.providerId === id));
      if (needsFetch) void quota.fetchAllQuotas();
    });
    const usageRefreshTimer = window.setInterval(() => {
      const quota = useQuotaStore.getState();
      if (quota.autoRefresh && quota.dropdownProviderIds.length > 0) void quota.fetchAllQuotas();
    }, Math.max(30_000, useQuotaStore.getState().refreshIntervalMs || 60_000));

    flushNow();

    return () => {
      disposed = true;
      if (flushTimer !== null) window.clearTimeout(flushTimer);
      window.clearInterval(catalogRefreshTimer);
      window.clearInterval(usageRefreshTimer);
      unsubscribeSessions();
      unsubscribeProjects();
      unsubscribeQuota();
    };
  }, [enabled]);
};
