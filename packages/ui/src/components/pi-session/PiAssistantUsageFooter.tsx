import React from 'react';
import type { PiUsage } from '@piarium/protocol';
import { getCurrentIntlLocale, useI18n, type I18nKey } from '@/lib/i18n';
import {
  projectPiUsagePresentation,
  type PiUsageMetricKey,
} from '@/lib/pi-runtime/usagePresentation';

const LABEL_KEYS: Record<PiUsageMetricKey, I18nKey> = {
  cacheRead: 'contextSidebar.tokens.cacheRead',
  cacheWrite: 'contextSidebar.tokens.cacheWrite',
  cacheWrite1h: 'contextSidebar.tokens.cacheWrite1h',
  input: 'contextSidebar.tokens.input',
  output: 'contextSidebar.tokens.output',
  reasoning: 'contextSidebar.tokens.reasoning',
};

const formatNumber = (value: number): string => value.toLocaleString(getCurrentIntlLocale());

export const PiAssistantUsageFooter: React.FC<{ usage: PiUsage }> = ({ usage }) => {
  const { t } = useI18n();
  const presentation = projectPiUsagePresentation(usage, { includeZeroCacheMetrics: true });
  if (!presentation) return null;
  return (
    <footer
      className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 typography-micro text-muted-foreground/65"
      aria-label={t('chat.messageUsage.label')}
      data-pi-assistant-usage="true"
      data-pi-turn-usage="true"
    >
      <span className="font-medium text-muted-foreground/80">{t('chat.messageUsage.label')}</span>
      {presentation.metrics.map((metric) => (
        <React.Fragment key={metric.key}>
          <span aria-hidden="true">·</span>
          <span>{t(LABEL_KEYS[metric.key])} {formatNumber(metric.value)}</span>
        </React.Fragment>
      ))}
      {presentation.total !== undefined ? (
        <>
          <span aria-hidden="true">·</span>
          <span>{t('contextSidebar.tokens.total')} {formatNumber(presentation.total)}</span>
        </>
      ) : null}
    </footer>
  );
};
