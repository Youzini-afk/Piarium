import React from 'react';
import type {
  WorkspaceCombinedRecoveryOperation,
  WorkspaceRecoveryCheckpointSummary,
  WorkspaceRecoveryStatus,
} from '@piarium/extension-contract';
import { Icon } from '@/components/icon/Icon';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useI18n } from '@/lib/i18n';
import {
  getWorkspaceRecoveryAPI,
  requireWorkspaceRecoveryResult,
} from '@/lib/recovery/workspaceRecovery';
import { cn } from '@/lib/utils';
import { formatWorkspaceArchiveBytes } from '@/lib/workspaceArchive';
import { usePiSessionStore } from '@/stores/usePiSessionStore';
import { useUIStore } from '@/stores/useUIStore';

const operationTone = (operation: WorkspaceCombinedRecoveryOperation): string => {
  if (operation.state === 'complete') {
    return 'text-[var(--status-success)]';
  }
  if (operation.state === 'compensated') return 'text-[var(--status-warning)]';
  if (operation.state === 'needs-attention') return 'text-[var(--status-error)]';
  return 'text-[var(--status-info)]';
};

const checkpointTitle = (checkpoint: WorkspaceRecoveryCheckpointSummary): string => (
  checkpoint.label?.trim() || checkpoint.source
);

export const PiRecoveryPanel: React.FC = () => {
  const { t } = useI18n();
  const sessionId = usePiSessionStore((state) => state.currentSessionId);
  const snapshot = usePiSessionStore((state) => (
    state.currentSessionId ? state.records[state.currentSessionId]?.snapshot : undefined
  ));
  const refreshEntries = usePiSessionStore((state) => state.refreshEntries);
  const setSettingsDialogOpen = useUIStore((state) => state.setSettingsDialogOpen);
  const setSettingsPage = useUIStore((state) => state.setSettingsPage);
  const workspaceId = snapshot?.workspace?.kind === 'workspace'
    ? snapshot.workspace.authorityId ?? snapshot.workspace.id
    : null;
  const [status, setStatus] = React.useState<WorkspaceRecoveryStatus | null>(null);
  const [checkpoints, setCheckpoints] = React.useState<WorkspaceRecoveryCheckpointSummary[]>([]);
  const [operations, setOperations] = React.useState<WorkspaceCombinedRecoveryOperation[]>([]);
  const [checkpointName, setCheckpointName] = React.useState('');
  const [busy, setBusy] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const refresh = React.useCallback(async () => {
    if (!workspaceId) {
      setStatus(null);
      setCheckpoints([]);
      setOperations([]);
      return;
    }
    setBusy('refresh');
    setError(null);
    try {
      const api = getWorkspaceRecoveryAPI();
      const [nextStatus, nextCheckpoints, nextOperations] = await Promise.all([
        api.status(workspaceId),
        api.listCheckpoints({ workspaceId }),
        api.listCombinedOperations(workspaceId),
      ]);
      setStatus(requireWorkspaceRecoveryResult(nextStatus));
      setCheckpoints(requireWorkspaceRecoveryResult(nextCheckpoints).page.checkpoints);
      setOperations(requireWorkspaceRecoveryResult(nextOperations).operations);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  }, [workspaceId]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  const createCheckpoint = React.useCallback(async () => {
    if (!workspaceId || !checkpointName.trim() || busy) return;
    setBusy('checkpoint');
    try {
      requireWorkspaceRecoveryResult(await getWorkspaceRecoveryAPI().createCheckpoint({
        name: checkpointName.trim(),
        workspaceId,
      }));
      setCheckpointName('');
      toast.success(t('contextPanel.recovery.toast.applied', { provider: 'piarium.builtin.recovery' }));
      await refresh();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  }, [busy, checkpointName, refresh, t, workspaceId]);

  const undo = React.useCallback(async (operation: WorkspaceCombinedRecoveryOperation) => {
    if (!workspaceId || busy || typeof window === 'undefined') return;
    if (!window.confirm(t('contextPanel.recovery.native.undoConfirm'))) return;
    setBusy(operation.id);
    try {
      const api = getWorkspaceRecoveryAPI();
      const prepared = requireWorkspaceRecoveryResult(await api.prepareCombinedUndo(operation.id));
      const result = requireWorkspaceRecoveryResult(await api.applyCombinedRecovery({
        confirmedConflicts: [],
        conflictPolicy: 'abort',
        expectedRevision: prepared.plan.revision,
        operationId: prepared.plan.id,
      }));
      if (result.operation.state !== 'complete') {
        throw new Error(result.operation.failure?.message ?? result.operation.state);
      }
      if (sessionId) await refreshEntries(sessionId).catch(() => undefined);
      toast.success(t('contextPanel.recovery.native.undoComplete'));
      await refresh();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  }, [busy, refresh, refreshEntries, sessionId, t, workspaceId]);

  if (!sessionId || !snapshot || !workspaceId) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <Icon name="history" className="size-10 text-muted-foreground/50" />
        <p className="typography-ui-label text-muted-foreground">
          {t('contextPanel.recovery.native.openWorkspace')}
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto bg-background">
      <div className="flex items-start gap-3 border-b border-border/60 px-4 py-4">
        <div className="min-w-0 flex-1">
          <h2 className="typography-ui-header text-foreground">{t('contextPanel.mode.recovery')}</h2>
          <p className="mt-1 typography-meta text-muted-foreground">
            {t('contextPanel.recovery.native.description')}
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={() => void refresh()}
          disabled={busy !== null}
          aria-label={t('settings.piarium.recovery.actions.refresh')}
          title={t('settings.piarium.recovery.actions.refresh')}
        >
          <Icon name="refresh" className={cn('size-4', busy === 'refresh' && 'animate-spin')} />
        </Button>
      </div>

      <div className="space-y-6 px-4 py-5">
        {status ? (
          <section className="rounded-xl border border-border/60 bg-muted/15 p-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="typography-ui-label font-medium text-foreground">piarium.builtin.recovery</p>
                <p className="mt-1 typography-micro text-muted-foreground">
                  {status.storage.location.mode} · {status.storage.state}
                </p>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => {
                  setSettingsPage('sessions');
                  setSettingsDialogOpen(true);
                }}
              >
                {t('settings.piarium.recovery.actions.configure')}
              </Button>
            </div>
            <div className="mt-3 grid grid-cols-3 gap-2">
              <div>
                <p className="typography-micro text-muted-foreground">{t('settings.piarium.recovery.storage.checkpoints')}</p>
                <p className="mt-1 typography-ui-label tabular-nums">{status.storage.checkpointCount}</p>
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
          </section>
        ) : null}

        <section>
          <h3 className="typography-ui-label font-medium text-foreground">
            {t('contextPanel.recovery.actions.checkpoint')}
          </h3>
          <p className="mt-1 typography-meta text-muted-foreground">
            {t('contextPanel.recovery.native.checkpointDescription')}
          </p>
          <div className="mt-3 flex gap-2">
            <Input
              value={checkpointName}
              onChange={(event) => setCheckpointName(event.target.value)}
              placeholder={t('contextPanel.recovery.checkpoint.placeholder')}
              disabled={busy !== null}
              onKeyDown={(event) => {
                if (event.key !== 'Enter') return;
                event.preventDefault();
                void createCheckpoint();
              }}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy !== null || !checkpointName.trim()}
              onClick={() => void createCheckpoint()}
            >
              <Icon name="save-3" className="size-4" />
              {t('contextPanel.recovery.actions.checkpoint')}
            </Button>
          </div>
        </section>

        <section className="border-t border-border/60 pt-5">
          <h3 className="typography-ui-label font-medium text-foreground">
            {t('contextPanel.recovery.native.operations')}
          </h3>
          <div className="mt-3 space-y-2">
            {operations.map((operation) => (
              <div key={operation.id} className="rounded-xl border border-border/60 p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate typography-ui-label font-medium text-foreground">
                      {operation.undoOf
                        ? t('contextPanel.recovery.native.undoOperation')
                        : t('contextPanel.recovery.native.combinedOperation')}
                    </p>
                    <p className={cn('mt-1 typography-micro', operationTone(operation))}>
                      {operation.state} · {operation.fileState} · {operation.conversationState}
                    </p>
                  </div>
                  {operation.state === 'complete' ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="xs"
                      disabled={busy !== null}
                      onClick={() => void undo(operation)}
                    >
                      {t('contextPanel.recovery.actions.undo')}
                    </Button>
                  ) : null}
                </div>
                {operation.failure ? (
                  <p className="mt-2 typography-meta text-[var(--status-error)]">{operation.failure.message}</p>
                ) : null}
              </div>
            ))}
            {operations.length === 0 ? (
              <p className="py-2 typography-meta text-muted-foreground">
                {t('contextPanel.recovery.native.noOperations')}
              </p>
            ) : null}
          </div>
        </section>

        <section className="border-t border-border/60 pt-5">
          <h3 className="typography-ui-label font-medium text-foreground">
            {t('contextPanel.recovery.native.timeline')}
          </h3>
          <div className="mt-3 space-y-2">
            {checkpoints.map((item) => (
              <div key={item.id} className="rounded-xl border border-border/60 p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate typography-ui-label text-foreground">{checkpointTitle(item)}</p>
                    <p className="mt-1 typography-micro text-muted-foreground">
                      {item.source} · {item.state} · {new Date(item.createdAt).toLocaleString()}
                    </p>
                  </div>
                  <span className="shrink-0 typography-micro tabular-nums text-muted-foreground">
                    {formatWorkspaceArchiveBytes(item.byteLength)}
                  </span>
                </div>
                <p className="mt-2 typography-micro text-muted-foreground">
                  {item.changedPathCount} {t('chat.recoveryDialog.filesAffected')}
                </p>
              </div>
            ))}
            {checkpoints.length === 0 ? (
              <p className="py-2 typography-meta text-muted-foreground">
                {t('contextPanel.recovery.native.noCheckpoints')}
              </p>
            ) : null}
          </div>
        </section>

        {error ? (
          <div className="rounded-xl border border-[var(--status-error-border)] bg-[var(--status-error-background)] p-3 typography-meta text-[var(--status-error)]">
            {error}
          </div>
        ) : null}
      </div>
    </div>
  );
};
