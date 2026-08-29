import React from 'react';
import type {
  WorkspaceCombinedRecoveryOperation,
  WorkspaceCombinedRecoveryPlan,
  WorkspaceRestoreMode,
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
import { Input } from '@/components/ui/input';
import { useI18n } from '@/lib/i18n';
import {
  getWorkspaceRecoveryAPI,
  requireWorkspaceRecoveryResult,
  WorkspaceRecoveryServiceError,
} from '@/lib/recovery/workspaceRecovery';
import { formatWorkspaceArchiveBytes } from '@/lib/workspaceArchive';
import { cn } from '@/lib/utils';

type DialogPhase = 'preparing' | 'ready' | 'applying' | 'failed';

interface PiRecoveryDialogProps {
  entryId: string;
  open: boolean;
  sessionId: string;
  workspaceId: string;
  onClose(): void;
  onCombinedResult(operation: WorkspaceCombinedRecoveryOperation): void | Promise<void>;
  onConversationOnly(): void | Promise<void>;
}

const operationProgress = (operation: WorkspaceCombinedRecoveryOperation | null): number | null => {
  if (!operation || !operation.workspaceTotalOperations) return null;
  return Math.min(100, Math.round(
    (operation.workspaceAppliedOperations ?? 0) / operation.workspaceTotalOperations * 100,
  ));
};

export const PiRecoveryDialog: React.FC<PiRecoveryDialogProps> = ({
  entryId,
  open,
  sessionId,
  workspaceId,
  onClose,
  onCombinedResult,
  onConversationOnly,
}) => {
  const { t } = useI18n();
  const [phase, setPhase] = React.useState<DialogPhase>('preparing');
  const [plan, setPlan] = React.useState<WorkspaceCombinedRecoveryPlan | null>(null);
  const [operation, setOperation] = React.useState<WorkspaceCombinedRecoveryOperation | null>(null);
  const [selectedMode, setSelectedMode] = React.useState<WorkspaceRestoreMode | null>(null);
  const [failure, setFailure] = React.useState<string | null>(null);
  const [failureCode, setFailureCode] = React.useState<string | null>(null);
  const [newWorkspacePath, setNewWorkspacePath] = React.useState('');
  const activePlanRef = React.useRef<string | null>(null);
  const startedPlansRef = React.useRef(new Set<string>());
  const generationRef = React.useRef(0);
  const applyInFlightRef = React.useRef(false);
  const friendlyFailure = React.useCallback((value: unknown): string => {
    const message = value instanceof Error ? value.message : String(value);
    return message.includes('Combined recovery mode changed after application started')
      ? t('chat.recoveryDialog.modeConflict')
      : message;
  }, [t]);

  const cancelPreparedPlan = React.useCallback(async (operationId: string | null) => {
    if (!operationId || startedPlansRef.current.has(operationId)) return;
    activePlanRef.current = activePlanRef.current === operationId ? null : activePlanRef.current;
    await getWorkspaceRecoveryAPI().cancelCombinedOperation(operationId).catch(() => undefined);
  }, []);

  const prepare = React.useCallback(async () => {
    const generation = ++generationRef.current;
    const previous = activePlanRef.current;
    activePlanRef.current = null;
    if (previous) await cancelPreparedPlan(previous);
    setPhase('preparing');
    setFailure(null);
    setFailureCode(null);
    setOperation(null);
    setSelectedMode(null);
    setPlan(null);
    try {
      const result = requireWorkspaceRecoveryResult(await getWorkspaceRecoveryAPI().prepareCombinedRecovery({
        entryId,
        sessionId,
        workspaceId,
      }));
      if (generation !== generationRef.current) {
        await cancelPreparedPlan(result.plan.id);
        return;
      }
      activePlanRef.current = result.plan.id;
      setPlan(result.plan);
      setSelectedMode(result.plan.restore.recommendedMode);
      setNewWorkspacePath(result.plan.restore.newWorkspacePath);
      setPhase('ready');
    } catch (error) {
      if (generation !== generationRef.current) return;
      if (error instanceof WorkspaceRecoveryServiceError) {
        setFailureCode(error.failure.code);
        setFailure(
          error.failure.code === 'snapshot-incomplete'
            ? t('chat.recoveryDialog.incompleteCheckpoint')
            : ['snapshot-unavailable', 'snapshot-missing'].includes(error.failure.code)
              ? t('chat.recoveryDialog.noCheckpoint')
              : friendlyFailure(error),
        );
      } else {
        setFailure(friendlyFailure(error));
      }
      setPhase('failed');
    }
  }, [cancelPreparedPlan, entryId, friendlyFailure, sessionId, t, workspaceId]);

  React.useEffect(() => {
    if (!open) return undefined;
    void prepare();
    return () => {
      generationRef.current += 1;
      const operationId = activePlanRef.current;
      activePlanRef.current = null;
      void cancelPreparedPlan(operationId);
    };
  }, [cancelPreparedPlan, open, prepare]);

  const close = React.useCallback(() => {
    if (phase === 'applying') return;
    onClose();
  }, [onClose, phase]);

  const runConversationOnly = React.useCallback(async () => {
    if (phase === 'applying' || applyInFlightRef.current) return;
    applyInFlightRef.current = true;
    generationRef.current += 1;
    setPhase('applying');
    const operationId = activePlanRef.current;
    activePlanRef.current = null;
    await cancelPreparedPlan(operationId);
    try {
      await onConversationOnly();
      onClose();
    } catch (error) {
      applyInFlightRef.current = false;
      setFailure(friendlyFailure(error));
      setPhase('failed');
    }
  }, [cancelPreparedPlan, friendlyFailure, onClose, onConversationOnly, phase]);

  const apply = React.useCallback(async (mode: WorkspaceRestoreMode) => {
    if (!plan || phase === 'applying' || applyInFlightRef.current) return;
    applyInFlightRef.current = true;
    startedPlansRef.current.add(plan.id);
    activePlanRef.current = null;
    setSelectedMode(mode);
    setFailure(null);
    setFailureCode(null);
    setPhase('applying');
    let polling = true;
    const poll = async () => {
      while (polling) {
        await new Promise((resolve) => setTimeout(resolve, 350));
        if (!polling) break;
        try {
          const result = requireWorkspaceRecoveryResult(
            await getWorkspaceRecoveryAPI().getCombinedOperation(plan.id),
          );
          setOperation(result.operation);
        } catch {
          // The authoritative apply result below owns failure reporting.
        }
      }
    };
    void poll();
    try {
      const result = requireWorkspaceRecoveryResult(await getWorkspaceRecoveryAPI().applyCombinedRecovery({
        expectedRevision: plan.revision,
        mode,
        ...(mode === 'new-workspace' ? { newWorkspacePath } : {}),
        operationId: plan.id,
      }));
      setOperation(result.operation);
      if (result.operation.state === 'complete' || result.operation.state === 'alternate-ready') {
        await onCombinedResult(result.operation);
        onClose();
        return;
      }
      const message = result.operation.failure?.message
        ?? t('chat.recoveryDialog.compensatedDescription');
      setFailure(friendlyFailure(message));
      setPhase('failed');
    } catch (error) {
      if (error instanceof WorkspaceRecoveryServiceError) {
        setFailureCode(error.failure.code);
        const current = await getWorkspaceRecoveryAPI().getCombinedOperation(plan.id).catch(() => null);
        if (current?.status === 'ready') setOperation(current.operation);
      }
      setFailure(friendlyFailure(error));
      setPhase('failed');
    } finally {
      polling = false;
      applyInFlightRef.current = false;
    }
  }, [friendlyFailure, newWorkspacePath, onClose, onCombinedResult, phase, plan, t]);

  const progress = operationProgress(operation);
  const conflicts = plan?.restore.conflicts ?? [];
  const applyingLabel = operation?.state
    ? t('chat.recoveryDialog.operationState', { state: operation.state })
    : t('chat.recoveryDialog.applying');
  const canRetry = !operation
    ? !['snapshot-incomplete', 'snapshot-missing', 'snapshot-unavailable'].includes(failureCode ?? '')
    : ['applying-workspace', 'workspace-verified', 'navigating-conversation'].includes(operation.state);
  const nonFatalFailure = ['snapshot-incomplete', 'snapshot-missing', 'snapshot-unavailable']
    .includes(failureCode ?? '');

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) close(); }}>
      <DialogContent showCloseButton={phase !== 'applying'} className="max-w-lg gap-5">
        <DialogHeader>
          <DialogTitle>{t('chat.recoveryDialog.title')}</DialogTitle>
          <DialogDescription>{t('chat.recoveryDialog.description')}</DialogDescription>
        </DialogHeader>

        {phase === 'preparing' ? (
          <div className="space-y-3">
            <div className="flex min-h-20 items-center justify-center gap-2 text-muted-foreground" aria-busy="true">
              <Icon name="loader-4" className="size-4 animate-spin" />
              <span className="typography-ui-label">{t('chat.recoveryDialog.preparing')}</span>
            </div>
            <button
              type="button"
              onClick={() => void runConversationOnly()}
              className="w-full rounded-xl border border-border px-3 py-3 text-left transition-colors hover:bg-interactive-hover/50"
            >
              <span className="block typography-ui-label font-medium text-foreground">
                {t('settings.piarium.recovery.preference.conversation.label')}
              </span>
              <span className="mt-1 block typography-meta text-muted-foreground">
                {t('settings.piarium.recovery.preference.conversation.description')}
              </span>
            </button>
          </div>
        ) : null}

        {phase === 'applying' && !plan ? (
          <div className="flex min-h-24 items-center justify-center gap-2 text-muted-foreground" aria-busy="true">
            <Icon name="loader-4" className="size-4 animate-spin" />
            <span className="typography-ui-label">{applyingLabel}</span>
          </div>
        ) : null}

        {plan && phase !== 'preparing' ? (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2 rounded-xl border border-border/60 bg-muted/20 p-3">
              <div>
                <p className="typography-micro text-muted-foreground">{t('chat.recoveryDialog.filesAffected')}</p>
                <p className="mt-1 typography-ui-label tabular-nums text-foreground">{plan.restore.operationCount}</p>
              </div>
              <div>
                <p className="typography-micro text-muted-foreground">{t('chat.recoveryDialog.dataSize')}</p>
                <p className="mt-1 typography-ui-label tabular-nums text-foreground">
                  {formatWorkspaceArchiveBytes(plan.restore.totalBytes)}
                </p>
              </div>
            </div>

            {plan.restore.operationCount === 0 ? (
              <div className="rounded-xl border border-[var(--status-success-border)] bg-[var(--status-success-background)] px-3 py-2 typography-meta text-[var(--status-success)]">
                {t('chat.recoveryDialog.noFileChanges')}
              </div>
            ) : null}

            {conflicts.length > 0 ? (
              <div className="rounded-xl border border-[var(--status-warning-border)] bg-[var(--status-warning-background)] p-3">
                <p className="typography-ui-label font-medium text-[var(--status-warning)]">
                  {t('chat.recoveryDialog.reviewRequired')}
                </p>
                <ul className="mt-2 space-y-1 typography-meta text-[var(--status-warning)]">
                  {conflicts.map((conflict, index) => (
                    <li key={`${conflict.code}:${conflict.path ?? index}`}>
                      {conflict.path ? `${conflict.path}: ` : ''}{conflict.message}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {phase === 'applying' ? (
              <div className="space-y-2 rounded-xl border border-border/60 p-3" aria-busy="true">
                <div className="flex items-center gap-2 typography-ui-label text-foreground">
                  <Icon name="loader-4" className="size-4 animate-spin" />
                  {applyingLabel}
                </div>
                {progress !== null ? (
                  <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-primary transition-[width] duration-300 ease-out"
                      style={{ width: `${progress}%` }}
                    />
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}

        {failure ? (
          <div className={cn(
            'rounded-xl border p-3 typography-meta',
            nonFatalFailure
              ? 'border-[var(--status-warning-border)] bg-[var(--status-warning-background)] text-[var(--status-warning)]'
              : 'border-[var(--status-error-border)] bg-[var(--status-error-background)] text-[var(--status-error)]',
          )}>
            {failure}
          </div>
        ) : null}

        {phase !== 'preparing' && phase !== 'applying' && !operation ? (
          <div className="grid gap-2">
            {plan?.allowedModes.includes('in-place') ? (
              <button
                type="button"
                aria-pressed={selectedMode === 'in-place'}
                onClick={() => setSelectedMode('in-place')}
                className={cn(
                  'rounded-xl border px-3 py-3 text-left transition-colors',
                  selectedMode === 'in-place'
                    ? 'border-primary/50 bg-primary/10 ring-1 ring-primary/20'
                    : 'border-border hover:bg-interactive-hover/50',
                )}
              >
                <span className="block typography-ui-label font-medium text-foreground">
                  {t('chat.recoveryDialog.inPlace')}
                </span>
                <span className="mt-1 block typography-meta text-muted-foreground">
                  {t('chat.recoveryDialog.inPlaceDescription')}
                </span>
              </button>
            ) : null}
            {plan?.allowedModes.includes('new-workspace') ? (
              <div className={cn(
                'rounded-xl border px-3 py-3 transition-colors',
                selectedMode === 'new-workspace'
                  ? 'border-primary/50 bg-primary/10 ring-1 ring-primary/20'
                  : 'border-border',
              )}>
                <button
                  type="button"
                  aria-pressed={selectedMode === 'new-workspace'}
                  onClick={() => setSelectedMode('new-workspace')}
                  className="w-full text-left"
                >
                  <span className="block typography-ui-label font-medium text-foreground">
                    {t('chat.recoveryDialog.newWorkspace')}
                  </span>
                  <span className="mt-1 block typography-meta text-muted-foreground">
                    {t('chat.recoveryDialog.newWorkspaceDescription')}
                  </span>
                </button>
                <Input
                  value={newWorkspacePath}
                  onChange={(event) => setNewWorkspacePath(event.target.value)}
                  aria-label={t('chat.recoveryDialog.destination')}
                  className="mt-3 font-mono typography-meta"
                />
              </div>
            ) : null}
            <button
              type="button"
              aria-pressed={selectedMode === null}
              onClick={() => {
                if (plan) setSelectedMode(null);
                else void runConversationOnly();
              }}
              className={cn(
                'rounded-xl border px-3 py-3 text-left transition-colors',
                selectedMode === null
                  ? 'border-primary/50 bg-primary/10 ring-1 ring-primary/20'
                  : 'border-border hover:bg-interactive-hover/50',
              )}
            >
              <span className="block typography-ui-label font-medium text-foreground">
                {t('settings.piarium.recovery.preference.conversation.label')}
              </span>
              <span className="mt-1 block typography-meta text-muted-foreground">
                {t('settings.piarium.recovery.preference.conversation.description')}
              </span>
            </button>
          </div>
        ) : null}

        <DialogFooter>
          {phase === 'failed' && canRetry ? (
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                if (plan && selectedMode && startedPlansRef.current.has(plan.id)) {
                  void apply(selectedMode);
                } else {
                  void prepare();
                }
              }}
            >
              {t('chat.recoveryDialog.retry')}
            </Button>
          ) : null}
          {phase === 'ready' && plan && !operation ? (
            <Button
              type="button"
              onClick={() => {
                if (selectedMode) void apply(selectedMode);
                else void runConversationOnly();
              }}
              disabled={selectedMode === 'new-workspace' && !newWorkspacePath.trim()}
            >
              {t('chat.recoveryDialog.confirmSelection')}
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
