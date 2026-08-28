import React from 'react';
import type {
  RecoveryStorageMode,
  RecoveryStorageStatus,
  WorkspaceRecoveryStatus,
} from '@piarium/extension-contract';
import type { RecoveryPreference } from '@piarium/protocol';
import { Icon } from '@/components/icon/Icon';
import {
  SettingsRadioGroup,
  SettingsRadioOption,
  SettingsSection,
} from '@/components/sections/shared/SettingsSection';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { updateDesktopSettings } from '@/lib/persistence';
import {
  getWorkspaceRecoveryAPI,
  requireWorkspaceRecoveryResult,
} from '@/lib/recovery/workspaceRecovery';
import { cn } from '@/lib/utils';
import { formatWorkspaceArchiveBytes } from '@/lib/workspaceArchive';
import { usePiSessionStore } from '@/stores/usePiSessionStore';
import { useUIStore } from '@/stores/useUIStore';

const RECOVERY_PREFERENCES: Array<{
  descriptionKey: I18nKey;
  labelKey: I18nKey;
  value: RecoveryPreference;
}> = [
  {
    value: 'conversation',
    labelKey: 'settings.piarium.recovery.preference.conversation.label',
    descriptionKey: 'settings.piarium.recovery.preference.conversation.description',
  },
  {
    value: 'both',
    labelKey: 'settings.piarium.recovery.preference.both.label',
    descriptionKey: 'settings.piarium.recovery.preference.both.description',
  },
  {
    value: 'ask',
    labelKey: 'settings.piarium.recovery.preference.ask.label',
    descriptionKey: 'settings.piarium.recovery.preference.ask.description',
  },
];

const STORAGE_MODES: Array<{ labelKey: I18nKey; mode: RecoveryStorageMode }> = [
  { mode: 'application-data', labelKey: 'settings.piarium.recovery.storage.applicationData' },
  { mode: 'workspace-local', labelKey: 'settings.piarium.recovery.storage.workspaceLocal' },
  { mode: 'workspace-adjacent', labelKey: 'settings.piarium.recovery.storage.workspaceAdjacent' },
  { mode: 'custom', labelKey: 'settings.piarium.recovery.storage.custom' },
];

const statusTone = (state: RecoveryStorageStatus['state']): string => {
  if (state === 'ready') return 'text-[var(--status-success)]';
  if (state === 'missing') return 'text-muted-foreground';
  if (state === 'incomplete') return 'text-[var(--status-warning)]';
  return 'text-[var(--status-error)]';
};

export const RecoverySettings: React.FC = () => {
  const { t } = useI18n();
  const preference = useUIStore((state) => state.recoveryPreference);
  const setPreference = useUIStore((state) => state.setRecoveryPreference);
  const workspaceId = usePiSessionStore((state) => {
    const sessionId = state.currentSessionId;
    const workspace = sessionId ? state.records[sessionId]?.snapshot?.workspace : undefined;
    return workspace?.kind === 'workspace' ? workspace.authorityId ?? workspace.id : null;
  });
  const [status, setStatus] = React.useState<WorkspaceRecoveryStatus | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [busy, setBusy] = React.useState<'cleanup' | 'delete' | 'move' | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [storageMode, setStorageMode] = React.useState<RecoveryStorageMode>('application-data');
  const [customRoot, setCustomRoot] = React.useState('');

  const changePreference = React.useCallback((next: RecoveryPreference) => {
    setPreference(next);
    void updateDesktopSettings({ recoveryPreference: next });
  }, [setPreference]);

  const refresh = React.useCallback(async () => {
    if (!workspaceId) {
      setStatus(null);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = requireWorkspaceRecoveryResult(await getWorkspaceRecoveryAPI().status(workspaceId));
      setStatus(result);
      setStorageMode(result.storage.location.mode);
      setCustomRoot(result.storage.location.mode === 'custom' ? result.storage.location.customRoot : '');
    } catch (cause) {
      setStatus(null);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  const moveStorage = React.useCallback(async () => {
    if (!workspaceId || (storageMode === 'custom' && !customRoot.trim())) return;
    setBusy('move');
    try {
      requireWorkspaceRecoveryResult(await getWorkspaceRecoveryAPI().setStorageLocation({
        location: storageMode === 'custom'
          ? { customRoot: customRoot.trim(), mode: 'custom' }
          : { mode: storageMode },
        workspaceId,
      }));
      toast.success(t('settings.piarium.recovery.storage.moveComplete'));
      await refresh();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  }, [customRoot, refresh, storageMode, t, workspaceId]);

  const cleanup = React.useCallback(async () => {
    if (!workspaceId) return;
    setBusy('cleanup');
    try {
      const result = requireWorkspaceRecoveryResult(
        await getWorkspaceRecoveryAPI().cleanupStorage({ workspaceId }),
      );
      toast.success(t('settings.piarium.recovery.storage.cleanupComplete', {
        bytes: formatWorkspaceArchiveBytes(result.result.byteLengthReclaimed),
      }));
      await refresh();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  }, [refresh, t, workspaceId]);

  const deleteHistory = React.useCallback(async () => {
    if (!workspaceId || typeof window === 'undefined') return;
    if (!window.confirm(t('settings.piarium.recovery.storage.deleteConfirm'))) return;
    setBusy('delete');
    try {
      requireWorkspaceRecoveryResult(await getWorkspaceRecoveryAPI().deleteWorkspaceHistory(workspaceId));
      toast.success(t('settings.piarium.recovery.storage.deleteComplete'));
      await refresh();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  }, [refresh, t, workspaceId]);

  const selectedLocation = status?.storage.location;
  const locationChanged = selectedLocation
    ? selectedLocation.mode !== storageMode
      || (storageMode === 'custom' && selectedLocation.mode === 'custom'
        && selectedLocation.customRoot !== customRoot.trim())
    : false;

  return (
    <SettingsSection
      settingsItem="sessions.recovery"
      title={t('settings.piarium.recovery.title')}
      description={t('settings.piarium.recovery.description')}
    >
      <SettingsRadioGroup aria-label={t('settings.piarium.recovery.preference.aria')}>
        {RECOVERY_PREFERENCES.map((option) => (
          <SettingsRadioOption
            key={option.value}
            selected={preference === option.value}
            onSelect={() => changePreference(option.value)}
            label={t(option.labelKey)}
            description={t(option.descriptionKey)}
            ariaLabel={t(option.labelKey)}
          />
        ))}
      </SettingsRadioGroup>

      <div className="space-y-4 border-t border-border/60 pt-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="typography-settings-group-title text-foreground">
              {t('settings.piarium.recovery.native.title')}
            </h3>
            <p className="mt-1 typography-meta text-muted-foreground">
              {t('settings.piarium.recovery.native.description')}
            </p>
          </div>
          <Button type="button" variant="ghost" size="xs" onClick={() => void refresh()} disabled={loading}>
            <Icon name="refresh" className={cn('size-3.5', loading && 'animate-spin')} />
            {t('settings.piarium.recovery.actions.refresh')}
          </Button>
        </div>

        {!workspaceId ? (
          <div className="rounded-xl border border-border/60 bg-muted/20 p-3 typography-meta text-muted-foreground">
            {t('settings.piarium.recovery.native.openWorkspace')}
          </div>
        ) : null}

        {status ? (
          <div className="rounded-xl border border-border/60 p-3">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <span className="typography-ui-label font-medium text-foreground">piarium.builtin.recovery</span>
              <span className={cn('typography-micro', statusTone(status.storage.state))}>
                {status.storage.state}
              </span>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div>
                <p className="typography-micro text-muted-foreground">{t('settings.piarium.recovery.storage.snapshots')}</p>
                <p className="mt-1 typography-ui-label tabular-nums">{status.storage.snapshotCount}</p>
              </div>
              <div>
                <p className="typography-micro text-muted-foreground">{t('settings.piarium.recovery.storage.readySnapshots')}</p>
                <p className="mt-1 typography-ui-label tabular-nums">{status.storage.readySnapshotCount}</p>
              </div>
              <div>
                <p className="typography-micro text-muted-foreground">{t('settings.piarium.recovery.storage.objects')}</p>
                <p className="mt-1 typography-ui-label tabular-nums">{status.storage.objectCount}</p>
              </div>
              <div>
                <p className="typography-micro text-muted-foreground">{t('settings.piarium.recovery.storage.size')}</p>
                <p className="mt-1 typography-ui-label tabular-nums">
                  {formatWorkspaceArchiveBytes(status.storage.byteLength)}
                </p>
              </div>
            </div>
          </div>
        ) : null}

        {status ? (
          <div className="space-y-3 rounded-xl border border-border/60 p-3">
            <div>
              <h4 className="typography-ui-label font-medium text-foreground">
                {t('settings.piarium.recovery.storage.location')}
              </h4>
              <p className="mt-1 typography-meta text-muted-foreground">
                {t('settings.piarium.recovery.storage.locationDescription')}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              {STORAGE_MODES.map((option) => (
                <Button
                  key={option.mode}
                  type="button"
                  variant="chip"
                  size="sm"
                  aria-pressed={storageMode === option.mode}
                  onClick={() => setStorageMode(option.mode)}
                >
                  {t(option.labelKey)}
                </Button>
              ))}
            </div>
            {storageMode === 'custom' ? (
              <Input
                value={customRoot}
                onChange={(event) => setCustomRoot(event.target.value)}
                placeholder={t('settings.piarium.recovery.storage.customPlaceholder')}
                className="font-mono typography-meta"
              />
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!locationChanged || busy !== null || (storageMode === 'custom' && !customRoot.trim())}
                onClick={() => void moveStorage()}
              >
                {busy === 'move'
                  ? t('settings.piarium.recovery.storage.moving')
                  : t('settings.piarium.recovery.storage.move')}
              </Button>
              <Button type="button" variant="outline" size="sm" disabled={busy !== null} onClick={() => void cleanup()}>
                {t('settings.piarium.recovery.storage.cleanup')}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy !== null || status.storage.snapshotCount === 0}
                className="text-[var(--status-error)] hover:text-[var(--status-error)]"
                onClick={() => void deleteHistory()}
              >
                {t('settings.piarium.recovery.storage.delete')}
              </Button>
            </div>
          </div>
        ) : null}

        {error ? (
          <div className="rounded-xl border border-[var(--status-error-border)] bg-[var(--status-error-background)] p-3 typography-meta text-[var(--status-error)]">
            {error}
          </div>
        ) : null}
      </div>
    </SettingsSection>
  );
};
