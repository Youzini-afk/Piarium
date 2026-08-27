import React from 'react';
import { BusyDots } from '@/components/chat/message/parts/BusyDots';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import type { PiAssistantWaitingPresentation } from './piAssistantWaiting';
import type { PiTimelineTurn } from './piTimelineProjection';

export const PiTurnAssistantChrome: React.FC<{
  waiting?: PiAssistantWaitingPresentation;
  footer?: boolean;
  turn: PiTimelineTurn;
}> = ({ footer = false, turn, waiting }) => {
  const { t } = useI18n();
  const assistants = turn.entries.flatMap((entry) => (
    entry.type === 'message' && entry.message.role === 'assistant' ? [entry.message] : []
  ));
  if (turn.liveAssistant) assistants.push(turn.liveAssistant);
  const last = assistants.at(-1);
  if (!last && !waiting) return null;
  const toolCount = assistants.reduce((count, message) => (
    count + message.content.filter((content) => content.type === 'toolCall').length
  ), 0);
  const tokens = assistants.reduce((count, message) => count + message.usage.totalTokens, 0);
  const working = waiting !== undefined || turn.liveAssistant?.stopReason === 'pending';

  if (footer) {
    if (toolCount === 0 && tokens === 0) return null;
    return (
      <footer className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-1 typography-micro text-muted-foreground/70">
        {toolCount > 0 ? (
          <span>{toolCount} {t('contextSidebar.breakdown.toolCalls')}</span>
        ) : null}
        {tokens > 0 ? <span>{t('chat.goal.usage.tokens', { used: new Intl.NumberFormat().format(tokens) })}</span> : null}
      </footer>
    );
  }

  const modelLabel = last
    ? `${last.provider}/${last.responseModel || last.model}`
    : waiting?.model
      ? `${waiting.model.provider}/${waiting.model.id}`
      : undefined;

  return (
    <header
      className="flex min-h-6 items-center gap-2 typography-meta text-muted-foreground"
      aria-live={working ? 'polite' : undefined}
      role={working ? 'status' : undefined}
    >
      <Icon name="ai-agent" className={cn('size-3.5 shrink-0', working && 'animate-pulse')} />
      <span className="font-medium text-foreground/85">Pi</span>
      {modelLabel ? <span className="truncate">{modelLabel}</span> : null}
      {working ? (
        <span className="min-w-0 truncate text-muted-foreground/80">
          · {t('chat.piAssistant.working')}<BusyDots />
        </span>
      ) : null}
    </header>
  );
};
