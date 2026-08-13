import React from 'react';
import { useDurationTickerNow } from '@/hooks/useDurationTicker';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { formatSessionActivityDuration } from './sessionActivityDurationFormat';

interface PiSessionActivityDurationProps {
  durationMs?: number;
  error?: boolean;
  startedAt?: number;
}

export const PiSessionActivityDuration: React.FC<PiSessionActivityDurationProps> = ({
  durationMs,
  error = false,
  startedAt,
}) => {
  const { t } = useI18n();
  const running = startedAt !== undefined;
  const now = useDurationTickerNow(running);
  const elapsed = running ? Math.max(0, now - startedAt) : durationMs;
  if (elapsed === undefined) return null;

  const label = formatSessionActivityDuration(elapsed, t);
  const description = running
    ? t('sessions.sidebar.session.status.activeFor', { duration: label })
    : t('sessions.sidebar.session.status.lastTurnDuration', { duration: label });

  return (
    <span
      className={cn(
        'shrink-0 tabular-nums typography-micro',
        running
          ? 'text-primary'
          : error
            ? 'text-[var(--status-error)]'
            : 'text-[var(--status-info)]',
      )}
      aria-label={description}
      title={description}
    >
      {label}
    </span>
  );
};
