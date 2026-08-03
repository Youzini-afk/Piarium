import React from 'react';
import type { PiSessionEntry, SessionSnapshot } from '@piarium/protocol';
import { Icon } from '@/components/icon/Icon';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/lib/i18n';
import { usePiSessionStore } from '@/stores/usePiSessionStore';
import { useUIStore } from '@/stores/useUIStore';

const latestAssistantEntryId = (entries: PiSessionEntry[]): string | null => {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type !== 'message') continue;
    if (entry.message.role === 'user') return null;
    if (entry.message.role === 'assistant') return entry.id;
  }
  return null;
};

export const PiAssistBar: React.FC<{
  draftEmpty: boolean;
  entries: PiSessionEntry[];
  onApplySuggestion(value: string): void;
  snapshot: SessionSnapshot;
}> = ({ draftEmpty, entries, onApplySuggestion, snapshot }) => {
  const { t } = useI18n();
  const recapEnabled = useUIStore((state) => state.sessionRecapEnabled);
  const suggestionEnabled = useUIStore((state) => state.sessionSuggestionEnabled);
  const mutateFeatures = usePiSessionStore((state) => state.mutateFeatures);
  const [dismissing, setDismissing] = React.useState(false);
  const assist = snapshot.features.assist;
  const fresh = assist
    && !snapshot.busy
    && latestAssistantEntryId(entries) === assist.forEntryId
    ? assist
    : undefined;
  const recap = recapEnabled ? fresh?.recap : undefined;
  const suggestion = suggestionEnabled && draftEmpty ? fresh?.suggestion : undefined;
  if (!recap && !suggestion) return null;

  const dismissSuggestion = async (event: React.MouseEvent) => {
    event.stopPropagation();
    if (!fresh || dismissing) return;
    setDismissing(true);
    try {
      await mutateFeatures(snapshot.sessionId, {
        field: 'suggestion',
        forEntryId: fresh.forEntryId,
        type: 'assist.clear',
      });
    } finally {
      setDismissing(false);
    }
  };

  return (
    <div className="mx-auto mb-2 w-full max-w-4xl space-y-2 px-3 sm:px-5">
      {recap && (
        <div aria-label={t('chat.recap.aria')} className="px-1 typography-meta text-muted-foreground/75">
          <span className="italic text-muted-foreground/50">{t('chat.recap.label')} </span>
          <span className="line-clamp-3">{recap}</span>
        </div>
      )}
      {suggestion && (
        <div className="relative">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => onApplySuggestion(suggestion)}
                onMouseDown={(event) => event.preventDefault()}
                aria-label={t('chat.suggestion.applyAria')}
                className="group flex w-full min-w-0 items-center gap-1.5 rounded-full border border-border bg-muted/15 py-1.5 pl-3 pr-8 typography-meta text-muted-foreground hover:bg-interactive-hover hover:text-foreground"
              >
                <Icon name="pencil-ai-2" className="size-3.5 shrink-0 opacity-70 group-hover:opacity-100" />
                <span className="truncate">{suggestion}</span>
              </button>
            </TooltipTrigger>
            <TooltipContent className="max-w-sm whitespace-pre-wrap">{suggestion}</TooltipContent>
          </Tooltip>
          <button
            type="button"
            disabled={dismissing}
            onClick={(event) => void dismissSuggestion(event)}
            onMouseDown={(event) => event.preventDefault()}
            aria-label={t('chat.suggestion.dismissAria')}
            className="absolute right-1.5 top-1/2 flex size-5 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground/60 hover:bg-interactive-hover hover:text-foreground disabled:opacity-50"
          >
            <Icon name={dismissing ? 'loader-4' : 'close'} className={dismissing ? 'size-3 animate-spin' : 'size-3'} />
          </button>
        </div>
      )}
    </div>
  );
};
