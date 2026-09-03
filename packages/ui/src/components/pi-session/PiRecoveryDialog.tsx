import React from 'react';
import type {
  WorkspaceCombinedRecoveryOperation,
  WorkspaceCombinedRecoveryPlan,
} from '@piarium/extension-contract';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useI18n } from '@/lib/i18n';
import {
  getWorkspaceRecoveryAPI,
  requireWorkspaceRecoveryResult,
} from '@/lib/recovery/workspaceRecovery';

interface PiRecoveryDialogProps {
  open: boolean;
  plan: WorkspaceCombinedRecoveryPlan;
  onClose(): void;
  onCombinedResult(operation: WorkspaceCombinedRecoveryOperation): void | Promise<void>;
  onConversationOnly(): void | Promise<void>;
}

export const PiRecoveryDialog: React.FC<PiRecoveryDialogProps> = ({
  open,
  plan,
  onClose,
  onCombinedResult,
  onConversationOnly,
}) => {
  const { t } = useI18n();
  const [phase, setPhase] = React.useState<'ready' | 'applying' | 'failed'>('ready');
  const [failure, setFailure] = React.useState<string | null>(null);
  const startedRef = React.useRef(false);

  React.useEffect(() => () => {
    if (!startedRef.current) {
      void getWorkspaceRecoveryAPI().cancelCombinedOperation(plan.id).catch(() => undefined);
    }
  }, [plan.id]);

  const runConversationOnly = React.useCallback(async () => {
    if (phase === 'applying') return;
    setPhase('applying');
    await getWorkspaceRecoveryAPI().cancelCombinedOperation(plan.id).catch(() => undefined);
    try {
      await onConversationOnly();
      onClose();
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
      setPhase('failed');
    }
  }, [onClose, onConversationOnly, phase, plan.id]);

  const canRestoreFiles = plan.coverage === 'ready' || plan.coverage === 'partial';

  const runCombined = React.useCallback(async () => {
    if (phase === 'applying' || !canRestoreFiles) return;
    startedRef.current = true;
    setFailure(null);
    setPhase('applying');
    try {
      const result = requireWorkspaceRecoveryResult(
        await getWorkspaceRecoveryAPI().applyCombinedRecovery({
          confirmedConflicts: plan.conflicts.map((conflict) => ({
            fingerprint: conflict.fingerprint,
            path: conflict.path,
          })),
          conflictPolicy: plan.conflicts.length > 0 ? 'overwrite-confirmed' : 'abort',
          expectedRevision: plan.revision,
          operationId: plan.id,
        }),
      );
      if (result.operation.state !== 'complete') {
        throw new Error(result.operation.failure?.message ?? result.operation.state);
      }
      await onCombinedResult(result.operation);
      onClose();
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
      setPhase('failed');
    }
  }, [canRestoreFiles, onClose, onCombinedResult, phase, plan]);

  const close = React.useCallback(() => {
    if (phase !== 'applying') onClose();
  }, [onClose, phase]);

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) close(); }}>
      <DialogContent showCloseButton={phase !== 'applying'} className="max-w-md gap-4">
        <DialogHeader>
          <DialogTitle>{t('chat.recoveryDialog.title')}</DialogTitle>
          <DialogDescription>{t('chat.recoveryDialog.description')}</DialogDescription>
        </DialogHeader>

        {plan.coverage === 'partial' ? (
          <div className="rounded-xl border border-[var(--status-warning-border)] bg-[var(--status-warning-background)] px-3 py-2 typography-meta text-[var(--status-warning)]">
            {t('chat.recoveryDialog.partialCoverage')}
            {plan.uncoveredPaths.length > 0 ? (
              <ul className="mt-1 list-disc pl-4">
                {plan.uncoveredPaths.map((entry) => (
                  <li key={entry.path} className="break-all">
                    {entry.path}
                    {entry.source === 'shell' ? ` (${t('chat.recoveryDialog.sourceShell')})`
                      : entry.source === 'external' ? ` (${t('chat.recoveryDialog.sourceExternal')})`
                      : ''}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}

        {plan.coverage === 'none' ? (
          <div className="rounded-xl border border-[var(--status-warning-border)] bg-[var(--status-warning-background)] px-3 py-2 typography-meta text-[var(--status-warning)]">
            {t('chat.recoveryDialog.noCoverage')}
            {plan.uncoveredPaths.length > 0 ? (
              <ul className="mt-1 list-disc pl-4">
                {plan.uncoveredPaths.map((entry) => (
                  <li key={entry.path} className="break-all">
                    {entry.path}
                    {entry.source === 'shell' ? ` (${t('chat.recoveryDialog.sourceShell')})`
                      : entry.source === 'external' ? ` (${t('chat.recoveryDialog.sourceExternal')})`
                      : ''}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}

        {plan.conflicts.length > 0 ? (
          <div className="max-h-48 overflow-y-auto rounded-xl border border-[var(--status-warning-border)] bg-[var(--status-warning-background)] p-3">
            <p className="typography-ui-label font-medium text-[var(--status-warning)]">
              {t('chat.recoveryDialog.reviewRequired')}
            </p>
            <ul className="mt-2 space-y-1 typography-meta text-[var(--status-warning)]">
              {plan.conflicts.map((conflict) => (
                <li key={`${conflict.kind}:${conflict.path}`} className="break-all">
                  {conflict.path}: {conflict.message}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {phase === 'applying' ? (
          <div className="flex min-h-20 items-center justify-center gap-2 text-muted-foreground" aria-busy="true">
            <Icon name="loader-4" className="size-4 animate-spin" />
            <span className="typography-ui-label">{t('chat.recoveryDialog.applying')}</span>
          </div>
        ) : (
          <div className="grid gap-2">
            {canRestoreFiles ? (
              <button
                type="button"
                onClick={() => void runCombined()}
                className="rounded-xl border border-border px-3 py-3 text-left transition-colors hover:bg-interactive-hover/50"
              >
                <span className="block typography-ui-label font-medium text-foreground">
                  {t('settings.piarium.recovery.preference.both.label')}
                </span>
                <span className="mt-1 block typography-meta text-muted-foreground">
                  {plan.conflicts.length > 0
                    ? t('chat.recoveryDialog.reviewRequired')
                    : t('settings.piarium.recovery.preference.both.description')}
                </span>
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => void runConversationOnly()}
              className="rounded-xl border border-border px-3 py-3 text-left transition-colors hover:bg-interactive-hover/50"
            >
              <span className="block typography-ui-label font-medium text-foreground">
                {t('settings.piarium.recovery.preference.conversation.label')}
              </span>
              <span className="mt-1 block typography-meta text-muted-foreground">
                {t('settings.piarium.recovery.preference.conversation.description')}
              </span>
            </button>
          </div>
        )}

        {failure ? (
          <div className="rounded-xl border border-[var(--status-error-border)] bg-[var(--status-error-background)] p-3 typography-meta text-[var(--status-error)]">
            {failure}
          </div>
        ) : null}

        <DialogFooter>
          {phase === 'failed' && canRestoreFiles ? (
            <Button type="button" onClick={() => void runCombined()}>
              {t('chat.recoveryDialog.retry')}
            </Button>
          ) : null}
          <Button type="button" variant="outline" onClick={close} disabled={phase === 'applying'}>
            {t('sessions.sidebar.dialogs.cancel')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
