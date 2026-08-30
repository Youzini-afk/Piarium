import React from 'react';
import type {
  RecoveryStorageLocation,
  RecoveryStorageMode,
  RecoveryStorageStatus,
  RecoveryStorageWorkspaceSummary,
  WorkspaceRecoveryStatus,
} from '@piarium/extension-contract';
import type { RecoveryPreference } from '@piarium/protocol';
import { Icon } from '@/components/icon/Icon';
import { DirectoryExplorerDialog } from '@/components/session/DirectoryExplorerDialog';
import {
  SettingsRadioGroup,
  SettingsRadioOption,
  SettingsSection,
} from '@/components/sections/shared/SettingsSection';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { canRequestNativeDirectoryAccess, requestDirectoryAccess } from '@/lib/desktop';
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

type StorageEditorMode = RecoveryStorageMode | 'inherit';
type StoragePickerTarget = 'global' | 'workspace';

const storageLocation = (mode: RecoveryStorageMode, customRoot: string): RecoveryStorageLocation => (
  mode === 'custom' ? { customRoot: customRoot.trim(), mode } : { mode }
);

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
  const [globalStatus, setGlobalStatus] = React.useState<RecoveryStorageStatus | null>(null);
  const [storageWorkspaces, setStorageWorkspaces] = React.useState<RecoveryStorageWorkspaceSummary[]>([]);
  const [status, setStatus] = React.useState<WorkspaceRecoveryStatus | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [busy, setBusy] = React.useState<'cleanup' | 'delete' | 'global' | 'move' | null>(null);
  const [globalError, setGlobalError] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [globalStorageMode, setGlobalStorageMode] = React.useState<RecoveryStorageMode>('application-data');
  const [globalCustomRoot, setGlobalCustomRoot] = React.useState('');
  const [storageMode, setStorageMode] = React.useState<StorageEditorMode>('inherit');
  const [customRoot, setCustomRoot] = React.useState('');
  const [pickerTarget, setPickerTarget] = React.useState<StoragePickerTarget | null>(null);
  const [maintenanceBusy, setMaintenanceBusy] = React.useState<string | null>(null);
  const [maintenanceError, setMaintenanceError] = React.useState<string | null>(null);

  const changePreference = React.useCallback((next: RecoveryPreference) => {
    setPreference(next);
    void updateDesktopSettings({ recoveryPreference: next });
  }, [setPreference]);

  const refresh = React.useCallback(async () => {
    setLoading(true);
    setGlobalError(null);
    setMaintenanceError(null);
    setError(null);
    try {
      const api = getWorkspaceRecoveryAPI();
      const [globalResult, workspaceResult, inventoryResult] = await Promise.allSettled([
        api.storageStatus().then(requireWorkspaceRecoveryResult),
        workspaceId
          ? api.status(workspaceId).then(requireWorkspaceRecoveryResult)
          : Promise.resolve(null),
        api.listStorageWorkspaces().then(requireWorkspaceRecoveryResult),
      ]);
      if (globalResult.status === 'fulfilled') {
        const next = globalResult.value.storage;
        setGlobalStatus(next);
        setGlobalStorageMode(next.location.mode);
        setGlobalCustomRoot(next.location.mode === 'custom' ? next.location.customRoot : '');
      } else {
        setGlobalStatus(null);
        setGlobalError(globalResult.reason instanceof Error ? globalResult.reason.message : String(globalResult.reason));
      }
      if (workspaceResult.status === 'fulfilled') {
        const next = workspaceResult.value;
        setStatus(next);
        if (next) {
          setStorageMode(next.storage.locationSource === 'workspace' ? next.storage.location.mode : 'inherit');
          setCustomRoot(
            next.storage.locationSource === 'workspace' && next.storage.location.mode === 'custom'
              ? next.storage.location.customRoot
              : '',
          );
        } else {
          setStorageMode('inherit');
          setCustomRoot('');
        }
      } else {
        setStatus(null);
        setError(workspaceResult.reason instanceof Error ? workspaceResult.reason.message : String(workspaceResult.reason));
      }
      if (inventoryResult.status === 'fulfilled') {
        setStorageWorkspaces(inventoryResult.value.workspaces);
      } else {
        setStorageWorkspaces([]);
        setMaintenanceError(inventoryResult.reason instanceof Error
          ? inventoryResult.reason.message
          : String(inventoryResult.reason));
      }
    } catch (cause) {
      setGlobalStatus(null);
      setStorageWorkspaces([]);
      setStatus(null);
      setGlobalError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  const saveGlobalStorage = React.useCallback(async () => {
    if (globalStorageMode === 'custom' && !globalCustomRoot.trim()) return;
    setBusy('global');
    try {
      requireWorkspaceRecoveryResult(
        await getWorkspaceRecoveryAPI().setDefaultStorageLocation(
          storageLocation(globalStorageMode, globalCustomRoot),
        ),
      );
      toast.success(t('settings.piarium.recovery.storage.globalSaved'));
      await refresh();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  }, [globalCustomRoot, globalStorageMode, refresh, t]);

  const moveStorage = React.useCallback(async () => {
    if (!workspaceId || (storageMode === 'custom' && !customRoot.trim())) return;
    setBusy('move');
    try {
      const api = getWorkspaceRecoveryAPI();
      if (storageMode === 'inherit') {
        requireWorkspaceRecoveryResult(await api.clearStorageLocationOverride(workspaceId));
      } else {
        requireWorkspaceRecoveryResult(await api.setStorageLocation({
          location: storageLocation(storageMode, customRoot),
          workspaceId,
        }));
      }
      toast.success(t('settings.piarium.recovery.storage.moveComplete'));
      await refresh();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  }, [customRoot, refresh, storageMode, t, workspaceId]);

  const chooseStorageFolder = React.useCallback(async (target: StoragePickerTarget) => {
    const currentPath = target === 'global' ? globalCustomRoot : customRoot;
    if (canRequestNativeDirectoryAccess()) {
      const selected = await requestDirectoryAccess(currentPath, {
        title: t('settings.piarium.recovery.storage.folderPickerTitle'),
      });
      if (selected.success && selected.path) {
        if (target === 'global') setGlobalCustomRoot(selected.path);
        else setCustomRoot(selected.path);
      }
      return;
    }
    setPickerTarget(target);
  }, [customRoot, globalCustomRoot, t]);

  const maintainStorageWorkspaces = React.useCallback(async (
    action: 'cleanup' | 'migrate',
    targets: RecoveryStorageWorkspaceSummary[],
  ) => {
    if (targets.length === 0) return;
    setMaintenanceBusy(`${action}:${targets.length === 1 ? targets[0].workspaceId : 'all'}`);
    setMaintenanceError(null);
    try {
      const api = getWorkspaceRecoveryAPI();
      const results = await Promise.allSettled(targets.map(async (workspace) => {
        if (action === 'migrate') {
          const moved = requireWorkspaceRecoveryResult(
            await api.clearStorageLocationOverride(workspace.workspaceId),
          );
          if (moved.operation.state !== 'complete') {
            throw new Error(moved.operation.failure?.message || t('settings.piarium.recovery.storage.maintenanceFailed'));
          }
          return 0;
        }
        const cleaned = requireWorkspaceRecoveryResult(
          await api.cleanupStorage({ workspaceId: workspace.workspaceId }),
        );
        if (cleaned.result.status !== 'complete') {
          throw new Error(cleaned.result.failures[0]?.message || t('settings.piarium.recovery.storage.maintenanceFailed'));
        }
        return cleaned.result.byteLengthReclaimed;
      }));
      const failed = results.filter((result) => result.status === 'rejected');
      if (failed.length > 0) {
        const first = failed[0].status === 'rejected' ? failed[0].reason : null;
        const summary = t('settings.piarium.recovery.storage.maintenancePartial', {
          failed: failed.length,
          total: targets.length,
        });
        const detail = first instanceof Error ? first.message : first ? String(first) : '';
        throw new Error(detail ? `${summary}: ${detail}` : summary, { cause: first });
      }
      const reclaimedBytes = results.reduce((total, result) => (
        result.status === 'fulfilled' ? total + result.value : total
      ), 0);
      toast.success(t(
        action === 'migrate'
          ? 'settings.piarium.recovery.storage.migrateComplete'
          : 'settings.piarium.recovery.storage.cleanupAllComplete',
        { bytes: formatWorkspaceArchiveBytes(reclaimedBytes), count: targets.length },
      ));
      await refresh();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setMaintenanceError(message);
      toast.error(message);
    } finally {
      setMaintenanceBusy(null);
    }
  }, [refresh, t]);

  const deleteStoredWorkspaceHistory = React.useCallback(async (workspace: RecoveryStorageWorkspaceSummary) => {
    if (typeof window === 'undefined'
      || !window.confirm(t('settings.piarium.recovery.storage.deleteStoredConfirm', {
        path: workspace.canonicalRoot,
      }))) return;
    setMaintenanceBusy(`delete:${workspace.workspaceId}`);
    setMaintenanceError(null);
    try {
      const result = requireWorkspaceRecoveryResult(
        await getWorkspaceRecoveryAPI().deleteWorkspaceHistory(workspace.workspaceId),
      );
      if (result.result.status !== 'complete') {
        throw new Error(result.result.failures[0]?.message || t('settings.piarium.recovery.storage.maintenanceFailed'));
      }
      toast.success(t('settings.piarium.recovery.storage.deleteComplete'));
      await refresh();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setMaintenanceError(message);
      toast.error(message);
    } finally {
      setMaintenanceBusy(null);
    }
  }, [refresh, t]);

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

  const visibleStorageWorkspaces = React.useMemo(() => storageWorkspaces.filter((workspace) => (
    workspace.checkpointCount > 0
    || workspace.objectCount > 0
    || workspace.locationSource === 'workspace'
  )), [storageWorkspaces]);
  const migratableStorageWorkspaces = React.useMemo(() => visibleStorageWorkspaces.filter((workspace) => (
    workspace.locationSource === 'global'
    && workspace.migrationRequired
    && workspace.workspaceAvailable
    && workspace.storageAvailable
  )), [visibleStorageWorkspaces]);
  const cleanableStorageWorkspaces = React.useMemo(() => visibleStorageWorkspaces.filter((workspace) => (
    workspace.storageAvailable
    && (workspace.checkpointCount > 0 || workspace.objectCount > 0)
  )), [visibleStorageWorkspaces]);

  const selectedLocation = status?.storage.location;
  const globalLocationChanged = globalStatus
    ? globalStatus.location.mode !== globalStorageMode
      || (globalStorageMode === 'custom' && globalStatus.location.mode === 'custom'
        && globalStatus.location.customRoot !== globalCustomRoot.trim())
    : false;
  const locationChanged = selectedLocation
    ? storageMode === 'inherit'
      ? status?.storage.locationSource !== 'global'
      : status?.storage.locationSource !== 'workspace'
        || selectedLocation.mode !== storageMode
        || (storageMode === 'custom' && selectedLocation.mode === 'custom'
          && selectedLocation.customRoot !== customRoot.trim())
    : false;

  return (
    <>
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

        <div className="space-y-3 rounded-xl border border-border/60 p-3">
          <div>
            <h4 className="typography-ui-label font-medium text-foreground">
              {t('settings.piarium.recovery.storage.globalTitle')}
            </h4>
            <p className="mt-1 typography-meta text-muted-foreground">
              {t('settings.piarium.recovery.storage.globalDescription')}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {STORAGE_MODES.map((option) => (
              <Button
                key={option.mode}
                type="button"
                variant="chip"
                size="sm"
                aria-pressed={globalStorageMode === option.mode}
                onClick={() => setGlobalStorageMode(option.mode)}
              >
                {t(option.labelKey)}
              </Button>
            ))}
          </div>
          {globalStorageMode === 'custom' ? (
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                value={globalCustomRoot}
                onChange={(event) => setGlobalCustomRoot(event.target.value)}
                placeholder={t('settings.piarium.recovery.storage.customPlaceholder')}
                className="min-w-0 flex-1 font-mono typography-meta"
              />
              <Button type="button" variant="outline" size="sm" className="shrink-0" onClick={() => void chooseStorageFolder('global')}>
                <Icon name="folder" className="size-3.5" />
                {t('settings.piarium.recovery.storage.chooseFolder')}
              </Button>
            </div>
          ) : null}
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!globalLocationChanged || busy !== null || (globalStorageMode === 'custom' && !globalCustomRoot.trim())}
            onClick={() => void saveGlobalStorage()}
          >
            {busy === 'global'
              ? t('settings.piarium.recovery.storage.savingGlobal')
              : t('settings.piarium.recovery.storage.saveGlobal')}
          </Button>
        </div>

        {globalError ? (
          <div className="rounded-xl border border-[var(--status-error-border)] bg-[var(--status-error-background)] p-3 typography-meta text-[var(--status-error)]">
            {globalError}
          </div>
        ) : null}

        <div className="space-y-3 rounded-xl border border-border/60 p-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h4 className="typography-ui-label font-medium text-foreground">
                {t('settings.piarium.recovery.storage.managerTitle')}
              </h4>
              <p className="mt-1 typography-meta text-muted-foreground">
                {t('settings.piarium.recovery.storage.managerDescription')}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={maintenanceBusy !== null || migratableStorageWorkspaces.length === 0}
                onClick={() => void maintainStorageWorkspaces('migrate', migratableStorageWorkspaces)}
              >
                {t('settings.piarium.recovery.storage.migrateAll')}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={maintenanceBusy !== null || cleanableStorageWorkspaces.length === 0}
                onClick={() => void maintainStorageWorkspaces('cleanup', cleanableStorageWorkspaces)}
              >
                {t('settings.piarium.recovery.storage.cleanupAll')}
              </Button>
            </div>
          </div>

          {visibleStorageWorkspaces.length === 0 ? (
            <p className="rounded-lg bg-muted/20 px-3 py-2 typography-meta text-muted-foreground">
              {t('settings.piarium.recovery.storage.managerEmpty')}
            </p>
          ) : (
            <div className="divide-y divide-border/60 overflow-hidden rounded-lg border border-border/60">
              {visibleStorageWorkspaces.map((workspace) => {
                const rowBusy = maintenanceBusy?.endsWith(workspace.workspaceId) === true;
                return (
                  <div key={workspace.workspaceId} className="space-y-2 p-3">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate font-mono typography-meta text-foreground" title={workspace.canonicalRoot}>
                          {workspace.canonicalRoot}
                        </p>
                        <p className="mt-1 typography-micro text-muted-foreground">
                          {workspace.lastActivityAt
                            ? t('settings.piarium.recovery.storage.lastActivity', {
                              time: new Date(workspace.lastActivityAt).toLocaleString(),
                            })
                            : t('settings.piarium.recovery.storage.neverUsed')}
                          {' · '}
                          {t('settings.piarium.recovery.storage.checkpointCount', { count: workspace.checkpointCount })}
                          {' · '}
                          {formatWorkspaceArchiveBytes(workspace.byteLength)}
                        </p>
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {workspace.locationSource === 'workspace' ? (
                          <span className="rounded-full bg-muted px-2 py-0.5 typography-micro text-muted-foreground">
                            {t('settings.piarium.recovery.storage.projectOverride')}
                          </span>
                        ) : null}
                        {workspace.migrationRequired ? (
                          <span className="rounded-full bg-[var(--status-warning-background)] px-2 py-0.5 typography-micro text-[var(--status-warning)]">
                            {t('settings.piarium.recovery.storage.migrationPending')}
                          </span>
                        ) : null}
                        {!workspace.workspaceAvailable ? (
                          <span className="rounded-full bg-[var(--status-error-background)] px-2 py-0.5 typography-micro text-[var(--status-error)]">
                            {t('settings.piarium.recovery.storage.workspaceOffline')}
                          </span>
                        ) : null}
                        {!workspace.storageAvailable ? (
                          <span className="rounded-full bg-[var(--status-error-background)] px-2 py-0.5 typography-micro text-[var(--status-error)]">
                            {t('settings.piarium.recovery.storage.storageUnavailable')}
                          </span>
                        ) : null}
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {workspace.locationSource === 'global' && workspace.migrationRequired ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="xs"
                          disabled={maintenanceBusy !== null
                            || !workspace.workspaceAvailable
                            || !workspace.storageAvailable}
                          onClick={() => void maintainStorageWorkspaces('migrate', [workspace])}
                        >
                          {t('settings.piarium.recovery.storage.migrateOne')}
                        </Button>
                      ) : null}
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        disabled={maintenanceBusy !== null
                          || !workspace.storageAvailable
                          || (workspace.checkpointCount === 0 && workspace.objectCount === 0)}
                        onClick={() => void maintainStorageWorkspaces('cleanup', [workspace])}
                      >
                        {t('settings.piarium.recovery.storage.cleanupOne')}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        disabled={maintenanceBusy !== null
                          || !workspace.storageAvailable
                          || (workspace.checkpointCount === 0 && workspace.objectCount === 0)}
                        className="text-[var(--status-error)] hover:text-[var(--status-error)]"
                        onClick={() => void deleteStoredWorkspaceHistory(workspace)}
                      >
                        {rowBusy
                          ? t('settings.piarium.recovery.storage.working')
                          : t('settings.piarium.recovery.storage.deleteStored')}
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {maintenanceError ? (
          <div className="rounded-xl border border-[var(--status-error-border)] bg-[var(--status-error-background)] p-3 typography-meta text-[var(--status-error)]">
            {maintenanceError}
          </div>
        ) : null}

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
                <p className="typography-micro text-muted-foreground">{t('settings.piarium.recovery.storage.checkpoints')}</p>
                <p className="mt-1 typography-ui-label tabular-nums">{status.storage.checkpointCount}</p>
              </div>
              <div>
                <p className="typography-micro text-muted-foreground">{t('settings.piarium.recovery.storage.readyCheckpoints')}</p>
                <p className="mt-1 typography-ui-label tabular-nums">{status.storage.readyCheckpointCount}</p>
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
                {t('settings.piarium.recovery.storage.projectTitle')}
              </h4>
              <p className="mt-1 typography-meta text-muted-foreground">
                {t('settings.piarium.recovery.storage.projectDescription')}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="chip"
                size="sm"
                aria-pressed={storageMode === 'inherit'}
                onClick={() => setStorageMode('inherit')}
              >
                {t('settings.piarium.recovery.storage.inheritGlobal')}
              </Button>
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
              <div className="flex flex-col gap-2 sm:flex-row">
                <Input
                  value={customRoot}
                  onChange={(event) => setCustomRoot(event.target.value)}
                  placeholder={t('settings.piarium.recovery.storage.customPlaceholder')}
                  className="min-w-0 flex-1 font-mono typography-meta"
                />
                <Button type="button" variant="outline" size="sm" className="shrink-0" onClick={() => void chooseStorageFolder('workspace')}>
                  <Icon name="folder" className="size-3.5" />
                  {t('settings.piarium.recovery.storage.chooseFolder')}
                </Button>
              </div>
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
                disabled={busy !== null || status.storage.checkpointCount === 0}
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
      <DirectoryExplorerDialog
        open={pickerTarget !== null}
        onOpenChange={(open) => { if (!open) setPickerTarget(null); }}
        mode="select-directory"
        initialPath={pickerTarget === 'global' ? globalCustomRoot : customRoot}
        title={t('settings.piarium.recovery.storage.folderPickerTitle')}
        description={t('settings.piarium.recovery.storage.folderPickerDescription')}
        confirmLabel={t('settings.piarium.recovery.storage.chooseFolder')}
        onSelectDirectory={(selected) => {
          if (pickerTarget === 'global') setGlobalCustomRoot(selected);
          else if (pickerTarget === 'workspace') setCustomRoot(selected);
        }}
      />
    </>
  );
};
