import React from 'react';
import type { ThinkingLevel } from '@piarium/protocol';
import { PiAgentSelector } from '@/components/multirun/PiAgentSelector';
import { ModelSelector } from '@/components/sections/agents/ModelSelector';
import { ThinkingPill } from '@/components/session/ThinkingPill';
import { Checkbox } from '@/components/ui/checkbox';
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
import { usePiProviderStore } from '@/stores/usePiProviderStore';
import { usePiSessionStore } from '@/stores/usePiSessionStore';
import type { MultiRunAgentSelection } from '@/types/multirun';

export type ReviewFlowExecution = {
  agent: MultiRunAgentSelection | null;
  autoReview: boolean;
  generateHandoff: boolean;
  modelId: string;
  providerId: string;
  thinkingLevel: ThinkingLevel;
};

type ReviewFlowDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  originalSessionId?: string | null;
  projectDirectory: string | null;
  submitting?: boolean;
  onConfirm: (execution: ReviewFlowExecution) => Promise<void> | void;
};

const initialExecution = (
  providerId = '',
  modelId = '',
  thinkingLevel: ThinkingLevel = 'off',
): ReviewFlowExecution => ({
  agent: null,
  autoReview: false,
  generateHandoff: true,
  modelId,
  providerId,
  thinkingLevel,
});

export function ReviewFlowDialog({
  open,
  onOpenChange,
  originalSessionId,
  projectDirectory,
  submitting = false,
  onConfirm,
}: ReviewFlowDialogProps) {
  const { t } = useI18n();
  const activeSessionId = usePiSessionStore((state) => originalSessionId ?? state.currentSessionId);
  const sourceSnapshot = usePiSessionStore((state) => (
    activeSessionId ? state.records[activeSessionId]?.snapshot : undefined
  ));
  const providers = usePiProviderStore((state) => state.providers);
  const loadProviders = usePiProviderStore((state) => state.load);
  const [execution, setExecution] = React.useState<ReviewFlowExecution>(() => initialExecution());

  React.useEffect(() => {
    if (!open) return;
    const cwd = projectDirectory?.trim() || sourceSnapshot?.cwd.trim();
    if (cwd) void loadProviders(cwd).catch(() => undefined);
  }, [loadProviders, open, projectDirectory, sourceSnapshot?.cwd]);

  React.useEffect(() => {
    if (!open) return;
    setExecution(initialExecution(
      sourceSnapshot?.model?.provider,
      sourceSnapshot?.model?.id,
      sourceSnapshot?.thinkingLevel ?? 'off',
    ));
  }, [open, sourceSnapshot?.model?.id, sourceSnapshot?.model?.provider, sourceSnapshot?.thinkingLevel]);

  React.useEffect(() => {
    if (!open || providers.length === 0) return;
    const provider = providers.find((item) => item.id === execution.providerId) ?? providers[0];
    const model = provider?.models.find((item) => item.id === execution.modelId)
      ?? provider?.models.find((item) => item.available)
      ?? provider?.models[0];
    if (!provider || !model) return;
    const thinkingLevel = model.supportedThinkingLevels.includes(execution.thinkingLevel)
      ? execution.thinkingLevel
      : model.supportedThinkingLevels[0] ?? 'off';
    if (
      provider.id === execution.providerId
      && model.id === execution.modelId
      && thinkingLevel === execution.thinkingLevel
    ) return;
    setExecution((current) => ({
      ...current,
      modelId: model.id,
      providerId: provider.id,
      thinkingLevel,
    }));
  }, [execution.modelId, execution.providerId, execution.thinkingLevel, open, providers]);

  const thinkingOptions = React.useMemo(() => (
    providers
      .find((provider) => provider.id === execution.providerId)
      ?.models.find((model) => model.id === execution.modelId)
      ?.supportedThinkingLevels ?? []
  ), [execution.modelId, execution.providerId, providers]);
  const canConfirm = execution.providerId.trim().length > 0 && execution.modelId.trim().length > 0;

  const handleSubmit = React.useCallback(() => {
    if (!canConfirm || submitting) return;
    void onConfirm(execution);
  }, [canConfirm, execution, onConfirm, submitting]);

  React.useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault();
        handleSubmit();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleSubmit, open]);

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => { if (!submitting) onOpenChange(nextOpen); }}>
      <DialogContent className="max-w-md overflow-visible">
        <DialogHeader>
          <DialogTitle>{t('diffView.reviewDialog.title')}</DialogTitle>
          <DialogDescription>{t('diffView.reviewDialog.description')}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="rounded-md border border-[color:color-mix(in_srgb,var(--status-info)_35%,var(--interactive-border))] bg-[color:color-mix(in_srgb,var(--status-info)_10%,var(--surface-background))] px-3 py-2 typography-meta text-foreground">
            {t('diffView.reviewDialog.info')}
          </div>

          <label className="flex items-center gap-2 typography-ui-label text-foreground">
            <Checkbox
              checked={execution.generateHandoff}
              onChange={(generateHandoff) => setExecution((current) => ({ ...current, generateHandoff }))}
              disabled={submitting}
              ariaLabel={t('diffView.reviewDialog.generateHandoff')}
            />
            <span>{t('diffView.reviewDialog.generateHandoff')}</span>
          </label>

          <label className="flex items-center gap-2 typography-ui-label text-foreground">
            <Checkbox
              checked={execution.autoReview}
              onChange={(autoReview) => setExecution((current) => ({ ...current, autoReview }))}
              disabled={submitting}
              ariaLabel={t('diffView.reviewDialog.autoReview')}
            />
            <span>{t('diffView.reviewDialog.autoReview')}</span>
          </label>

          <div className="flex min-w-0 flex-col gap-1.5">
            <span className="typography-meta font-medium text-muted-foreground">{t('chat.modelControls.model')}</span>
            <ModelSelector
              providerId={execution.providerId}
              modelId={execution.modelId}
              className="max-w-[320px] justify-between"
              dropdownPortalToBody
              onChange={(providerId, modelId) => {
                const model = providers
                  .find((provider) => provider.id === providerId)
                  ?.models.find((entry) => entry.id === modelId);
                setExecution((current) => ({
                  ...current,
                  modelId,
                  providerId,
                  thinkingLevel: model?.supportedThinkingLevels.includes(current.thinkingLevel)
                    ? current.thinkingLevel
                    : model?.supportedThinkingLevels[0] ?? 'off',
                }));
              }}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="typography-meta font-medium text-muted-foreground">{t('sessions.scheduledTasks.editor.thinkingLevel.label')}</span>
            <ThinkingPill
              value={execution.thinkingLevel}
              options={thinkingOptions}
              disabled={thinkingOptions.length === 0 || submitting}
              onChange={(thinkingLevel) => setExecution((current) => ({
                ...current,
                thinkingLevel: thinkingLevel as ThinkingLevel,
              }))}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="typography-meta font-medium text-muted-foreground">{t('sessions.scheduledTasks.editor.agent.label')}</span>
            <PiAgentSelector
              cwd={projectDirectory}
              value={execution.agent}
              disabled={submitting}
              portalToBody
              onChange={(agent) => setExecution((current) => ({ ...current, agent }))}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)} disabled={submitting}>
            {t('diffView.reviewDialog.actions.cancel')}
          </Button>
          <Button size="sm" onClick={handleSubmit} disabled={!canConfirm || submitting}>
            {submitting ? t('diffView.reviewDialog.actions.starting') : t('diffView.reviewDialog.actions.start')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
