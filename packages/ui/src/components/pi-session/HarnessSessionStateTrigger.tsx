import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';

export const HarnessSessionStateTrigger: React.FC<{
  count: number;
  attention?: boolean;
  onOpen: () => void;
}> = ({ count, attention = false, onOpen }) => {
  const { t } = useI18n();
  return (
    <button
      type="button"
      onClick={onOpen}
      className="absolute right-2 top-2 z-20 flex h-8 max-w-[min(70vw,16rem)] items-center gap-1.5 rounded-full border border-border/70 bg-background/90 px-2.5 typography-micro text-muted-foreground shadow-sm backdrop-blur hover:bg-interactive-hover hover:text-foreground xl:hidden"
      aria-label={t('harness.overview.open')}
      title={t('harness.overview.open')}
    >
      <Icon name="stack" className="size-3.5 shrink-0" />
      <span className="truncate">{t('harness.overview.title')}</span>
      {count > 0 ? (
        <span className={attention
          ? 'rounded-full bg-[var(--status-warning)]/15 px-1.5 py-0.5 tabular-nums text-[var(--status-warning)]'
          : 'rounded-full bg-muted/60 px-1.5 py-0.5 tabular-nums text-muted-foreground'}>
          {count}
        </span>
      ) : null}
    </button>
  );
};
