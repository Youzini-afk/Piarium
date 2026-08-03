import React from 'react';
import type {
  RecoveryAction,
  RecoveryMode,
  RecoveryOperationResult,
  RecoveryRepairAction,
} from '@piarium/protocol';
import { Icon } from '@/components/icon/Icon';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useI18n } from '@/lib/i18n';
import { supportsPiRecoveryAction } from '@/lib/pi-runtime/recovery';
import { cn } from '@/lib/utils';
import { usePiDraftStore } from '@/stores/usePiDraftStore';
import { usePiSessionStore } from '@/stores/usePiSessionStore';
import { useUIStore } from '@/stores/useUIStore';

type BusyAction = RecoveryAction | 'refresh' | null;

const errorMessage = (error: unknown): string => (
  error instanceof Error ? error.message : String(error)
);

export const PiRecoveryPanel: React.FC = () => {
  const { t } = useI18n();
  const sessionId = usePiSessionStore((state) => state.currentSessionId);
  const record = usePiSessionStore((state) => (
    state.currentSessionId === null ? undefined : state.records[state.currentSessionId]
  ));
  const refreshStatus = usePiSessionStore((state) => state.refreshRecoveryStatus);
  const undoRecovery = usePiSessionStore((state) => state.undoRecovery);
  const redoRecovery = usePiSessionStore((state) => state.redoRecovery);
  const createCheckpoint = usePiSessionStore((state) => state.createRecoveryCheckpoint);
  const repairRecovery = usePiSessionStore((state) => state.repairRecovery);
  const setDraft = usePiDraftStore((state) => state.setDraft);
  const recoveryPreference = useUIStore((state) => state.recoveryPreference);
  const setSettingsDialogOpen = useUIStore((state) => state.setSettingsDialogOpen);
  const setSettingsPage = useUIStore((state) => state.setSettingsPage);
  const [mode, setMode] = React.useState<Exclude<RecoveryMode, 'files'>>(
    recoveryPreference === 'both' ? 'both' : 'conversation',
  );
  const [busyAction, setBusyAction] = React.useState<BusyAction>(null);
  const [checkpointName, setCheckpointName] = React.useState('');
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [confirmDestructive, setConfirmDestructive] = React.useState(false);

  const status = record?.recoveryStatus;
  const snapshot = record?.snapshot;
  const supportsUndo = supportsPiRecoveryAction(status, 'undo', mode);
  const supportsRedo = supportsPiRecoveryAction(status, 'redo', mode);
  const supportsCheckpoint = supportsPiRecoveryAction(status, 'checkpoint');
  const supportsRepair = supportsPiRecoveryAction(status, 'repair');
  const supportsTypoRepair = supportsPiRecoveryAction(status, 'repair-typo');
  const supportsDestructiveRepair = supportsPiRecoveryAction(status, 'repair-destructive');
  const combinedAvailable = supportsPiRecoveryAction(status, 'undo', 'both');
  const historyBusy = snapshot?.busy === true || snapshot?.isCompacting === true;

  React.useEffect(() => {
    setMode(recoveryPreference === 'both' ? 'both' : 'conversation');
  }, [recoveryPreference, sessionId]);

  const refresh = React.useCallback(async (showFailureToast: boolean) => {
    if (!sessionId) return;
    setBusyAction('refresh');
    setLoadError(null);
    try {
      await refreshStatus(sessionId);
    } catch (error) {
      const message = errorMessage(error);
      setLoadError(message);
      if (showFailureToast) {
        toast.error(t('contextPanel.recovery.toast.failed', { message }));
      }
    } finally {
      setBusyAction(null);
    }
  }, [refreshStatus, sessionId, t]);

  React.useEffect(() => {
    if (!sessionId) return;
    void refresh(false);
  }, [refresh, sessionId]);

  const applyEditor = React.useCallback((result: RecoveryOperationResult) => {
    if (!sessionId || (result.editorText === undefined && result.editorImages === undefined)) return;
    setDraft(sessionId, {
      ...(result.editorImages === undefined ? {} : { images: result.editorImages }),
      ...(result.editorText === undefined ? {} : { text: result.editorText }),
      instructions: undefined,
    });
  }, [sessionId, setDraft]);

  const run = React.useCallback(async (
    action: RecoveryAction,
    operation: () => Promise<RecoveryOperationResult>,
  ): Promise<RecoveryOperationResult | undefined> => {
    if (busyAction !== null) return undefined;
    setBusyAction(action);
    try {
      const result = await operation();
      applyEditor(result);
      if (result.outcome === 'applied') {
        toast.success(t('contextPanel.recovery.toast.applied', { provider: result.handledBy }));
      } else if (result.outcome === 'cancelled') {
        toast.info(t('contextPanel.recovery.toast.cancelled', { provider: result.handledBy }));
      } else {
        toast.info(t('contextPanel.recovery.toast.delegated', { provider: result.handledBy }));
      }
      return result;
    } catch (error) {
      toast.error(t('contextPanel.recovery.toast.failed', { message: errorMessage(error) }));
      return undefined;
    } finally {
      setBusyAction(null);
    }
  }, [applyEditor, busyAction, t]);

  const runRepair = React.useCallback((action: RecoveryRepairAction) => {
    if (!sessionId) return;
    const protocolAction: RecoveryAction = action === 'recover'
      ? 'repair'
      : action === 'recover-typo'
        ? 'repair-typo'
        : 'repair-destructive';
    void run(protocolAction, () => repairRecovery(sessionId, action));
  }, [repairRecovery, run, sessionId]);

  if (!sessionId || !snapshot) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <Icon name="history" className="size-10 text-muted-foreground/50" />
        <p className="typography-ui-label text-muted-foreground">
          {t('sessions.sidebar.empty.noSessions.description')}
        </p>
      </div>
    );
  }

  const actionDisabled = busyAction !== null;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto bg-background">
      <div className="flex items-start gap-3 border-b border-border/60 px-4 py-4">
        <div className="min-w-0 flex-1">
          <h2 className="typography-ui-header text-foreground">
            {t('contextPanel.mode.recovery')}
          </h2>
          <p className="mt-1 typography-meta text-muted-foreground">
            {t('settings.piarium.recovery.description')}
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={() => void refresh(true)}
          disabled={actionDisabled}
          aria-label={t('settings.piarium.recovery.actions.refresh')}
          title={t('settings.piarium.recovery.actions.refresh')}
        >
          <Icon name="refresh" className={cn('size-4', busyAction === 'refresh' && 'animate-spin')} />
        </Button>
      </div>

      <div className="space-y-6 px-4 py-5">
        <section>
          <h3 className="typography-ui-label font-medium text-foreground">
            {t('settings.piarium.recovery.preference.aria')}
          </h3>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              type="button"
              variant="chip"
              size="sm"
              aria-pressed={mode === 'conversation'}
              onClick={() => setMode('conversation')}
            >
              {t('settings.piarium.recovery.preference.conversation.label')}
            </Button>
            <Button
              type="button"
              variant="chip"
              size="sm"
              aria-pressed={mode === 'both'}
              onClick={() => setMode('both')}
            >
              {t('settings.piarium.recovery.preference.both.label')}
            </Button>
          </div>
          <p className="mt-2 typography-meta text-muted-foreground">
            {mode === 'conversation'
              ? t('settings.piarium.recovery.preference.conversation.description')
              : t('settings.piarium.recovery.preference.both.description')}
          </p>
          {mode === 'both' && !combinedAvailable ? (
            <div className="mt-3 rounded-lg border border-[var(--status-warning-border)] bg-[var(--status-warning-background)] px-3 py-2 typography-meta text-[var(--status-warning)]">
              {t('contextPanel.recovery.combinedUnavailable')}
            </div>
          ) : null}
          {historyBusy ? (
            <div className="mt-3 flex items-center gap-2 typography-meta text-muted-foreground">
              <Icon name="loader-4" className="size-3.5 animate-spin" />
              {t('contextPanel.recovery.sessionBusy')}
            </div>
          ) : null}
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={actionDisabled || historyBusy || !supportsUndo}
              onClick={() => void run('undo', () => undoRecovery(sessionId, mode))}
            >
              <Icon name="arrow-go-back" className="size-4" />
              {t('contextPanel.recovery.actions.undo')}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={actionDisabled || historyBusy || !supportsRedo}
              onClick={() => void run('redo', () => redoRecovery(sessionId, mode))}
            >
              <Icon name="arrow-go-forward" className="size-4" />
              {t('contextPanel.recovery.actions.redo')}
            </Button>
          </div>
        </section>

        <section className="border-t border-border/60 pt-5">
          <h3 className="typography-ui-label font-medium text-foreground">
            {t('contextPanel.recovery.actions.checkpoint')}
          </h3>
          <p className="mt-1 typography-meta text-muted-foreground">
            {t('settings.piarium.recovery.providers.workspaceHistory.description')}
          </p>
          <div className="mt-3 flex gap-2">
            <Input
              value={checkpointName}
              onChange={(event) => setCheckpointName(event.target.value)}
              placeholder={t('contextPanel.recovery.checkpoint.placeholder')}
              aria-label={t('contextPanel.recovery.checkpoint.placeholder')}
              disabled={actionDisabled || historyBusy || !supportsCheckpoint}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' || checkpointName.trim().length === 0) return;
                event.preventDefault();
                void run('checkpoint', () => createCheckpoint(sessionId, checkpointName.trim()))
                  .then((result) => { if (result) setCheckpointName(''); });
              }}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={actionDisabled || historyBusy || !supportsCheckpoint || checkpointName.trim().length === 0}
              onClick={() => {
                void run('checkpoint', () => createCheckpoint(sessionId, checkpointName.trim()))
                  .then((result) => { if (result) setCheckpointName(''); });
              }}
            >
              <Icon name="save-3" className="size-4" />
              {t('contextPanel.recovery.actions.checkpoint')}
            </Button>
          </div>
        </section>

        <section className="border-t border-border/60 pt-5">
          <h3 className="typography-ui-label font-medium text-foreground">
            {t('contextPanel.recovery.actions.repair')}
          </h3>
          <p className="mt-1 typography-meta text-muted-foreground">
            {t('settings.piarium.recovery.providers.wtf.description')}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={actionDisabled || !supportsRepair}
              onClick={() => runRepair('recover')}
            >
              {t('contextPanel.recovery.actions.repair')}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={actionDisabled || !supportsTypoRepair}
              onClick={() => runRepair('recover-typo')}
            >
              {t('contextPanel.recovery.actions.repairTypo')}
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              disabled={actionDisabled || !supportsDestructiveRepair}
              onClick={() => setConfirmDestructive(true)}
            >
              {t('contextPanel.recovery.actions.repairDestructive')}
            </Button>
          </div>
        </section>

        <section className="border-t border-border/60 pt-5">
          <div className="flex items-center justify-between gap-3">
            <h3 className="typography-ui-label font-medium text-foreground">
              {t('settings.piarium.recovery.providers.title')}
            </h3>
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
          {loadError ? (
            <div className="mt-3 rounded-lg border border-[var(--status-error-border)] bg-[var(--status-error-background)] px-3 py-2 typography-meta text-[var(--status-error)]">
              {loadError}
            </div>
          ) : null}
          {status?.issues.map((issue) => (
            <div key={issue} className="mt-3 rounded-lg border border-[var(--status-warning-border)] bg-[var(--status-warning-background)] px-3 py-2 typography-meta text-[var(--status-warning)]">
              {issue}
            </div>
          ))}
          <div className="mt-3 divide-y divide-border/60">
            {status?.providers.map((provider) => (
              <div key={provider.id} className="py-3 first:pt-0 last:pb-0">
                <div className="flex items-center gap-2">
                  <span
                    className={cn(
                      'size-2 shrink-0 rounded-full',
                      provider.active ? 'bg-[var(--status-success)]' : 'bg-muted-foreground/40',
                    )}
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1 truncate typography-ui-label text-foreground">
                    {provider.name}
                  </span>
                  <span className="typography-micro text-muted-foreground">
                    {provider.active
                      ? t('settings.piarium.recovery.status.active')
                      : t('settings.piarium.recovery.status.inactive')}
                  </span>
                </div>
                {provider.source ? (
                  <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground" title={provider.source}>
                    {provider.source}
                  </p>
                ) : null}
                <div className="mt-2 flex flex-wrap gap-1">
                  {[...provider.modes, ...provider.actions].map((capability) => (
                    <span key={capability} className="rounded-md bg-muted/60 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                      {capability}
                    </span>
                  ))}
                </div>
              </div>
            ))}
            {!status && busyAction === 'refresh' ? (
              <div className="flex items-center gap-2 py-3 typography-meta text-muted-foreground">
                <Icon name="loader-4" className="size-3.5 animate-spin" />
                {t('common.loading')}
              </div>
            ) : null}
          </div>
        </section>
      </div>

      <Dialog open={confirmDestructive} onOpenChange={setConfirmDestructive}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('contextPanel.recovery.actions.repairDestructive')}</DialogTitle>
            <DialogDescription>{t('contextPanel.recovery.destructive.description')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setConfirmDestructive(false)}>
              {t('sessions.sidebar.dialogs.cancel')}
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => {
                setConfirmDestructive(false);
                runRepair('recover-destructive');
              }}
            >
              {t('contextPanel.recovery.actions.repairDestructive')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};
