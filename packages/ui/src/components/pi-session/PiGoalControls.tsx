import React from 'react';
import type { PiSessionGoalState, SessionSnapshot } from '@piarium/protocol';
import { Icon } from '@/components/icon/Icon';
import { toast } from '@/components/ui';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/lib/i18n';
import {
  sessionGoalStatusColor,
  sessionGoalStatusLabelKey,
} from '@/lib/sessionGoalPresentation';
import { cn } from '@/lib/utils';
import { usePiSessionStore } from '@/stores/usePiSessionStore';
import { useSessionGoalArmStore } from '@/stores/useSessionGoalArmStore';
import { useUIStore } from '@/stores/useUIStore';

const formatTokens = (count: number): string => {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 10_000) return `${Math.round(count / 1000)}K`;
  if (count >= 1_000) return `${(count / 1000).toFixed(1)}K`;
  return String(count);
};

const useGoalMutation = (snapshot: SessionSnapshot) => {
  const mutateFeatures = usePiSessionStore((state) => state.mutateFeatures);
  return React.useCallback(async (
    mutation: Parameters<typeof mutateFeatures>[1],
  ) => {
    try {
      await mutateFeatures(snapshot.sessionId, mutation);
      return true;
    } catch (error) {
      console.warn('[pi-session-goal] update failed:', error);
      return false;
    }
  }, [mutateFeatures, snapshot.sessionId]);
};

const PiGoalDialog: React.FC<{
  goal: PiSessionGoalState;
  onOpenChange(open: boolean): void;
  open: boolean;
  snapshot: SessionSnapshot;
}> = ({ goal, onOpenChange, open, snapshot }) => {
  const { t } = useI18n();
  const mutate = useGoalMutation(snapshot);
  const abort = usePiSessionStore((state) => state.abort);
  const [busy, setBusy] = React.useState(false);

  const run = React.useCallback(async (action: () => Promise<boolean>) => {
    if (busy) return;
    setBusy(true);
    const succeeded = await action();
    if (!succeeded) toast.error(t('chat.goal.toast.actionFailed'));
    setBusy(false);
    if (succeeded) onOpenChange(false);
  }, [busy, onOpenChange, t]);

  const pause = async (): Promise<boolean> => {
    if (snapshot.busy) {
      try {
        await abort(snapshot.sessionId);
        return true;
      } catch {
        return false;
      }
    }
    return mutate({ goalId: goal.id, status: 'paused', statusReason: 'paused by user', type: 'goal.update' });
  };

  const resumable = goal.status === 'paused' || goal.status === 'blocked' || goal.status === 'budgetLimited';
  const usage = goal.tokenBudget === undefined
    ? t('chat.goal.usage.tokens', { used: formatTokens(goal.tokensUsed) })
    : t('chat.goal.usage.tokensWithBudget', {
        budget: formatTokens(goal.tokenBudget),
        used: formatTokens(goal.tokensUsed),
      });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg gap-5">
        <DialogHeader>
          <DialogTitle>{t('chat.goal.dialog.titleManage')}</DialogTitle>
          <DialogDescription>
            {t(sessionGoalStatusLabelKey[goal.status] as never)} · {usage} · {t('chat.goal.usage.turns', { turns: goal.turnsUsed })}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <div className="mb-1 typography-meta font-medium text-muted-foreground">
              {t('chat.goal.dialog.objectiveLabel')}
            </div>
            <div className="max-h-64 overflow-y-auto whitespace-pre-wrap rounded-lg border border-border bg-muted/20 px-3 py-2 typography-ui-label text-foreground">
              {goal.objective}
            </div>
          </div>
          {(goal.note || goal.statusReason) && (
            <div className="rounded-lg bg-muted/30 px-3 py-2 typography-meta text-muted-foreground">
              {goal.note || goal.statusReason}
            </div>
          )}
          {(goal.evaluationProvider || goal.evaluationModel) && (
            <div className="typography-micro text-muted-foreground">
              {t('chat.goal.dialog.evaluationModelLabel')}: {[goal.evaluationProvider, goal.evaluationModel].filter(Boolean).join('/')}
            </div>
          )}
        </div>
        <DialogFooter className="flex-wrap sm:justify-between">
          <button
            type="button"
            disabled={busy}
            onClick={() => void run(() => mutate({ goalId: goal.id, type: 'goal.clear' }))}
            className="inline-flex h-8 items-center justify-center rounded-md border border-[var(--status-error)]/30 px-3 typography-ui-label text-[var(--status-error)] hover:bg-[var(--status-error)]/10 disabled:opacity-50"
          >
            {t('chat.goal.action.clear')}
          </button>
          <div className="flex flex-wrap justify-end gap-2">
            {goal.status === 'active' && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void run(pause)}
                className="inline-flex h-8 items-center justify-center rounded-md border border-border px-3 typography-ui-label text-foreground hover:bg-interactive-hover disabled:opacity-50"
              >
                {t('chat.goal.action.pause')}
              </button>
            )}
            {resumable && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void run(() => mutate({ goalId: goal.id, status: 'active', type: 'goal.update' }))}
                className="inline-flex h-8 items-center justify-center rounded-md border border-border px-3 typography-ui-label text-foreground hover:bg-interactive-hover disabled:opacity-50"
              >
                {t('chat.goal.action.resume')}
              </button>
            )}
            {goal.status !== 'complete' && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void run(() => mutate({
                  goalId: goal.id,
                  status: 'complete',
                  statusReason: 'marked complete by user',
                  type: 'goal.update',
                }))}
                className="inline-flex h-8 items-center justify-center rounded-md bg-primary px-3 typography-ui-label text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                {t('chat.goal.action.markComplete')}
              </button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export const PiGoalButton: React.FC<{
  footerIconButtonClass: string;
  snapshot: SessionSnapshot;
}> = ({ footerIconButtonClass, snapshot }) => {
  const { t } = useI18n();
  const enabled = useUIStore((state) => state.sessionGoalEnabled);
  const armed = useSessionGoalArmStore((state) => state.armed);
  const setArmed = useSessionGoalArmStore((state) => state.setArmed);
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const goal = snapshot.features.goal;
  if (!enabled) return null;

  const label = goal
    ? t('chat.goal.button.manageAria')
    : armed
      ? t('chat.goal.button.disarmAria')
      : t('chat.goal.button.armAria');
  const engaged = armed || goal !== undefined;
  const color = goal?.status === 'complete'
    ? 'text-[var(--status-success)]'
    : goal?.status === 'blocked' || goal?.status === 'budgetLimited'
      ? 'text-[var(--status-warning)]'
      : engaged
        ? 'text-[var(--status-info)]'
        : '';

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={label}
            aria-pressed={engaged}
            className={cn(footerIconButtonClass, color)}
            onMouseDown={(event) => { if (!goal) event.preventDefault(); }}
            onClick={() => {
              if (goal) setDialogOpen(true);
              else setArmed(!armed);
            }}
          >
            <Icon name={engaged ? 'target-fill' : 'target'} className="size-4" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="top">{label}</TooltipContent>
      </Tooltip>
      {goal && (
        <PiGoalDialog
          goal={goal}
          onOpenChange={setDialogOpen}
          open={dialogOpen}
          snapshot={snapshot}
        />
      )}
    </>
  );
};

export const PiGoalStrip: React.FC<{ snapshot: SessionSnapshot }> = ({ snapshot }) => {
  const { t } = useI18n();
  const goal = snapshot.features.goal;
  const mutate = useGoalMutation(snapshot);
  const abort = usePiSessionStore((state) => state.abort);
  const [busy, setBusy] = React.useState(false);
  if (!goal) return null;

  const pauseOrResume = goal.status === 'active'
    ? { icon: 'pause' as const, label: t('chat.goal.action.pause'), status: 'paused' as const }
    : goal.status === 'paused' || goal.status === 'blocked' || goal.status === 'budgetLimited'
      ? { icon: 'play' as const, label: t('chat.goal.action.resume'), status: 'active' as const }
      : null;
  const usage = goal.tokenBudget === undefined
    ? (goal.tokensUsed > 0 ? formatTokens(goal.tokensUsed) : null)
    : `${formatTokens(goal.tokensUsed)}/${formatTokens(goal.tokenBudget)}`;

  const toggle = async () => {
    if (!pauseOrResume || busy) return;
    setBusy(true);
    try {
      if (pauseOrResume.status === 'paused' && snapshot.busy) {
        await abort(snapshot.sessionId);
      } else {
        await mutate({
          goalId: goal.id,
          status: pauseOrResume.status,
          ...(pauseOrResume.status === 'paused' ? { statusReason: 'paused by user' } : {}),
          type: 'goal.update',
        });
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto mb-2 flex w-full max-w-4xl min-w-0 items-center gap-2 rounded-lg border border-border/70 bg-muted/15 px-3 py-2">
      <Icon name="target" className="size-3.5 shrink-0" style={{ color: sessionGoalStatusColor[goal.status] }} />
      <span className="min-w-0 flex-1 truncate typography-meta text-foreground" title={goal.objective}>
        {goal.note || goal.objective}
      </span>
      {goal.status === 'active' && !snapshot.busy ? (
        <span className="flex shrink-0 items-center gap-1 typography-meta text-muted-foreground">
          <Icon name="loader-4" className="size-3 animate-spin" />
          {t('chat.goal.status.evaluating')}
        </span>
      ) : (
        <span className="shrink-0 typography-meta text-muted-foreground">
          {t(sessionGoalStatusLabelKey[goal.status] as never)}
        </span>
      )}
      {usage && <span className="shrink-0 typography-micro tabular-nums text-muted-foreground">{usage}</span>}
      {pauseOrResume && (
        <button
          type="button"
          disabled={busy}
          onClick={() => void toggle()}
          className="flex shrink-0 items-center gap-1 rounded px-1.5 py-1 typography-meta text-muted-foreground hover:bg-interactive-hover hover:text-foreground disabled:opacity-50"
        >
          <Icon name={pauseOrResume.icon} className="size-3" />
          {pauseOrResume.label}
        </button>
      )}
    </div>
  );
};
