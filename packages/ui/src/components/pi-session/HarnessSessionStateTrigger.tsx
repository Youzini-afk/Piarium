import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';

export const HarnessSessionStateTrigger: React.FC<{ count: number; onOpen: () => void }> = ({ count, onOpen }) => {
  const { t } = useI18n();
  return (
    <button
      type="button"
      onClick={onOpen}
      className="absolute right-2 top-2 z-20 flex h-8 items-center gap-1.5 rounded-full border border-border/70 bg-background/90 px-2.5 typography-micro text-muted-foreground shadow-sm backdrop-blur hover:bg-interactive-hover hover:text-foreground xl:hidden"
      aria-label={t('harness.context.open')}
      title={t('harness.context.open')}
    >
      <Icon name="brain" className="size-3.5" />
      <span className="tabular-nums">{count}</span>
    </button>
  );
};
