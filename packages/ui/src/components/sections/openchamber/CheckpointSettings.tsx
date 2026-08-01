import React from 'react';
import { RiDeleteBinLine, RiInformationLine, RiRefreshLine, RiRestartLine } from '@remixicon/react';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { NumberInput } from '@/components/ui/number-input';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { isVSCodeRuntime } from '@/lib/desktop';
import { updateDesktopSettings } from '@/lib/persistence';
import { formatWorkspaceArchiveBytes } from '@/lib/workspaceArchive';
import { useI18n } from '@/lib/i18n';
import type { CheckpointCleanupResult, CheckpointStorageStats } from '@/lib/api/types';

const DEFAULT_RETENTION_LIMIT = 200;
const MIN_RETENTION_LIMIT = 1;
const MAX_RETENTION_LIMIT = 5000;

const normalizeRetentionLimit = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_RETENTION_LIMIT;
  }
  return Math.min(MAX_RETENTION_LIMIT, Math.max(MIN_RETENTION_LIMIT, Math.round(value)));
};

const normalizeCleanupResult = (result: CheckpointCleanupResult | null | undefined): CheckpointCleanupResult => ({
  deletedCheckpoints: typeof result?.deletedCheckpoints === 'number' ? result.deletedCheckpoints : 0,
  deletedSessions: typeof result?.deletedSessions === 'number' ? result.deletedSessions : 0,
  deletedBytes: typeof result?.deletedBytes === 'number' ? result.deletedBytes : 0,
  remainingCheckpoints: typeof result?.remainingCheckpoints === 'number' ? result.remainingCheckpoints : 0,
});

export const CheckpointSettings: React.FC = () => {
  const { t } = useI18n();
  const runtime = getRegisteredRuntimeAPIs();
  const settingsApi = runtime?.settings;
  const checkpoints = runtime?.checkpoints;
  const [retentionLimit, setRetentionLimit] = React.useState(DEFAULT_RETENTION_LIMIT);
  const [stats, setStats] = React.useState<CheckpointStorageStats | null>(null);
  const [loadingStats, setLoadingStats] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [cleaning, setCleaning] = React.useState<'retention' | 'all' | null>(null);
  const saveTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const refreshStats = React.useCallback(async () => {
    if (!runtime?.runtime.isVSCode || !checkpoints?.stats) {
      return;
    }

    setLoadingStats(true);
    try {
      const nextStats = await checkpoints.stats();
      setStats(nextStats);
      setRetentionLimit(normalizeRetentionLimit(nextStats.retentionLimit));
    } catch (error) {
      console.warn('[CheckpointSettings] failed to load checkpoint stats', error);
      toast.error(t('settings.openchamber.checkpoints.toast.loadFailed'));
    } finally {
      setLoadingStats(false);
    }
  }, [checkpoints, runtime?.runtime.isVSCode, t]);

  React.useEffect(() => {
    if (!runtime?.runtime.isVSCode) {
      return;
    }

    let cancelled = false;
    const load = async () => {
      try {
        const result = await settingsApi?.load();
        if (!cancelled) {
          setRetentionLimit(normalizeRetentionLimit(result?.settings?.checkpointRetentionLimit));
        }
      } catch (error) {
        console.warn('[CheckpointSettings] failed to load checkpoint settings', error);
        if (!cancelled) {
          toast.error(t('settings.openchamber.checkpoints.toast.loadFailed'));
        }
      }
      if (!cancelled) {
        await refreshStats();
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [refreshStats, runtime?.runtime.isVSCode, settingsApi, t]);

  React.useEffect(() => {
    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
      }
    };
  }, []);

  const saveRetentionLimit = React.useCallback((rawValue: number) => {
    const nextLimit = normalizeRetentionLimit(rawValue);
    setRetentionLimit(nextLimit);
    setStats((current) => current ? { ...current, retentionLimit: nextLimit } : current);

    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
    }
    setSaving(true);
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null;
      void (async () => {
        try {
          if (settingsApi?.save) {
            await settingsApi.save({ checkpointRetentionLimit: nextLimit });
          } else {
            await updateDesktopSettings({ checkpointRetentionLimit: nextLimit });
          }
        } catch (error) {
          console.warn('[CheckpointSettings] failed to save checkpoint retention limit', error);
          toast.error(t('settings.openchamber.checkpoints.toast.saveFailed'));
        } finally {
          setSaving(false);
        }
      })();
    }, 250);
  }, [settingsApi, t]);

  const showCleanupResult = React.useCallback((result: CheckpointCleanupResult, clearAll: boolean) => {
    const normalized = normalizeCleanupResult(result);
    toast.success(t(
      clearAll
        ? 'settings.openchamber.checkpoints.toast.clearComplete'
        : 'settings.openchamber.checkpoints.toast.cleanupComplete',
      {
        count: normalized.deletedCheckpoints,
        bytes: formatWorkspaceArchiveBytes(normalized.deletedBytes),
        remaining: normalized.remainingCheckpoints,
      },
    ));
  }, [t]);

  const handleApplyRetention = React.useCallback(async () => {
    if (!checkpoints?.cleanupRetention) {
      return;
    }
    setCleaning('retention');
    try {
      const result = normalizeCleanupResult(await checkpoints.cleanupRetention(retentionLimit));
      showCleanupResult(result, false);
      await refreshStats();
    } catch (error) {
      console.warn('[CheckpointSettings] failed to apply checkpoint retention cleanup', error);
      toast.error(t('settings.openchamber.checkpoints.toast.cleanupFailed'));
    } finally {
      setCleaning(null);
    }
  }, [checkpoints, refreshStats, retentionLimit, showCleanupResult, t]);

  const handleClearAll = React.useCallback(async () => {
    if (!checkpoints?.cleanupAll || typeof window === 'undefined') {
      return;
    }
    if (!window.confirm(t('settings.openchamber.checkpoints.confirm.clearAll'))) {
      return;
    }

    setCleaning('all');
    try {
      const result = normalizeCleanupResult(await checkpoints.cleanupAll());
      showCleanupResult(result, true);
      await refreshStats();
    } catch (error) {
      console.warn('[CheckpointSettings] failed to clear checkpoint storage', error);
      toast.error(t('settings.openchamber.checkpoints.toast.cleanupFailed'));
    } finally {
      setCleaning(null);
    }
  }, [checkpoints, refreshStats, showCleanupResult, t]);

  if (!isVSCodeRuntime() || !runtime?.runtime.isVSCode || !checkpoints?.stats) {
    return null;
  }

  const isBusy = Boolean(cleaning);
  const checkpointCount = stats?.checkpointCount ?? 0;
  const sessionCount = stats?.sessionCount ?? 0;
  const storageSize = formatWorkspaceArchiveBytes(stats?.totalBytes ?? 0);

  return (
    <div className="mb-8">
      <div className="mb-1 px-1">
        <div className="flex items-center gap-2">
          <h3 className="typography-ui-header font-medium text-foreground">
            {t('settings.openchamber.checkpoints.title')}
          </h3>
          <Tooltip>
            <TooltipTrigger asChild>
              <RiInformationLine className="h-3.5 w-3.5 text-muted-foreground/60 cursor-help" />
            </TooltipTrigger>
            <TooltipContent sideOffset={8} className="max-w-xs">
              {t('settings.openchamber.checkpoints.tooltip')}
            </TooltipContent>
          </Tooltip>
        </div>
      </div>

      <section className="px-2 pb-2 pt-0 space-y-0.5">
        <div className="flex flex-col gap-2 py-1.5 sm:flex-row sm:items-center sm:gap-8">
          <div className="flex min-w-0 flex-col sm:w-56 shrink-0">
            <span className="typography-ui-label text-foreground">{t('settings.openchamber.checkpoints.field.retentionLimit')}</span>
          </div>
          <div className="flex items-center gap-2 sm:w-fit">
            <NumberInput
              value={retentionLimit}
              onValueChange={saveRetentionLimit}
              min={MIN_RETENTION_LIMIT}
              max={MAX_RETENTION_LIMIT}
              step={1}
              aria-label={t('settings.openchamber.checkpoints.field.retentionLimitAria')}
              className="w-20 tabular-nums"
            />
            <Button
              size="sm"
              type="button"
              variant="ghost"
              onClick={() => saveRetentionLimit(DEFAULT_RETENTION_LIMIT)}
              disabled={retentionLimit === DEFAULT_RETENTION_LIMIT || saving}
              className="h-7 w-7 px-0 text-muted-foreground hover:text-foreground"
              aria-label={t('settings.openchamber.checkpoints.actions.resetRetentionAria')}
              title={t('settings.common.actions.reset')}
            >
              <RiRestartLine className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>

        <div className="grid gap-2 py-1.5 sm:grid-cols-3">
          <div className="flex min-w-0 items-baseline gap-2">
            <span className="typography-ui-label text-foreground">{t('settings.openchamber.checkpoints.field.checkpoints')}</span>
            <span className="typography-meta text-muted-foreground tabular-nums">{checkpointCount}</span>
          </div>
          <div className="flex min-w-0 items-baseline gap-2">
            <span className="typography-ui-label text-foreground">{t('settings.openchamber.checkpoints.field.sessions')}</span>
            <span className="typography-meta text-muted-foreground tabular-nums">{sessionCount}</span>
          </div>
          <div className="flex min-w-0 items-baseline gap-2">
            <span className="typography-ui-label text-foreground">{t('settings.openchamber.checkpoints.field.storage')}</span>
            <span className="typography-meta text-muted-foreground tabular-nums">{storageSize}</span>
          </div>
        </div>
      </section>

      <div className="mt-1 px-2 py-1.5 space-y-1">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-8">
          <div className="flex min-w-0 flex-col sm:w-56 shrink-0">
            <p className="typography-meta text-foreground font-medium">{t('settings.openchamber.checkpoints.manualCleanup.title')}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2 sm:w-fit">
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={refreshStats}
              disabled={loadingStats || isBusy}
              className="!font-normal gap-1.5"
            >
              <RiRefreshLine className="h-3.5 w-3.5" />
              {t('settings.openchamber.checkpoints.actions.refreshStats')}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={handleApplyRetention}
              disabled={isBusy || !checkpoints.cleanupRetention}
              className="!font-normal"
            >
              {cleaning === 'retention'
                ? t('settings.openchamber.checkpoints.actions.cleaning')
                : t('settings.openchamber.checkpoints.actions.applyRetention')}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={handleClearAll}
              disabled={isBusy || !checkpoints.cleanupAll || checkpointCount === 0}
              className="!font-normal gap-1.5 text-[var(--status-error)] hover:text-[var(--status-error)]"
            >
              <RiDeleteBinLine className="h-3.5 w-3.5" />
              {cleaning === 'all'
                ? t('settings.openchamber.checkpoints.actions.cleaning')
                : t('settings.openchamber.checkpoints.actions.clearAll')}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
};
